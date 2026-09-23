import { describe, expect, it } from 'vitest'
import { barGeom, computeGantt, depEdges, ROW_H, SCALE_PX, wouldCreateCycle } from '../lib/gantt'
import { addDays, diffDays, todayISO } from '../lib/date'
import { buildFixture } from '../test/fixture'

const today = todayISO()

function ganttFixture() {
  return buildFixture({
    children: [
      { text: '任务A', task: { start: today, end: addDays(today, 2), progress: 0.5 } },
      {
        text: '任务B',
        task: { start: addDays(today, 3), end: addDays(today, 5), progress: 0, deps: [{ from: '__A__', type: 'FS' }] },
      },
      { text: '里程碑', task: { milestone: true, start: addDays(today, 6) } },
      { text: '普通节点' },
    ],
  })
}

/** 把 __A__ 占位替换为真实 id */
function resolveFixture() {
  const doc = ganttFixture()
  const aId = doc.nodes[doc.rootId].children[0]
  const bId = doc.nodes[doc.rootId].children[1]
  doc.nodes[bId].task!.deps = [{ from: aId, type: 'FS' }]
  return { doc, aId, bId, mId: doc.nodes[doc.rootId].children[2] }
}

describe('甘特模型', () => {
  it('行按 DFS 顺序排列且行高固定', () => {
    const { doc } = resolveFixture()
    const m = computeGantt(doc, 'day')
    expect(m.rows.map((r) => r.id)).toEqual([
      doc.rootId,
      ...doc.nodes[doc.rootId].children,
    ])
    expect(m.rows[1].y - m.rows[0].y).toBe(ROW_H)
  })

  it('时间范围覆盖最早开始到最晚结束并留白，今日线在范围内', () => {
    const { doc } = resolveFixture()
    const m = computeGantt(doc, 'day')
    expect(diffDays(m.day0, today)).toBe(3)
    expect(m.dayCount).toBeGreaterThanOrEqual(diffDays(today, addDays(today, 6)) + 9)
    expect(m.todayOffset).toBe(3)
    expect(m.pxPerDay).toBe(SCALE_PX.day)
    expect(m.width).toBe(m.dayCount * SCALE_PX.day)
  })

  it('无任务时返回默认范围，不崩溃', () => {
    const doc = buildFixture({ children: [{ text: 'x' }] })
    const m = computeGantt(doc, 'week')
    expect(m.rows.length).toBe(2)
    expect(m.dayCount).toBeGreaterThanOrEqual(14)
    expect(m.pxPerDay).toBe(SCALE_PX.week)
  })

  it('barGeom：普通任务条宽 = 工期*pxPerDay，里程碑为方形', () => {
    const { doc, aId, mId } = resolveFixture()
    const m = computeGantt(doc, 'day')
    const ra = m.rows.find((r) => r.id === aId)!
    const ga = barGeom(ra.task!, ra.y, m)
    expect(ga.milestone).toBe(false)
    if (!ga.milestone) expect(ga.w).toBe(3 * SCALE_PX.day)
    const rm = m.rows.find((r) => r.id === mId)!
    const gm = barGeom(rm.task!, rm.y, m)
    expect(gm.milestone).toBe(true)
    if (gm.milestone) expect(gm.size).toBe(ROW_H - 12)
  })

  it('depEdges 只输出双方都是任务的依赖', () => {
    const { doc, aId, bId } = resolveFixture()
    const edges = depEdges(doc)
    expect(edges).toEqual([{ from: aId, to: bId }])
  })

  it('wouldCreateCycle：重复边、自环、反向成环均拒绝', () => {
    const { doc, aId, bId } = resolveFixture()
    expect(wouldCreateCycle(doc.nodes, aId, bId)).toBe(true) // 已存在
    expect(wouldCreateCycle(doc.nodes, aId, aId)).toBe(true) // 自环
    expect(wouldCreateCycle(doc.nodes, bId, aId)).toBe(true) // a 依赖 b 后再 b→a 成环
    const cId = doc.nodes[doc.rootId].children[3]
    expect(wouldCreateCycle(doc.nodes, aId, cId)).toBe(false) // 新边合法
  })
})
