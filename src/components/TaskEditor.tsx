import { useDoc } from '../store/docStore'
import { todayISO } from '../lib/date'
import { getTheme } from '../lib/theme'
import { useSettings } from '../store/settings'

export default function TaskEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const node = useDoc((s) => s.doc.nodes[id])
  const allNodes = useDoc((s) => s.doc.nodes)
  const dark = useSettings((s) => s.dark)
  const theme = getTheme(dark)
  if (!node) return null
  const st = useDoc.getState()
  const t = node.task ?? {}

  // 候选 = 其他所有任务；是否成环交给 store 的 wouldCreateCycle 判定
  // （树层级祖先与依赖无关：父级节点的任务同样可以当前置）
  const candidates = Object.values(allNodes)
    .filter((n) => n.id !== id && n.task)
    .sort((a, b) => a.text.localeCompare(b.text))

  return (
    <div
      className="task-editor"
      style={{ background: theme.panel, borderColor: theme.ink, color: theme.ink }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="te-head">
        <span className="te-title" title={node.text}>
          📌 {node.text || '未命名节点'}
        </span>
        <button className="tbtn" onClick={onClose}>
          ✕
        </button>
      </div>

      <label className="te-row">
        <input
          type="checkbox"
          checked={!!t.milestone}
          onChange={(e) =>
            st.setTask(id, {
              milestone: e.target.checked || undefined,
              start: t.start ?? todayISO(),
            })
          }
        />
        里程碑（零工期）
      </label>

      <div className="te-grid">
        <label>
          开始
          <input
            type="date"
            value={t.start ?? ''}
            onChange={(e) => st.setTask(id, { start: e.target.value || undefined })}
          />
        </label>
        {!t.milestone && (
          <label>
            结束
            <input
              type="date"
              value={t.end ?? ''}
              onChange={(e) => st.setTask(id, { end: e.target.value || undefined })}
            />
          </label>
        )}
      </div>

      {!t.milestone && (
        <label className="te-prog">
          进度 {Math.round((t.progress ?? 0) * 100)}%
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((t.progress ?? 0) * 100)}
            onChange={(e) => st.setTask(id, { progress: Number(e.target.value) / 100 })}
          />
        </label>
      )}

      <div className="te-deps">
        <div className="te-sub">前置任务（FS：完成后才开始）</div>
        {(t.deps ?? []).map((d) => (
          <span className="te-chip" key={d.from}>
            {allNodes[d.from]?.text ?? '(已删除)'}
            <button
              onClick={() => st.removeDep(d.from, id)}
              disabled={!allNodes[d.from]}
              title="移除依赖"
            >
              ✕
            </button>
          </span>
        ))}
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return
            const ok = st.addDep(e.target.value, id)
            if (!ok) alert('无法添加：该依赖会形成循环或已存在')
            e.target.value = ''
          }}
        >
          <option value="">＋ 添加前置任务…</option>
          {candidates
            .filter((n) => !(t.deps ?? []).some((d) => d.from === n.id))
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.text || '未命名'}
              </option>
            ))}
        </select>
      </div>

      <button
        className="tbtn te-clear"
        onClick={() => {
          st.clearTask(id)
          onClose()
        }}
      >
        移除任务信息（节点保留）
      </button>
    </div>
  )
}
