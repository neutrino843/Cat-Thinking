import { useMemo, useState } from 'react'
import { useDoc } from '../store/docStore'
import { ICONS } from '../data/icons'
import type { NodeLink, NodeTag } from '../types'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import NoteEditor from './NoteEditor'

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

  const selId = selection.length === 1 ? selection[0] : null
  const node = selId ? doc.nodes[selId] : null

  // 备注富文本初值：优先 richNote.html；其次纯 note 串转义为段落
  const richHtml = useMemo(() => {
    if (!node) return ''
    if (node.richNote?.html) return node.richNote.html
    if (node.note) return sanitizeHtml(`<p>${escapeHtml(node.note).replace(/\n/g, '<br>')}</p>`)
    return ''
  }, [node?.richNote?.html, node?.note])

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

  if (!selId || !node) return null

  const tags = node.tags ?? []
  const icons = node.icons ?? []
  const links = node.links ?? []

  function addTag() {
    const text = tagInput.trim()
    if (!text) return
    const tag: NodeTag = { id: genId(), text, color: tagColor }
    setNode(selId!, { tags: [...(node!.tags ?? []), tag] })
    setTagInput('')
  }

  function removeTag(id: string) {
    setNode(selId!, { tags: tags.filter((t) => t.id !== id) })
  }

  function toggleIcon(iconId: string) {
    const has = icons.includes(iconId)
    setNode(selId!, {
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
      setNode(selId!, { links: [...links, link] })
      setLinkUrl('')
    } else {
      const nid = linkNode
      if (!nid || !doc.nodes[nid] || nid === selId) {
        window.alert('请选择一个目标节点')
        return
      }
      const link: NodeLink = { id: genId(), kind: 'node', nodeId: nid }
      setNode(selId!, { links: [...links, link] })
      setLinkNode('')
    }
  }

  function removeLink(id: string) {
    setNode(selId!, { links: links.filter((l) => l.id !== id) })
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
    setNode(selId!, { richNote: { html } })
  }

  return (
    <div className="msz-node-panel">
      <div className="msz-np-header">
        <span>节点内容</span>
        <span className="msz-np-node-id" title={selId}>
          {node.text?.slice(0, 12) || '未命名'}
        </span>
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
