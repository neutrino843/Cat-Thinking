import type { DocData, TaskData } from '../types'
import { addDays, diffDays, todayISO } from './date'

export type GanttScale = 'day' | 'week' | 'month'

export interface GanttRow {
  id: string
  depth: number
  text: string
  task: TaskData | undefined
  y: number
}

export interface GanttModel {
  rows: GanttRow[]
  /** 时间轴第一天 */
  day0: string
  dayCount: number
  pxPerDay: number
  width: number
  todayOffset: number | null
}

export const ROW_H = 34
export const HEADER_H = 46
export const SCALE_PX: Record<GanttScale, number> = {
  day: 44,
  week: 16,
  month: 6,
}

function dfs(doc: DocData, id: string, depth: number, out: GanttRow[], y: { v: number }) {
  const n = doc.nodes[id]
  if (!n) return
  out.push({ id, depth, text: n.text, task: n.task, y: y.v })
  y.v += ROW_H
  for (const c of n.children) dfs(doc, c, depth + 1, out, y)
}

function hasTask(t: TaskData | undefined): boolean {
  return !!(t && (t.milestone || t.start))
}

export function computeGantt(doc: DocData, scale: GanttScale, today = todayISO()): GanttModel {
  const rows: GanttRow[] = []
  dfs(doc, doc.rootId, 0, rows, { v: HEADER_H })

  const tasks = rows.filter((r) => hasTask(r.task)).map((r) => r.task!)
  let minS: string | null = null
  let maxE: string | null = null
  for (const t of tasks) {
    const s = t.start ?? null
    const e = t.milestone ? t.start! : (t.end ?? t.start!)
    if (s && (!minS || diffDays(minS, s) < 0)) minS = s
    if (e && (!maxE || diffDays(maxE, e) > 0)) maxE = e
  }
  if (!minS) minS = addDays(today, -3)
  if (!maxE) maxE = addDays(today, 14)
  // 两侧留白
  const day0 = addDays(minS, -3)
  const dayCount = Math.max(14, diffDays(day0, maxE) + 6)
  const pxPerDay = SCALE_PX[scale]
  return {
    rows,
    day0,
    dayCount,
    pxPerDay,
    width: dayCount * pxPerDay,
    todayOffset: diffDays(day0, today) >= 0 && diffDays(day0, today) <= dayCount ? diffDays(day0, today) : null,
  }
}

/** 行索引便于查坐标 */
export function rowIndex(rows: GanttRow[]): Map<string, number> {
  return new Map(rows.map((r, i) => [r.id, i]))
}

/** 依赖边（仅渲染起点任务存在的 FS 依赖） */
export interface DepEdge {
  from: string
  to: string
}

export function depEdges(doc: DocData): DepEdge[] {
  const out: DepEdge[] = []
  for (const n of Object.values(doc.nodes)) {
    if (!hasTask(n.task)) continue
    for (const d of n.task!.deps ?? []) {
      const p = doc.nodes[d.from]?.task
      if (hasTask(p)) out.push({ from: d.from, to: n.id })
    }
  }
  return out
}

/** 添加 from→to 的 FS 依赖是否会形成环（含直接重复、自环） */
export function wouldCreateCycle(nodes: DocData['nodes'], from: string, to: string): boolean {
  if (from === to) return true
  // 已存在重复边
  const t = nodes[to]?.task
  if (t?.deps?.some((d) => d.from === from)) return true
  // 依赖存的是反向指针（y.deps 指向其前置 x，即前向边 x→y）。
  // 从 to 沿前向边传播，若能到达 from，则再加 from→to 必成环。
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === from) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const [yid, yn] of Object.entries(nodes)) {
      if (yn.task?.deps?.some((d) => d.from === cur)) stack.push(yid)
    }
  }
  return false
}

/** 条形几何（像素 x / 宽度 / y） */
export function barGeom(task: TaskData, rowY: number, model: GanttModel) {
  const s = task.start!
  const x = diffDays(model.day0, s) * model.pxPerDay
  if (task.milestone) {
    return { x, y: rowY + 6, size: ROW_H - 12, w: model.pxPerDay, milestone: true as const }
  }
  const days = Math.max(1, diffDays(s, task.end ?? s) + 1)
  return { x, y: rowY + 7, w: days * model.pxPerDay, h: ROW_H - 14, milestone: false as const, days }
}
