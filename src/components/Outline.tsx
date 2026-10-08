import { useEffect, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useT } from '../i18n'

type DropPos = 'before' | 'after' | 'inside'

function Row({ id, depth }: { id: string; depth: number }) {
  const n = useDoc((s) => s.doc.nodes[id])
  const selected = useDoc((s) => s.selection.includes(id))
  const tr = useT()
  const [drop, setDrop] = useState<DropPos | null>(null)
  if (!n) return null
  const st = useDoc.getState()
  const isRoot = id === st.doc.rootId
  const p = n.parent
  const outdentDisabled = isRoot || !p || p === st.doc.rootId
  const sibs = p ? st.doc.nodes[p].children : []
  const indentDisabled = isRoot || !p || sibs.indexOf(id) <= 0

  const onOutdent = () => {
    if (outdentDisabled) return
    const grandpa = p ? st.doc.nodes[p].parent : null
    if (grandpa) st.reparent(id, grandpa)
  }
  const onIndent = () => {
    if (indentDisabled || !p) return
    const idx = sibs.indexOf(id)
    const prev = sibs[idx - 1]
    if (st.doc.nodes[prev].collapsed) st.toggleCollapse(prev)
    st.reparent(id, prev)
  }

  /* ---------------- M12：大纲内拖拽排序 ---------------- */
  const onDragStart = (e: React.DragEvent) => {
    // 根节点不可拖动
    if (isRoot) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'move'
    // text/plain 携带被拖 id（HTML5 DnD 必须设置数据才会触发后续事件）
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.setData('application/x-msz-node', id)
  }

  const onDragOver = (e: React.DragEvent) => {
    // 仅处理内部节点拖拽
    if (!e.dataTransfer.types.includes('application/x-msz-node')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const h = rect.height
    // 上 1/4 → before，下 1/4 → after，中间 → inside
    const pos: DropPos = y < h * 0.25 ? 'before' : y > h * 0.75 ? 'after' : 'inside'
    setDrop((prev) => (prev === pos ? prev : pos))
  }

  const onDragLeave = () => setDrop(null)

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const dragged = e.dataTransfer.getData('application/x-msz-node') || e.dataTransfer.getData('text/plain')
    setDrop(null)
    if (!dragged || dragged === id) return
    const pos = drop ?? 'inside'
    const destDoc = useDoc.getState().doc
    const draggedNode = destDoc.nodes[dragged]
    if (!draggedNode) return
    // 不能拖到自己的后代上
    let anc = p
    while (anc) {
      if (anc === dragged) return
      anc = destDoc.nodes[anc]?.parent ?? null
    }
    if (pos === 'inside') {
      // 成为 id 的最后一个孩子
      st.reparentAt(dragged, id, destDoc.nodes[id].children.length)
    } else {
      // 插到 id 之前/之后：目标父为 id 的父，index = id 在兄弟中的位置 + (after?1:0)
      const targetParent = p
      if (!targetParent) return
      const idx = destDoc.nodes[targetParent].children.indexOf(id)
      st.reparentAt(dragged, targetParent, pos === 'after' ? idx + 1 : idx)
    }
  }

  return (
    <>
      <div
        className={
          'outline-row' +
          (selected ? ' sel' : '') +
          (drop ? ` drop-${drop}` : '')
        }
        style={{ paddingLeft: 6 + depth * 18 }}
        draggable={!isRoot}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <button
          className="ob fold"
          disabled={!n.children.length}
          title={tr('outline.fold')}
          onClick={() => st.toggleCollapse(id)}
        >
          {n.children.length ? (n.collapsed ? '▸' : '▾') : '·'}
        </button>
        <input
          data-oid={id}
          value={n.text}
          placeholder={tr('outline.placeholder')}
          onChange={(e) => st.setText(id, e.target.value)}
          onFocus={() => {
            const s = st
            if (s.editing?.id !== id) s.beginEdit()
            s.select([id])
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              st.addSibling(id, 'outline')
            } else if (e.key === 'Tab') {
              e.preventDefault()
              st.addChild(id, 'outline')
            } else if (e.key === 'Escape') {
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <button
          className="ob act indent"
          title={tr('outline.outdent')}
          aria-label={tr('outline.outdent')}
          disabled={outdentDisabled}
          onClick={onOutdent}
        >
          ‹
        </button>
        <button className="ob act" title={tr('outline.addChild')} onClick={() => st.addChild(id, 'outline')}>
          ＋
        </button>
        <button
          className="ob act outdent"
          title={tr('outline.indent')}
          aria-label={tr('outline.indent')}
          disabled={indentDisabled}
          onClick={onIndent}
        >
          ›
        </button>
        <button
          className="ob act danger"
          title={tr('outline.remove')}
          disabled={isRoot}
          onClick={() => st.removeNodes([id])}
        >
          ✕
        </button>
      </div>
      {!n.collapsed && n.children.map((c) => <Row key={c} id={c} depth={depth + 1} />)}
    </>
  )
}

export default function Outline() {
  const rootId = useDoc((s) => s.doc.rootId)
  const editing = useDoc((s) => s.editing)
  const tr = useT()

  useEffect(() => {
    if (editing?.source === 'outline') {
      const safe = editing.id.replace(/["\\]/g, (m) => '\\' + m)
      const el = document.querySelector<HTMLInputElement>(`input[data-oid="${safe}"]`)
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [editing])

  return (
    <aside className="outline">
      <div className="outline-head">{tr('outline.title')}</div>
      <div className="outline-body">
        <Row id={rootId} depth={0} />
      </div>
    </aside>
  )
}
