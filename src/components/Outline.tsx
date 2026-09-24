import { useEffect } from 'react'
import { useDoc } from '../store/docStore'

function Row({ id, depth }: { id: string; depth: number }) {
  const n = useDoc((s) => s.doc.nodes[id])
  const selected = useDoc((s) => s.selection.includes(id))
  if (!n) return null
  const st = useDoc.getState()
  return (
    <>
      <div className={'outline-row' + (selected ? ' sel' : '')} style={{ paddingLeft: 6 + depth * 18 }}>
        <button
          className="ob fold"
          disabled={!n.children.length}
          title="折叠 / 展开"
          onClick={() => st.toggleCollapse(id)}
        >
          {n.children.length ? (n.collapsed ? '▸' : '▾') : '·'}
        </button>
        <input
          data-oid={id}
          value={n.text}
          placeholder="输入内容…"
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
        <button className="ob act" title="新建子节点 (Tab)" onClick={() => st.addChild(id, 'outline')}>
          ＋
        </button>
        <button
          className="ob act danger"
          title="删除节点"
          disabled={id === st.doc.rootId}
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

  useEffect(() => {
    if (editing?.source === 'outline') {
      // 修 S-5：转义 id 中的反斜杠/双引号，避免属性选择器注入/选择失败
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
      <div className="outline-head">大纲 · 双向同步</div>
      <div className="outline-body">
        <Row id={rootId} depth={0} />
      </div>
    </aside>
  )
}
