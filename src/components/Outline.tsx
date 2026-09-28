import { useEffect } from 'react'
import { useDoc } from '../store/docStore'

function Row({ id, depth }: { id: string; depth: number }) {
  const n = useDoc((s) => s.doc.nodes[id])
  const selected = useDoc((s) => s.selection.includes(id))
  if (!n) return null
  const st = useDoc.getState()
  const isRoot = id === st.doc.rootId
  const p = n.parent
  // M7-P4：升降级禁用判定
  // 升级（outdent ‹）：根 / 一级分支（父是根）禁用——升级到祖父=null 不合法
  const outdentDisabled = isRoot || !p || p === st.doc.rootId
  // 降级（indent ›）：根 / 首子禁用——首子无可挂靠的前一兄弟
  const sibs = p ? st.doc.nodes[p].children : []
  const indentDisabled = isRoot || !p || sibs.indexOf(id) <= 0

  /** M7-P4：升级——挂到祖父末尾（成为父的下一个兄弟） */
  const onOutdent = () => {
    if (outdentDisabled) return
    const grandpa = p ? st.doc.nodes[p].parent : null
    if (grandpa) st.reparent(id, grandpa)
  }
  /** M7-P4：降级——挂到前一兄弟末尾；折叠则先展开保证可见 */
  const onIndent = () => {
    if (indentDisabled || !p) return
    const idx = sibs.indexOf(id)
    const prev = sibs[idx - 1]
    if (st.doc.nodes[prev].collapsed) st.toggleCollapse(prev)
    st.reparent(id, prev)
  }

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
        <button
          className="ob act indent"
          title="升级（提升为父的兄弟）"
          aria-label="升级节点"
          disabled={outdentDisabled}
          onClick={onOutdent}
        >
          ‹
        </button>
        <button className="ob act" title="新建子节点 (Tab)" onClick={() => st.addChild(id, 'outline')}>
          ＋
        </button>
        <button
          className="ob act outdent"
          title="降级（移到前一兄弟下）"
          aria-label="降级节点"
          disabled={indentDisabled}
          onClick={onIndent}
        >
          ›
        </button>
        <button
          className="ob act danger"
          title="删除节点"
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
