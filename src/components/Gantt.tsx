import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useDoc } from '../store/docStore'
import { useSettings } from '../store/settings'
import {
  barGeom,
  computeGantt,
  criticalPath,
  depEdges,
  HEADER_H,
  ROW_H,
  type GanttModel,
  type GanttScale,
} from '../lib/gantt'
import { addDays, diffDays, isWeekend, monthKey, parseISO, todayISO, weekStart } from '../lib/date'
import { getTheme, type Theme } from '../lib/theme'
import { ganttHolder } from '../store/refs'
import type { DocData, TaskData } from '../types'
import { useT } from '../i18n'
import TaskEditor from './TaskEditor'

const SCALES: { id: GanttScale; label: string }[] = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
]

/** 每个顶层分支的颜色索引 */
function branchColors(doc: DocData): Map<string, number> {
  const map = new Map<string, number>()
  const walk = (id: string, color: number) => {
    map.set(id, color)
    for (const c of doc.nodes[id]?.children ?? []) walk(c, color)
  }
  doc.nodes[doc.rootId]?.children.forEach((c, i) => walk(c, i % 6))
  return map
}

/* 时间轴表头刻度 */
function headerTicks(model: GanttModel, scale: GanttScale) {
  const ticks: { x: number; label: string; sub: string }[] = []
  if (scale === 'day') {
    for (let i = 0; i < model.dayCount; i++) {
      const d = addDays(model.day0, i)
      // 修 F-2：用 parseISO 本地解析；new Date('YYYY-MM-DD') 按 UTC 解析，
      // 在 UTC- 时区（如美洲）会让星期索引整体错位
      ticks.push({ x: i * model.pxPerDay, label: String(Number(d.slice(8))), sub: '日一二三四五六'[parseISO(d).getDay()] })
    }
  } else if (scale === 'week') {
    for (let i = 0; i < model.dayCount; i += 7) {
      const d = addDays(model.day0, i)
      ticks.push({ x: i * model.pxPerDay, label: d.slice(5).replace('-', '/'), sub: weekStart(d).slice(5).replace('-', '/') })
    }
  } else {
    for (let i = 0; i < model.dayCount; i += 30) {
      const d = addDays(model.day0, i)
      ticks.push({ x: i * model.pxPerDay, label: d.slice(0, 4), sub: Number(d.slice(5)) + '月' })
    }
  }
  return ticks
}

function monthBoundaries(model: GanttModel) {
  const out: { x: number; label: string }[] = []
  let last = ''
  for (let i = 0; i <= model.dayCount; i++) {
    const d = addDays(model.day0, i)
    const m = monthKey(d)
    if (m !== last) {
      out.push({ x: i * model.pxPerDay, label: `${d.slice(0, 4)}年${Number(d.slice(5))}月` })
      last = m
    }
  }
  return out
}

export default function Gantt() {
  const doc = useDoc((s) => s.doc)
  const selection = useDoc((s) => s.selection)
  const scale = useSettings((s) => s.ganttScale)
  const dark = useSettings((s) => s.dark)
  // M8-P2-4：导出全量渲染时关闭行虚拟化，保证甘特 SVG/PNG 导出含全部行（R1 红线）
  const exportFullRender = useSettings((s) => s.exportFullRender)
  const theme = getTheme(dark)
  const t = useT()
  const [editorId, setEditorId] = useState<string | null>(null)

  const model = useMemo(() => computeGantt(doc, scale), [doc, scale])
  const colors = useMemo(() => branchColors(doc), [doc])
  const edges = useMemo(() => depEdges(doc), [doc])
  // M14：关键路径节点集合（最长依赖链）
  const criticalSet = useMemo(() => criticalPath(doc), [doc])
  const [showCritical, setShowCritical] = useState(true)
  const ticks = useMemo(() => headerTicks(model, scale), [model, scale])
  const months = useMemo(() => monthBoundaries(model), [model])
  // 修 P-5：周末底纹只随 model 变化重算，不再每次渲染重新 Array.from+filter
  const weekends = useMemo(
    () =>
      Array.from({ length: model.dayCount }, (_, i) => i).filter((i) =>
        isWeekend(addDays(model.day0, i)),
      ),
    [model],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)

  // M8-P2-4：行虚拟化——跟踪滚动位置与视口高度，仅渲染可视行（含 ±ROW_MARGIN 缓冲）。
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrollTop(el.scrollTop)
      setViewportH(el.clientHeight)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  /* 存活标记：拖拽中切视图/卸载时，window 监听自我清理（修 F-8） */
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  const height = HEADER_H + model.rows.length * ROW_H
  const today = todayISO()

  const onListScroll = () => {
    // M8-P2-4：左侧滚动也同步 scrollTop（用户可能从左侧滚轮滚动）
    if (listRef.current) setScrollTop(listRef.current.scrollTop)
    if (syncing.current) return
    syncing.current = true
    if (scrollRef.current && listRef.current) scrollRef.current.scrollTop = listRef.current.scrollTop
    requestAnimationFrame(() => (syncing.current = false))
  }
  const onChartScroll = () => {
    // M8-P2-4：右侧滚动是虚拟化的主输入
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
    if (syncing.current) return
    syncing.current = true
    if (listRef.current && scrollRef.current) listRef.current.scrollTop = scrollRef.current.scrollTop
    requestAnimationFrame(() => (syncing.current = false))
  }

  // M8-P2-4：计算可视行切片。行 y = HEADER_H + i*ROW_H；导出全量渲染或视口未就绪时返回全量。
  const ROW_MARGIN = 200
  const { firstRow, lastRow, visibleRows } = useMemo(() => {
    if (exportFullRender || viewportH === 0) {
      return { firstRow: 0, lastRow: model.rows.length, visibleRows: model.rows }
    }
    const first = Math.max(0, Math.floor((scrollTop - HEADER_H - ROW_MARGIN) / ROW_H))
    const last = Math.min(model.rows.length, Math.ceil((scrollTop + viewportH - HEADER_H + ROW_MARGIN) / ROW_H))
    return { firstRow: first, lastRow: last, visibleRows: model.rows.slice(first, last) }
  }, [model, scrollTop, viewportH, exportFullRender])

  // 可视行 id 集合：依赖箭头仅当至少一端在可视范围内时渲染
  const visibleRowIds = useMemo(() => {
    const s = new Set<string>()
    for (const r of visibleRows) s.add(r.id)
    return s
  }, [visibleRows])

  /* 条形拖拽（move/resize），拖拽期间不打历史，开始时打一次快照 */
  const startDrag = (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
    e.stopPropagation()
    e.preventDefault()
    const st = useDoc.getState()
    const task = st.doc.nodes[id]?.task
    if (!task?.start) {
      setEditorId(id)
      return
    }
    st.select([id])
    st.beginEdit()
    const startX = e.clientX
    const oStart = task.start
    const oEnd = task.end ?? task.start
    let moved = false
    const onMove = (ev: PointerEvent) => {
      // 修 F-8：卸载后自我清理
      if (!aliveRef.current) {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        return
      }
      const dx = ev.clientX - startX
      const delta = Math.round(dx / model.pxPerDay)
      if (!moved && Math.abs(dx) > 3) moved = true
      if (!moved) return
      if (task.milestone || mode === 'move') {
        st.setTask(id, { start: addDays(oStart, delta), ...(task.milestone ? {} : { end: addDays(oEnd, delta) }) }, false)
      } else {
        // 修 F-5：允许负 delta 向左缩短工期（旧代码 Math.max(0, delta) 永远只能延长），
        // 但 end 不得早于 start：缩短量上限为原 end 与 start 的天数差
        const maxShrink = -diffDays(oStart, oEnd)
        const endDelta = Math.max(maxShrink, delta)
        st.setTask(id, { start: oStart, end: addDays(oEnd, endDelta) }, false)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!moved) setEditorId(id)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const makeTask = (id: string) => {
    const st = useDoc.getState()
    st.beginEdit()
    st.setTask(id, { start: today, end: addDays(today, 3), progress: 0 })
    setEditorId(id)
  }

  const rowById = new Map(model.rows.map((r) => [r.id, r]))

  /* 搜索定位：滚动到目标行 */
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      const idx = model.rows.findIndex((r) => r.id === id)
      if (idx < 0) return
      const top = HEADER_H + idx * ROW_H - 80
      const clampedTop = Math.max(0, top)
      if (listRef.current) listRef.current.scrollTop = clampedTop
      if (scrollRef.current) scrollRef.current.scrollTop = clampedTop
      // M8-P2-4：程序化滚动不触发 scroll 事件，手动同步虚拟化输入
      setScrollTop(clampedTop)
      const t = doc.nodes[id]?.task
      if (t?.start && scrollRef.current) {
        scrollRef.current.scrollLeft = Math.max(
          0,
          diffDays(model.day0, t.start) * model.pxPerDay - 120,
        )
      }
    }
    window.addEventListener('msz:gantt-find', h)
    return () => window.removeEventListener('msz:gantt-find', h)
  }, [model, doc])

  return (
    <div className="gantt">
      <div className="gantt-left" ref={listRef} onScroll={onListScroll}>
        <div style={{ height: HEADER_H }} className="gantt-corner gantt-grid">
          <div className="gantt-th">{t('gantt.colName')}</div>
          <div className="gantt-th">{t('gantt.colStart')}</div>
          <div className="gantt-th">{t('gantt.colEnd')}</div>
          <div className="gantt-th">{t('gantt.colProgress')}</div>
          <div className="gantt-th gantt-th-center">{t('gantt.colMilestone')}</div>
          <div className="gantt-th gantt-th-center">{t('gantt.colDeps')}</div>
          <div className="gantt-th gantt-th-center">{t('gantt.colPriority')}</div>
          <div className="gantt-th">{t('gantt.colOwner')}</div>
        </div>
        {/* M8-P2-4：行虚拟化——顶部占位撑出可视区上方空间 */}
        {firstRow > 0 && <div style={{ height: firstRow * ROW_H }} />}
        {visibleRows.map((r) => {
          const task = r.task
          const isMs = !!task?.milestone
          const prog = task?.progress ?? 0
          return (
            <div
              key={r.id}
              className={'gantt-row gantt-grid' + (selection.includes(r.id) ? ' sel' : '')}
              style={{ height: ROW_H }}
              onClick={() => useDoc.getState().select([r.id])}
              onDoubleClick={() => setEditorId(r.id)}
            >
              {/* 任务名列 */}
              <div className="gantt-cell gantt-cell-name" style={{ paddingLeft: 8 + r.depth * 14 }}>
                <span className="gantt-dot" style={{ background: task ? theme.branch[colors.get(r.id) ?? 0] : 'transparent' }} />
                <span className="gantt-name-text">{r.text || t('common.untitled')}</span>
                <button
                  className="gantt-add"
                  title={task ? t('gantt.editTask') : t('gantt.makeTask')}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (task) setEditorId(r.id)
                    else makeTask(r.id)
                  }}
                >
                  {task ? '📅' : '＋'}
                </button>
              </div>
              {/* 开始 */}
              <div className="gantt-cell">
                {task ? (
                  <input
                    type="date"
                    className="gantt-date"
                    value={task.start ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => useDoc.getState().setTask(r.id, { start: e.target.value || undefined })}
                  />
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
              {/* 结束 */}
              <div className="gantt-cell">
                {task && !isMs ? (
                  <input
                    type="date"
                    className="gantt-date"
                    value={task.end ?? task.start ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => useDoc.getState().setTask(r.id, { end: e.target.value || undefined })}
                  />
                ) : (
                  <span className="gantt-muted">{isMs ? '◆' : '—'}</span>
                )}
              </div>
              {/* 进度 */}
              <div className="gantt-cell gantt-cell-prog">
                {task ? (
                  <>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(prog * 100)}
                      className="gantt-range"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => useDoc.getState().setTask(r.id, { progress: Number(e.target.value) / 100 })}
                    />
                    <span className="gantt-prog-text">{Math.round(prog * 100)}%</span>
                  </>
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
              {/* 里程碑 */}
              <div className="gantt-cell gantt-cell-center">
                {task ? (
                  <input
                    type="checkbox"
                    className="gantt-check"
                    checked={isMs}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => useDoc.getState().setTask(r.id, { milestone: e.target.checked })}
                  />
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
              {/* 依赖 */}
              <div className="gantt-cell gantt-cell-center">
                {task ? (
                  <button
                    className="gantt-deps-btn"
                    title={t('gantt.editTask')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditorId(r.id)
                    }}
                  >
                    {t('gantt.depsCount', { n: String(task.deps?.length ?? 0) })}
                  </button>
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
              {/* 优先级 */}
              <div className="gantt-cell gantt-cell-center">
                {task ? (
                  <select
                    className="gantt-priority"
                    value={String(task.priority ?? 0)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      useDoc.getState().setTask(r.id, {
                        priority: Number(e.target.value) as 0 | 1 | 2 | 3,
                      })
                    }
                  >
                    <option value="0">{t('gantt.priorityNone')}</option>
                    <option value="1">{t('gantt.priorityLow')}</option>
                    <option value="2">{t('gantt.priorityMedium')}</option>
                    <option value="3">{t('gantt.priorityHigh')}</option>
                  </select>
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
              {/* 负责人 */}
              <div className="gantt-cell">
                {task ? (
                  <input
                    type="text"
                    className="gantt-owner"
                    value={task.owner ?? ''}
                    placeholder={t('gantt.ownerPlaceholder')}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => useDoc.getState().setTask(r.id, { owner: e.target.value || undefined })}
                  />
                ) : (
                  <span className="gantt-muted">—</span>
                )}
              </div>
            </div>
          )
        })}
        {/* M8-P2-4：底部占位撑出可视区下方空间 */}
        {lastRow < model.rows.length && (
          <div style={{ height: (model.rows.length - lastRow) * ROW_H }} />
        )}
      </div>

      <div className="gantt-right-wrap">
        <div className="gantt-right" ref={scrollRef} onScroll={onChartScroll}>
        <svg
          id="gantt-world"
          role="img"
          aria-label="甘特图时间轴（与思维导图同源）"
          ref={(el) => {
            ganttHolder.current = el
          }}
          width={model.width}
          height={height}
          style={{ display: 'block' }}
        >
          <rect x={0} y={0} width={model.width} height={height} fill={theme.paper} />

          {/* 周末底纹 */}
          {weekends.map((i) => {
            const d = addDays(model.day0, i)
            return <rect key={d} x={i * model.pxPerDay} y={0} width={model.pxPerDay} height={height} fill={theme.grid} opacity={0.55} />
          })}

          {/* 行分隔线（M8-P2-4：仅渲染可视行） */}
          {visibleRows.map((r) => (
            <line key={r.id} x1={0} x2={model.width} y1={r.y + ROW_H} y2={r.y + ROW_H} stroke={theme.grid} strokeWidth={1} opacity={0.7} />
          ))}

          {/* 月份边界 */}
          {months.map((m) => (
            <g key={m.label + m.x}>
              <line x1={m.x} y1={0} x2={m.x} y2={height} stroke={theme.inkSoft} strokeWidth={1} opacity={0.5} />
              <text x={m.x + 6} y={15} fontSize={11} fill={theme.inkSoft}>
                {m.label}
              </text>
            </g>
          ))}

          {/* 日期刻度 */}
          {ticks.map((t, i) => (
            <text
              key={i}
              x={t.x + model.pxPerDay / 2}
              y={scale === 'day' ? 32 : 30}
              fontSize={10}
              textAnchor="middle"
              fill={theme.inkSoft}
            >
              {t.label}
            </text>
          ))}
          <line x1={0} x2={model.width} y1={HEADER_H} y2={HEADER_H} stroke={theme.inkSoft} strokeWidth={1.4} />

          {/* 今日线 */}
          {model.todayOffset !== null && (
            <g>
              <line
                x1={model.todayOffset * model.pxPerDay + model.pxPerDay / 2}
                x2={model.todayOffset * model.pxPerDay + model.pxPerDay / 2}
                y1={HEADER_H}
                y2={height}
                stroke={theme.accent}
                strokeWidth={1.8}
                strokeDasharray="6 4"
              />
              <text
                x={model.todayOffset * model.pxPerDay + model.pxPerDay / 2 + 4}
                y={HEADER_H - 4}
                fontSize={10}
                fill={theme.accent}
              >
                今天
              </text>
            </g>
          )}

          {/* 依赖箭头（M8-P2-4：两端均不在可视行范围则跳过） */}
          {edges.map((e) => {
            const fr = rowById.get(e.from)
            const tr = rowById.get(e.to)
            if (!fr?.task || !tr?.task) return null
            // 导出全量渲染时 visibleRowIds 含全部行，不会误跳
            if (!exportFullRender && !visibleRowIds.has(fr.id) && !visibleRowIds.has(tr.id)) return null
            const fg = barGeom(fr.task, fr.y, model)
            const tg = barGeom(tr.task, tr.y, model)
            const sx = fg.milestone ? fg.x + fg.size / 2 : fg.x + fg.w
            const sy = (fg.milestone ? fg.y + fg.size / 2 : fg.y + fg.h / 2)
            // 修 C-2：里程碑与普通条的箭头终点 x 相同（tg.x），删除恒等三元
            const ex = tg.x
            const ey = tg.milestone ? tg.y + tg.size / 2 : tg.y + tg.h / 2
            const back = ex < sx
            const mx = sx + (back ? -10 : 14)
            const d = `M${sx} ${sy} C${mx} ${sy}, ${ex + (back ? 14 : -14)} ${ey}, ${ex} ${ey}`
            return (
              <path
                key={e.from + '>' + e.to}
                d={d}
                fill="none"
                stroke={theme.inkSoft}
                strokeWidth={1.4}
                markerEnd="url(#msz-arrow)"
              />
            )
          })}

          <defs>
            <marker id="msz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={theme.inkSoft} />
            </marker>
          </defs>

          {/* 任务条（M8-P2-4：仅渲染可视行；M14：关键路径高亮） */}
          {visibleRows.map((r) =>
            r.task?.start ? (
              <Bar
                key={r.id}
                id={r.id}
                task={r.task}
                rowY={r.y}
                model={model}
                color={theme.branch[colors.get(r.id) ?? 0]}
                critical={showCritical && criticalSet.has(r.id)}
                selected={selection.includes(r.id)}
                theme={theme}
                onDown={startDrag}
              />
            ) : null,
          )}
        </svg>
        </div>
        {/* M14：关键路径高亮开关 */}
        <button
          className={'gantt-critical-toggle' + (showCritical ? ' on' : '')}
          title={t('gantt.criticalPath')}
          onClick={() => setShowCritical((v) => !v)}
        >
          <span className="gantt-critical-dot" />
          {t('gantt.criticalPath')}
        </button>
        <div className="paper-noise" aria-hidden="true" />
      </div>

      {editorId && doc.nodes[editorId] && (
        <TaskEditor id={editorId} onClose={() => setEditorId(null)} />
      )}
    </div>
  )
}

/* ---------------- Bar ---------------- */

interface BarProps {
  id: string
  task: TaskData
  rowY: number
  model: GanttModel
  color: string
  /** M14：是否在关键路径上（高亮为 critical 色） */
  critical: boolean
  selected: boolean
  theme: Theme
  onDown: (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => void
}

const Bar = memo(function Bar({ id, task, rowY, model, color, critical, selected, theme, onDown }: BarProps) {
  const g = barGeom(task, rowY, model)
  // 关键路径用主题 critical 色覆盖分支色
  const barColor = critical ? theme.critical : color
  if (g.milestone) {
    const cx = g.x + g.size / 2
    const cy = g.y + g.size / 2
    const r = g.size / 2
    return (
      <g onPointerDown={(e) => onDown(e, id, 'move')} style={{ cursor: 'pointer' }}>
        <polygon
          points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
          fill={barColor}
          stroke={theme.ink}
          strokeWidth={1.4}
        />
        {selected && <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={theme.selStroke} strokeWidth={1.4} strokeDasharray="4 3" />}
      </g>
    )
  }
  const pct = task.progress ?? 0
  return (
    <g>
      <rect
        x={g.x}
        y={g.y}
        width={g.w}
        height={g.h}
        rx={7}
        fill={barColor}
        opacity={0.28}
        stroke={barColor}
        strokeWidth={selected ? 2.6 : 1.8}
        onPointerDown={(e) => onDown(e, id, 'move')}
        style={{ cursor: 'grab' }}
      />
      {pct > 0 && (
        <rect x={g.x} y={g.y} width={Math.max(2, g.w * pct)} height={g.h} rx={7} fill={barColor} opacity={0.75} pointerEvents="none" />
      )}
      <rect
        x={g.x + g.w - 6}
        y={g.y - 1}
        width={9}
        height={g.h + 2}
        rx={3}
        fill="transparent"
        style={{ cursor: 'ew-resize' }}
        onPointerDown={(e) => onDown(e, id, 'resize')}
      />
      <text x={g.x + 7} y={g.y + g.h / 2} dominantBaseline="central" fontSize={10.5} fill={theme.ink} pointerEvents="none">
        {Math.round(pct * 100)}%
      </text>
    </g>
  )
})

export { SCALES }
