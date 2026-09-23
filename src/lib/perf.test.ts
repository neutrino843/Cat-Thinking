import { describe, expect, it } from 'vitest'
import { computeLayout } from './layout'
import { computeGantt } from './gantt'
import { addDays, todayISO } from './date'
import type { DocData, MindNodeData } from '../types'

/** 生成 N 个节点的宽树：每个节点 ~3 个子节点，直到超额 */
function bigDoc(target: number, withTasks: boolean): DocData {
  const nodes: Record<string, MindNodeData> = {}
  let seq = 0
  const mk = (parent: string | null, depth: number): string => {
    if (seq >= target) return ''
    const id = 'x' + seq++
    const t = todayISO()
    nodes[id] = {
      id,
      parent,
      children: [],
      text: '节点' + id,
      ...(withTasks && seq % 7 === 0
        ? { task: { start: addDays(t, seq % 30), end: addDays(t, (seq % 30) + 3), progress: 0.5 } }
        : {}),
    }
    if (parent) nodes[parent].children.push(id)
    if (depth < 6) {
      const childCount = seq < target ? 3 : 0
      for (let i = 0; i < childCount; i++) {
        const c = mk(id, depth + 1)
        if (!c) break
      }
    }
    return id
  }
  const rootId = mk(null, 0)
  const now = Date.now()
  return { version: 1, id: 'big', title: '性能', rootId, layout: 'logic', nodes, createdAt: now, updatedAt: now }
}

describe('性能：大图（PRD 目标 1000+ 节点）', () => {
  it('1000 节点逻辑布局 < 200ms', () => {
    const doc = bigDoc(1050, false)
    expect(Object.keys(doc.nodes).length).toBeGreaterThan(1000)
    const t0 = performance.now()
    const r = computeLayout(doc)
    const ms = performance.now() - t0
    console.log(`[perf] layout ${Object.keys(doc.nodes).length} 节点耗时 ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(200)
    expect(r.nodes.size).toBe(Object.keys(doc.nodes).length)
  })

  it('1000 节点连续布局 5 次无累计劣化', () => {
    const doc = bigDoc(1050, false)
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      computeLayout(doc)
      times.push(performance.now() - t0)
    }
    console.log(`[perf] 5 次布局耗时 ${times.map((t) => t.toFixed(1)).join(', ')}ms`)
    expect(times[4]).toBeLessThan(times[0] * 2 + 50)
  })

  it('1000 节点甘特模型 < 200ms（约 1/7 节点为任务）', () => {
    const doc = bigDoc(1050, true)
    const t0 = performance.now()
    const m = computeGantt(doc, 'day')
    const ms = performance.now() - t0
    const taskRows = m.rows.filter((r) => r.task).length
    console.log(`[perf] gantt ${taskRows} 任务 / ${m.rows.length} 行，耗时 ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(200)
    expect(taskRows).toBeGreaterThan(100)
  })
})
