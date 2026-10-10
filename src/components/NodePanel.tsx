import { useEffect, useMemo, useRef, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { ICONS } from '../data/icons'
import type { Attachment, NodeImage, NodeLink, NodeTag } from '../types'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import { getBlob, saveBlob } from '../store/db'
import { getBlobURL, revokeBlobURL } from '../lib/blobUrl'
import { getTheme } from '../lib/theme'
import NoteEditor from './NoteEditor'

/** 分支色键：'' 跟随布局自动配色；'b0'..'b5' 钉住主题分支色 */
type BranchKey = '' | 'b0' | 'b1' | 'b2' | 'b3' | 'b4' | 'b5'

/** 6 个分支色键（与 theme.branch 数组、layout 轮转一致） */
const BRANCH_KEYS: BranchKey[] = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']

/** M11：分支色取色器（单选节点 + 多选批量共用） */
function BranchColorPicker({ value, onPick }: { value: BranchKey; onPick: (c: BranchKey) => void }) {
  const dark = useSettings((s) => s.dark)
  const colors = getTheme(dark).branch
  return (
    <div className="msz-np-color-picker" role="group" aria-label="分支颜色">
      {BRANCH_KEYS.map((k, i) => (
        <button
          key={k}
          className={'msz-np-color-btn branch' + (value === k ? ' active' : '')}
          style={{ background: colors[i] }}
          onClick={() => onPick(k)}
          title={`分支色 ${i + 1}`}
          aria-label={`分支色 ${i + 1}`}
          aria-pressed={value === k}
        />
      ))}
      <button
        className={'msz-np-color-btn branch default' + (value === '' ? ' active' : '')}
        onClick={() => onPick('')}
        title="默认（跟随布局自动配色）"
        aria-label="默认颜色"
        aria-pressed={value === ''}
      >
        默
      </button>
    </div>
  )
}

/**
 * M11（PRD 4.4 P1）：多选（≥2）时的批量操作面板。
 * 仅暴露 PRD 要求的两件事：批量改分支色、批量加标签；一次快照、可整体撤销。
 */
function BatchPanel({ ids }: { ids: string[] }) {
  const batchColor = useDoc((s) => s.batchColor)
  const batchAddTag = useDoc((s) => s.batchAddTag)
  const [tagInput, setTagInput] = useState('')
  const [tagColor, setTagColor] = useState('blue')

  const addTag = () => {
    const t = tagInput.trim()
    if (!t) return
    batchAddTag(ids, t, tagColor)
    setTagInput('')
  }

  return (
    <div className="msz-node-panel">
      <div className="msz-np-header">
        <span>批量操作</span>
        <span className="msz-np-node-id">已选 {ids.length} 个节点</span>
      </div>

      <div className="msz-np-section">
        <div className="msz-np-label">分支颜色</div>
        <div className="msz-np-batch-hint">统一覆盖所选节点的分支配色（含其下游连线）</div>
        <BranchColorPicker value="" onPick={(c) => batchColor(ids, c)} />
      </div>

      <div className="msz-np-section">
        <div className="msz-np-label">批量加标签</div>
        <div className="msz-np-batch-hint">同文本标签在同一节点上不会重复添加</div>
        <div className="msz-np-tag-add">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
            }}
            placeholder="标签文本…"
            maxLength={20}
            className="msz-np-input"
          />
          <div className="msz-np-color-picker">
            {TAG_COLOR_OPTIONS.map((c) => (
              <button
                key={c.key}
                className={`msz-np-color-btn ${tagColor === c.key ? 'active' : ''}`}
                style={{ background: c.hex }}
                onClick={() => setTagColor(c.key)}
                title={c.label}
                aria-label={`标签颜色：${c.label}`}
              />
            ))}
          </div>
          <button className="msz-np-add-btn" onClick={addTag} disabled={!tagInput.trim()}>
            全部添加
          </button>
        </div>
      </div>
    </div>
  )
}

/** 标签色板选项 */
const TAG_COLOR_OPTIONS = [
  { key: 'red', label: '红', hex: '#e53935' },
  { key: 'orange', label: '橙', hex: '#fb8c00' },
  { key: 'amber', label: '黄', hex: '#fdd835' },
  { key: 'green', label: '绿', hex: '#43a047' },
  { key: 'teal', label: '青', hex: '#00897b' },
  { key: 'blue', label: '蓝', hex: '#1e88e5' },
  { key: 'violet', label: '紫', hex: '#8e24aa' },
  { key: 'gray', label: '灰', hex: '#9e9e9e' },
]

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * M7-P1 节点富内容编辑面板。
 * 当恰好选中一个节点时在侧边栏底部展开，提供标签与图标编辑。
 * P2 追加链接与备注分区；P3 将追加图片/附件。
 */
export default function NodePanel() {
  const selection = useDoc((s) => s.selection)
  const doc = useDoc((s) => s.doc)
  const setNode = useDoc((s) => s.setNode)
  const [tagInput, setTagInput] = useState('')
  const [tagColor, setTagColor] = useState('blue')
  const [linkUrl, setLinkUrl] = useState('')
  const [linkNode, setLinkNode] = useState('')
  const [linkMode, setLinkMode] = useState<'url' | 'node'>('url')
  const imgInputRef = useRef<HTMLInputElement>(null)
  const attInputRef = useRef<HTMLInputElement>(null)

  const selId = selection.length === 1 ? selection[0] : null
  const node = selId ? doc.nodes[selId] : null

  // 备注富文本初值：优先 richNote.html；其次纯 note 串转义为段落
  // 修审计 M-7：依赖补全为 node 整体（节点不可变更新，他节点编辑不会变 ref，安全）
  const richHtml = useMemo(() => {
    if (!node) return ''
    if (node.richNote?.html) return node.richNote.html
    if (node.note) return sanitizeHtml(`<p>${escapeHtml(node.note).replace(/\n/g, '<br>')}</p>`)
    return ''
  }, [node])

  // 候选内部节点：去掉自己，按 text 字母排序
  const nodeOptions = useMemo(() => {
    if (!selId) return []
    const list: { id: string; text: string }[] = []
    for (const n of Object.values(doc.nodes)) {
      if (n.id === selId) continue
      list.push({ id: n.id, text: n.text || '(未命名)' })
    }
    list.sort((a, b) => a.text.localeCompare(b.text, 'zh'))
    return list.slice(0, 200)
  }, [doc.nodes, selId])

  // M11：多选（≥2）走批量操作面板
  if (selection.length >= 2) return <BatchPanel ids={selection} />

  if (!selId || !node) return null
  const selectedId = selId
  const selectedNode = node

  const tags = node.tags ?? []
  const icons = node.icons ?? []
  const links = node.links ?? []
  const images = node.images ?? []
  const attachments = node.attachments ?? []

  function addTag() {
    const text = tagInput.trim()
    if (!text) return
    const tag: NodeTag = { id: genId(), text, color: tagColor }
    setNode(selectedId, { tags: [...(selectedNode.tags ?? []), tag] })
    setTagInput('')
  }

  function removeTag(id: string) {
    setNode(selectedId, { tags: tags.filter((t) => t.id !== id) })
  }

  function toggleIcon(iconId: string) {
    const has = icons.includes(iconId)
    setNode(selectedId, {
      icons: has ? icons.filter((i) => i !== iconId) : [...icons, iconId],
    })
  }

  function addLink() {
    if (linkMode === 'url') {
      const u = linkUrl.trim()
      if (!/^https?:\/\//i.test(u)) {
        window.alert('链接必须以 http:// 或 https:// 开头')
        return
      }
      const link: NodeLink = { id: genId(), kind: 'url', url: u }
      setNode(selectedId, { links: [...links, link] })
      setLinkUrl('')
    } else {
      const nid = linkNode
      if (!nid || !doc.nodes[nid] || nid === selId) {
        window.alert('请选择一个目标节点')
        return
      }
      const link: NodeLink = { id: genId(), kind: 'node', nodeId: nid }
      setNode(selectedId, { links: [...links, link] })
      setLinkNode('')
    }
  }

  function removeLink(id: string) {
    setNode(selectedId, { links: links.filter((l) => l.id !== id) })
  }

  function gotoLink(l: NodeLink) {
    if (l.kind === 'url' && l.url) {
      window.open(l.url, '_blank', 'noopener,noreferrer')
      return
    }
    if (l.kind === 'node' && l.nodeId) {
      // 选中目标节点并触发居中（Canvas 已监听 msz:center）
      useDoc.getState().select([l.nodeId])
      window.dispatchEvent(new CustomEvent('msz:center', { detail: l.nodeId }))
    }
  }

  function setRichNote(html: string) {
    setNode(selectedId, { richNote: { html } })
  }

  /* ---- M7-P3：图片方法 ---- */
  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !selId) return
    try {
      const blobId = await saveBlob(selId, file)
      const url = URL.createObjectURL(file)
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('图片解码失败'))
        img.src = url
      })
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      URL.revokeObjectURL(url)
      setNode(selId, { images: [...images, { id: genId(), blobId, w, h }] })
    } catch (err) {
      window.alert('图片上传失败：' + (err as Error).message)
    }
    e.target.value = ''
  }

  function removeImage(id: string) {
    const im = images.find((i) => i.id === id)
    if (im) revokeBlobURL(im.blobId)
    setNode(selectedId, { images: images.filter((i) => i.id !== id) })
  }

  /* ---- M7-P3：附件方法 ---- */
  async function onPickAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !selId) return
    try {
      const blobId = await saveBlob(selId, file)
      setNode(selId, {
        attachments: [
          ...attachments,
          { id: genId(), blobId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' },
        ],
      })
    } catch (err) {
      window.alert('附件上传失败：' + (err as Error).message)
    }
    e.target.value = ''
  }

  function removeAttachment(id: string) {
    const at = attachments.find((a) => a.id === id)
    if (at) revokeBlobURL(at.blobId)
    setNode(selectedId, { attachments: attachments.filter((a) => a.id !== id) })
  }

  async function previewAttachment(att: Attachment) {
    try {
      const url = await getBlobURL(att.blobId)
      window.open(url)
    } catch {
      window.alert('附件预览失败')
    }
  }

  async function downloadAttachment(att: Attachment) {
    const blob = await getBlob(att.blobId)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = att.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  function fmtSize(n: number): string {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  return (
    <div className="msz-node-panel">
      <div className="msz-np-header">
        <span>节点内容</span>
        <span className="msz-np-node-id" title={selId}>
          {node.text?.slice(0, 12) || '未命名'}
        </span>
      </div>

      {/* M11 分支颜色（单选节点） */}
      <div className="msz-np-section">
        <div className="msz-np-label">分支颜色</div>
        <BranchColorPicker
          // 历史/导入数据可能带其他 color 串，非法值一律视为「默认」
          value={BRANCH_KEYS.includes(node.color as BranchKey) ? (node.color as BranchKey) : ''}
          onPick={(c) => setNode(selId, { color: c || undefined })}
        />
      </div>

      {/* 标签区 */}
      <div className="msz-np-section">
        <div className="msz-np-label">标签</div>
        <div className="msz-np-tags">
          {tags.map((t) => {
            const opt = TAG_COLOR_OPTIONS.find((c) => c.key === t.color)
            return (
              <span
                key={t.id}
                className="msz-np-tag"
                style={{ borderColor: opt?.hex ?? '#9e9e9e' }}
              >
                <span className="msz-np-tag-dot" style={{ background: opt?.hex ?? '#9e9e9e' }} />
                {t.text}
                <button
                  className="msz-np-tag-x"
                  onClick={() => removeTag(t.id)}
                  aria-label={`删除标签 ${t.text}`}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
        <div className="msz-np-tag-add">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
            }}
            placeholder="标签文本…"
            maxLength={20}
            className="msz-np-input"
          />
          <div className="msz-np-color-picker">
            {TAG_COLOR_OPTIONS.map((c) => (
              <button
                key={c.key}
                className={`msz-np-color-btn ${tagColor === c.key ? 'active' : ''}`}
                style={{ background: c.hex }}
                onClick={() => setTagColor(c.key)}
                title={c.label}
                aria-label={`标签颜色：${c.label}`}
              />
            ))}
          </div>
          <button className="msz-np-add-btn" onClick={addTag} disabled={!tagInput.trim()}>
            添加
          </button>
        </div>
      </div>

      {/* 图标区 */}
      <div className="msz-np-section">
        <div className="msz-np-label">图标</div>
        <div className="msz-np-icon-grid">
          {ICONS.map((icon) => {
            const active = icons.includes(icon.id)
            return (
              <button
                key={icon.id}
                className={`msz-np-icon-btn ${active ? 'active' : ''}`}
                onClick={() => toggleIcon(icon.id)}
                title={icon.label}
                aria-label={`图标：${icon.label}`}
              >
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path
                    d={icon.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )
          })}
        </div>
      </div>

      {/* 链接区（M7-P2） */}
      <div className="msz-np-section">
        <div className="msz-np-label">链接</div>
        <div className="msz-np-links">
          {links.map((l) => {
            const label =
              l.kind === 'url'
                ? (l.url ?? '(空)')
                : `节点：${doc.nodes[l.nodeId ?? '']?.text ?? '(已删除)'}`.slice(0, 40)
            const dead = l.kind === 'node' && !doc.nodes[l.nodeId ?? '']
            return (
              <span key={l.id} className={`msz-np-link ${dead ? 'dead' : ''}`}>
                <button
                  className="msz-np-link-go"
                  onClick={() => gotoLink(l)}
                  disabled={dead}
                  title={dead ? '目标节点已删除' : '跳转'}
                >
                  {l.kind === 'url' ? '🔗' : '➜'} {label}
                </button>
                <button
                  className="msz-np-tag-x"
                  onClick={() => removeLink(l.id)}
                  aria-label="删除链接"
                >
                  ×
                </button>
              </span>
            )
          })}
          {!links.length && <div className="msz-np-empty">暂无链接</div>}
        </div>
        <div className="msz-np-link-mode">
          <button
            className={`msz-np-tab ${linkMode === 'url' ? 'active' : ''}`}
            onClick={() => setLinkMode('url')}
            role="tab"
            aria-selected={linkMode === 'url'}
          >
            外部 URL
          </button>
          <button
            className={`msz-np-tab ${linkMode === 'node' ? 'active' : ''}`}
            onClick={() => setLinkMode('node')}
            role="tab"
            aria-selected={linkMode === 'node'}
          >
            内部节点
          </button>
        </div>
        {linkMode === 'url' ? (
          <div className="msz-np-link-add">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addLink()
                }
              }}
              placeholder="https://…"
              className="msz-np-input"
            />
            <button className="msz-np-add-btn" onClick={addLink} disabled={!linkUrl.trim()}>
              添加
            </button>
          </div>
        ) : (
          <div className="msz-np-link-add">
            <select
              value={linkNode}
              onChange={(e) => setLinkNode(e.target.value)}
              className="msz-np-input"
              aria-label="选择目标节点"
            >
              <option value="">— 选择节点 —</option>
              {nodeOptions.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.text.slice(0, 50)}
                </option>
              ))}
            </select>
            <button className="msz-np-add-btn" onClick={addLink} disabled={!linkNode}>
              添加
            </button>
          </div>
        )}
      </div>

      {/* 备注区（M7-P2 富文本） */}
      <div className="msz-np-section">
        <div className="msz-np-label">备注</div>
        <NoteEditor html={richHtml} onChange={setRichNote} />
        <div className="msz-np-note-hint">支持加粗 / 斜体 / 列表 / 链接 / 引用</div>
      </div>

      {/* 图片区（M7-P3） */}
      <div className="msz-np-section">
        <div className="msz-np-label">图片</div>
        <input
          type="file"
          accept="image/*"
          ref={imgInputRef}
          style={{ display: 'none' }}
          onChange={onPickImage}
        />
        <button className="msz-np-add-btn" onClick={() => imgInputRef.current?.click()}>
          上传图片
        </button>
        <div className="msz-np-img-list">
          {images.map((im) => (
            <ImageThumb key={im.id} image={im} onRemove={() => removeImage(im.id)} />
          ))}
        </div>
      </div>

      {/* 附件区（M7-P3） */}
      <div className="msz-np-section">
        <div className="msz-np-label">附件</div>
        <input
          type="file"
          ref={attInputRef}
          style={{ display: 'none' }}
          onChange={onPickAttachment}
        />
        <button className="msz-np-add-btn" onClick={() => attInputRef.current?.click()}>
          上传附件
        </button>
        <div className="msz-np-att-list">
          {!attachments.length && <div className="msz-np-empty">暂无附件</div>}
          {attachments.map((att) => (
            <div className="msz-np-att-item" key={att.id}>
              <span className="msz-np-att-name">{att.name}</span>
              <span>{fmtSize(att.size)}</span>
              <button onClick={() => void previewAttachment(att)}>预览</button>
              <button onClick={() => void downloadAttachment(att)}>下载</button>
              <button onClick={() => removeAttachment(att.id)}>×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * M7-P3：图片缩略图（HTML <img>，区别于画布的 SVG <image>）。
 * 异步从 IndexedDB 取出 blob 并显示，附带尺寸信息与删除按钮。
 */
function ImageThumb({ image, onRemove }: { image: NodeImage; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getBlobURL(image.blobId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [image.blobId])
  return (
    <div className="msz-np-img-thumb">
      <img src={url ?? ''} alt="" width={60} />
      <span>
        {image.w}×{image.h}
      </span>
      <button onClick={onRemove} aria-label="删除图片">
        ×
      </button>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
