import { useState } from 'react'
import { useDoc } from '../store/docStore'
import { ICONS } from '../data/icons'
import type { NodeTag } from '../types'

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
 * P2/P3 将追加链接/图片/附件分区。
 */
export default function NodePanel() {
  const selection = useDoc((s) => s.selection)
  const doc = useDoc((s) => s.doc)
  const setNode = useDoc((s) => s.setNode)
  const [tagInput, setTagInput] = useState('')
  const [tagColor, setTagColor] = useState('blue')

  const selId = selection.length === 1 ? selection[0] : null
  const node = selId ? doc.nodes[selId] : null
  if (!selId || !node) return null

  const tags = node.tags ?? []
  const icons = node.icons ?? []

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
    </div>
  )
}
