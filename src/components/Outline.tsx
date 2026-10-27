import { memo, useEffect, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useT } from '../i18n'
import { executeNodeCommand, nodeCommandForKey } from '../lib/nodeKeyboard'

type DropPos = 'before' | 'after' | 'inside'

const Row = memo(function OutlineRow({ id, depth }: { id: string; depth: number }) {
  const n = useDoc((s) => s.doc.nodes[id])
  const selected = useDoc((s) => s.selection.includes(id))
  const isRoot = useDoc((s) => id === s.doc.rootId)
  const canOutdent = useDoc((s) => {
    const parent = s.doc.nodes[id]?.parent
    return id !== s.doc.rootId && !!parent && parent !== s.doc.rootId
  })
  const canIndent = useDoc((s) => {
    const parent = s.doc.nodes[id]?.parent
    return id !== s.doc.rootId && !!parent && (s.doc.nodes[parent]?.children.indexOf(id) ?? -1) > 0
  })
  const tr = useT()
  const [drop, setDrop] = useState<DropPos | null>(null)
  if (!n) return null
  const st = useDoc.getState()
  const p = n.parent

  const onOutdent = () => {
    const current = useDoc.getState()
    const parent = current.doc.nodes[id]?.parent
    if (id === current.doc.rootId || !parent || parent === current.doc.rootId) return
    const grandpa = current.doc.nodes[parent]?.parent
    if (grandpa) current.reparent(id, grandpa)
  }
  const onIndent = () => {
    const current = useDoc.getState()
    const parent = current.doc.nodes[id]?.parent
    if (id === current.doc.rootId || !parent) return
    const sibs = current.doc.nodes[parent]?.children ?? []
    const idx = sibs.indexOf(id)
    if (idx <= 0) return
    const prev = sibs[idx - 1]
    if (current.doc.nodes[prev]?.collapsed) current.toggleCollapse(prev)
    current.reparent(id, prev)
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
        <textarea
          rows={Math.min(8, n.text.split('\n').length)}
          data-oid={id}
          value={n.text}
          placeholder={tr('outline.placeholder')}
          onChange={(e) => st.setText(id, e.target.value)}
          onFocus={() => {
            const s = useDoc.getState()
            if (s.editing?.id !== id) s.beginEdit()
            s.select([id])
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
            if (e.repeat && ['Enter', 'Tab'].includes(e.key)) { e.preventDefault(); return }
            const command = nodeCommandForKey(e.nativeEvent)
            if (command) {
              e.preventDefault(); e.stopPropagation()
              executeNodeCommand(command, id, 'outline')
            } else if (e.key === 'Escape') {
              ;(e.target as HTMLTextAreaElement).blur()
            }
          }}
        />
        <button
          className="ob act indent"
          title={tr('outline.outdent')}
          aria-label={tr('outline.outdent')}
          disabled={!canOutdent}
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
          disabled={!canIndent}
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
})

export default function Outline() {
  const rootId = useDoc((s) => s.doc.rootId)
  const editing = useDoc((s) => s.editing)
  const tr = useT()

  useEffect(() => {
    if (editing?.source === 'outline') {
      const safe = editing.id.replace(/["\\]/g, (m) => '\\' + m)
      const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-oid="${safe}"]`)
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
