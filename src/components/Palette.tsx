import { useEffect, useMemo, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import { exportCurrent } from '../lib/exporters'
import { saveTemplate } from '../store/db'

interface Cmd {
  id: string
  label: string
  key?: string
  run: () => void
}

function buildCmds(): Cmd[] {
  const d = () => useDoc.getState()
  const s = () => useSettings.getState()
  return [
    {
      id: 'child',
      label: '新建子节点',
      key: 'Tab',
      run: () => {
        const st = d()
        st.addChild(st.selection[0] ?? st.doc.rootId)
      },
    },
    {
      id: 'sibling',
      label: '新建兄弟节点',
      key: 'Enter',
      run: () => {
        const st = d()
        if (st.selection[0]) st.addSibling(st.selection[0])
      },
    },
    {
      id: 'del',
      label: '删除选中节点',
      key: 'Delete',
      run: () => d().removeNodes(d().selection),
    },
    { id: 'undo', label: '撤销', key: 'Ctrl+Z', run: () => d().undo() },
    { id: 'redo', label: '重做', key: 'Ctrl+Shift+Z', run: () => d().redo() },
    { id: 'fit', label: '适应窗口', run: () => window.dispatchEvent(new Event('msz:fit')) },
    { id: 'layout-logic', label: '切换为逻辑图', run: () => d().setLayout('logic') },
    { id: 'layout-tree', label: '切换为树形图', run: () => d().setLayout('tree') },
    { id: 'view-mind', label: '切换到思维导图视图', run: () => s().setView('mind') },
    { id: 'view-gantt', label: '切换到甘特图视图', run: () => s().setView('gantt') },
    {
      id: 'present-start',
      label: '开始演示（全屏逐级讲解）',
      run: () => {
        s().setView('mind')
        window.dispatchEvent(new Event('msz:present'))
      },
    },
    { id: 'present-exit', label: '退出演示', run: () => s().exitPresenting() },
    { id: 'scale-day', label: '甘特时间轴：按日', run: () => s().setGanttScale('day') },
    { id: 'scale-week', label: '甘特时间轴：按周', run: () => s().setGanttScale('week') },
    { id: 'scale-month', label: '甘特时间轴：按月', run: () => s().setGanttScale('month') },
    { id: 'theme', label: '切换深色 / 浅色模式', run: () => s().toggleDark() },
    {
      id: 'reduce-motion',
      label: '减少动效：开 / 关（也可跟随系统）',
      run: () => s().toggleReduceMotion(),
    },
    { id: 'sk0', label: '手绘程度：简洁', run: () => s().setSketch(0) },
    { id: 'sk1', label: '手绘程度：中等', run: () => s().setSketch(1) },
    { id: 'sk2', label: '手绘程度：很手绘', run: () => s().setSketch(2) },
    { id: 'outline', label: '打开 / 关闭大纲视图', run: () => s().toggleOutline() },
    {
      id: 'save-template',
      label: '将当前文档存为模板',
      run: () => {
        const st = d()
        const name = window.prompt('模板名称', st.doc.title || '未命名导图')
        if (!name?.trim()) return
        void saveTemplate(name.trim(), st.doc).then(() =>
          window.dispatchEvent(new Event('msz:templates-changed')),
        )
      },
    },
    {
      id: 'collapse',
      label: '折叠 / 展开选中节点',
      key: 'Space',
      run: () => {
        const st = d()
        if (st.selection[0]) st.toggleCollapse(st.selection[0])
      },
    },
    { id: 'exp-json', label: '导出 JSON', run: () => void exportCurrent('json') },
    { id: 'exp-md', label: '导出 Markdown', run: () => void exportCurrent('md') },
    { id: 'exp-csv', label: '导出甘特任务表 CSV', run: () => void exportCurrent('csv') },
    { id: 'exp-svg', label: '导出 SVG', run: () => void exportCurrent('svg') },
    { id: 'exp-png', label: '导出 PNG', run: () => void exportCurrent('png') },
    {
      id: 'trash-open',
      label: '打开回收站',
      run: () => window.dispatchEvent(new Event('msz:trash-open')),
    },
    {
      id: 'trash-empty',
      label: '清空回收站',
      run: () => window.dispatchEvent(new Event('msz:trash-empty')),
    },
  ]
}

export default function Palette() {
  const open = useSettings((s) => s.paletteOpen)
  const setPalette = useSettings((s) => s.setPalette)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const cmds = useMemo(buildCmds, [])
  const filtered = cmds.filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()))

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="palette-mask"
      onMouseDown={() => setPalette(false)}
    >
      <div className="palette" role="dialog" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="输入命令…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(filtered.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              filtered[idx]?.run()
              setPalette(false)
            } else if (e.key === 'Escape') {
              setPalette(false)
            }
          }}
        />
        <ul>
          {filtered.map((c, i) => (
            <li
              key={c.id}
              className={i === idx ? 'on' : ''}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                c.run()
                setPalette(false)
              }}
            >
              <span>{c.label}</span>
              {c.key && <kbd>{c.key}</kbd>}
            </li>
          ))}
          {!filtered.length && <li className="empty">没有匹配的命令</li>}
        </ul>
      </div>
    </div>
  )
}
