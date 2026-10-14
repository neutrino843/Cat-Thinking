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

type ScheduledTask = TaskData & { start: string }

function hasTask(t: TaskData | undefined): t is ScheduledTask {
  return typeof t?.start === 'string' && t.start.length > 0
}

export function computeGantt(doc: DocData, scale: GanttScale, today = todayISO()): GanttModel {
  const rows: GanttRow[] = []
  dfs(doc, doc.rootId, 0, rows, { v: HEADER_H })

  const tasks: ScheduledTask[] = []
  for (const row of rows) {
    if (hasTask(row.task)) tasks.push(row.task)
  }
  let minS: string | null = null
  let maxE: string | null = null
  for (const t of tasks) {
    const s = t.start
    const e = t.milestone ? t.start : (t.end ?? t.start)
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
    const task = n.task
    if (!hasTask(task)) continue
    for (const d of task.deps ?? []) {
      const p = doc.nodes[d.from]?.task
      if (hasTask(p)) out.push({ from: d.from, to: n.id })
    }
  }
  return out
}

/**
 * M14：关键路径。基于依赖图的最长路径（按任务工期加权）。
 * - 工期：里程碑 0 天；普通任务 max(1, end-start)。
 * - lp[v] = 以 v 结尾的最长路径长度（含 v 自身工期），按拓扑序 DP。
 * - rp[v] = 以 v 开头的最长路径长度（含 v 自身工期），按逆拓扑序 DP。
 * - v 在某条关键路径上当且仅当 lp[v] + rp[v] - dur[v] == 全局最长路径长度。
 * 含环时退化为 Kahn 拓扑能覆盖的节点子集（环上节点不参与）。
 */
export function criticalPath(doc: DocData): Set<string> {
  const tasks = new Map<string, ScheduledTask>()
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (hasTask(n.task)) tasks.set(id, n.task)
  }
  if (tasks.size === 0) return new Set<string>()

  const dur = (id: string) => {
    const t = tasks.get(id)
    if (!t) throw new Error(`甘特任务索引不一致：${id}`)
    if (t.milestone) return 0
    return Math.max(1, diffDays(t.start, t.end ?? t.start))
  }

  // 前驱/后继邻接（仅保留两端均为任务的依赖边）
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const [id] of tasks) {
    preds.set(id, [])
    succs.set(id, [])
  }
  for (const [id, t] of tasks) {
    for (const d of t.deps ?? []) {
      if (tasks.has(d.from)) {
        const nodePreds = preds.get(id)
        const dependencySuccs = succs.get(d.from)
        if (!nodePreds || !dependencySuccs) throw new Error('甘特依赖索引初始化失败')
        nodePreds.push(d.from)
        dependencySuccs.push(id)
      }
    }
  }

  // Kahn 拓扑排序
  const indeg = new Map<string, number>()
  for (const [id, ps] of preds) indeg.set(id, ps.length)
  const queue: string[] = []
  for (const [id, d] of indeg) if (d === 0) queue.push(id)
  const topo: string[] = []
  while (queue.length) {
    const cur = queue.shift()
    if (cur === undefined) break
    topo.push(cur)
    for (const s of succs.get(cur) ?? []) {
      const currentDegree = indeg.get(s)
      if (currentDegree === undefined) throw new Error(`甘特入度索引缺少任务：${s}`)
      const nextDegree = currentDegree - 1
      indeg.set(s, nextDegree)
      if (nextDegree === 0) queue.push(s)
    }
  }

  // lp：以 v 结尾的最长路径（含 v 工期）
  const lp = new Map<string, number>()
  for (const id of topo) {
    let best = 0
    for (const p of preds.get(id) ?? []) best = Math.max(best, lp.get(p) ?? 0)
    lp.set(id, best + dur(id))
  }

  // rp：以 v 开头的最长路径（含 v 工期），逆拓扑序
  const rp = new Map<string, number>()
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i]
    let best = 0
    for (const s of succs.get(id) ?? []) best = Math.max(best, rp.get(s) ?? 0)
    rp.set(id, best + dur(id))
  }

  // 全局最长路径长度 = max(lp)
  let globalMax = 0
  for (const v of lp.values()) if (v > globalMax) globalMax = v
  if (globalMax === 0) return new Set<string>() // 全是里程碑或无任务

  const critical = new Set<string>()
  for (const id of topo) {
    if ((lp.get(id) ?? 0) + (rp.get(id) ?? 0) - dur(id) === globalMax) critical.add(id)
  }
  return critical
}

/**
 * 构建前向邻接表：key=前置节点 x，value=[后继节点 y...]（y.task.deps 指向 x 即边 x→y）。
 * M8-P1（P-3）：环检测旧实现 BFS 每跳都 Object.entries 全表扫描，整体 O(n²)；
 * 邻接表一次构建 O(V+E)，BFS 沿表传播同样 O(V+E)。
 */
function forwardAdjacency(nodes: DocData['nodes']): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const [yid, yn] of Object.entries(nodes)) {
    const deps = yn.task?.deps
    if (!deps) continue
    for (const d of deps) {
      const arr = adj.get(d.from)
      if (arr) arr.push(yid)
      else adj.set(d.from, [yid])
    }
  }
  return adj
}

/** 添加 from→to 的 FS 依赖是否会形成环（含直接重复、自环） */
export function wouldCreateCycle(nodes: DocData['nodes'], from: string, to: string): boolean {
  if (from === to) return true
  // 已存在重复边
  const t = nodes[to]?.task
  if (t?.deps?.some((d) => d.from === from)) return true
  // 依赖存的是反向指针（y.deps 指向其前置 x，即前向边 x→y）。
  // 从 to 沿前向邻接表传播，若能到达 from，则再加 from→to 必成环。
  const adj = forwardAdjacency(nodes)
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()
    if (cur === undefined) break
    if (cur === from) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const nexts = adj.get(cur)
    if (nexts) stack.push(...nexts)
  }
  return false
}

/** 条形几何（像素 x / 宽度 / y） */
export function barGeom(task: TaskData, rowY: number, model: GanttModel) {
  const s = task.start
  if (!s) throw new TypeError('甘特条目必须包含开始日期')
  const x = diffDays(model.day0, s) * model.pxPerDay
  if (task.milestone) {
    return { x, y: rowY + 6, size: ROW_H - 12, w: model.pxPerDay, milestone: true as const }
  }
  const days = Math.max(1, diffDays(s, task.end ?? s) + 1)
  return { x, y: rowY + 7, w: days * model.pxPerDay, h: ROW_H - 14, milestone: false as const, days }
}
