import { describe, expect, it } from 'vitest'
import { barGeom, computeGantt, criticalPath, depEdges, ROW_H, SCALE_PX, wouldCreateCycle } from '../lib/gantt'
import { addDays, diffDays, todayISO } from '../lib/date'
import { buildFixture } from '../test/fixture'
import type { MindNodeData } from '../types'

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

  it('M8-P1（P-3）：千节点长链环检测正确且为 O(V+E)（CI 门线 <50ms）', () => {
    // 构造 0→1→2→…→N-1 的 1050 节点依赖长链
    const N = 1050
    const nodes: Record<string, MindNodeData> = {}
    for (let i = 0; i < N; i++) {
      const id = 'n' + i
      nodes[id] = {
        id,
        parent: i === 0 ? null : 'n' + (i - 1),
        children: i === N - 1 ? [] : ['n' + (i + 1)],
        text: id,
        task: {
          start: '2026-01-01',
          end: '2026-01-02',
          ...(i === 0 ? {} : { deps: [{ from: 'n' + (i - 1), type: 'FS' as const }] }),
        },
      }
    }
    const first = 'n0'
    const last = 'n' + (N - 1)
    const t0 = performance.now()
    const closesLoop = wouldCreateCycle(nodes, last, first) // 末→首 闭环：必成环（遍历整链）
    const t1 = performance.now()
    const forwardOk = wouldCreateCycle(nodes, first, last) // 首→末：链尾无后继，合法
    const dt = t1 - t0
    // 性能日志：C1 证据（目标 ≤1ms，CI 宽松门线 50ms 防抖动误杀）
    console.log(`[M8] wouldCreateCycle 1050 链耗时 ${dt.toFixed(2)}ms`)
    expect(closesLoop).toBe(true)
    expect(forwardOk).toBe(false)
    expect(dt).toBeLessThan(50)
  })
})

describe('M14 关键路径', () => {
  /** 构造 children 为根的直接子节点，返回 doc 与各子 id */
  function chainFixture(children: { text: string; task?: MindNodeData['task'] }[]) {
    const doc = buildFixture({ children })
    const ids = doc.nodes[doc.rootId].children
    return { doc, ids }
  }

  it('无任务时返回空集', () => {
    const { doc } = chainFixture([{ text: 'x' }])
    expect(criticalPath(doc).size).toBe(0)
  })

  it('单个任务自身即关键路径', () => {
    const { doc, ids } = chainFixture([
      { text: 'A', task: { start: '2026-01-01', end: '2026-01-03' } },
    ])
    expect(criticalPath(doc)).toEqual(new Set([ids[0]]))
  })

  it('串行链 A→B→C 全部在关键路径上', () => {
    const { doc, ids } = chainFixture([
      { text: 'A', task: { start: '2026-01-01', end: '2026-01-03' } },
      { text: 'B', task: { start: '2026-01-04', end: '2026-01-06', deps: [{ from: '', type: 'FS' }] } },
      { text: 'C', task: { start: '2026-01-07', end: '2026-01-09', deps: [{ from: '', type: 'FS' }] } },
    ])
    doc.nodes[ids[1]].task!.deps = [{ from: ids[0], type: 'FS' }]
    doc.nodes[ids[2]].task!.deps = [{ from: ids[1], type: 'FS' }]
    expect(criticalPath(doc)).toEqual(new Set(ids))
  })

  it('菱形中较长分支上的节点才在关键路径', () => {
    // A(2d) → B(5d) → D ; A → C(1d) → D ；关键路径 A-B-D（7d），C 不在
    const { doc, ids } = chainFixture([
      { text: 'A', task: { start: '2026-01-01', end: '2026-01-03' } },
      { text: 'B', task: { start: '2026-01-04', end: '2026-01-09', deps: [{ from: '', type: 'FS' }] } },
      { text: 'C', task: { start: '2026-01-04', end: '2026-01-05', deps: [{ from: '', type: 'FS' }] } },
      { text: 'D', task: { start: '2026-01-10', end: '2026-01-11', deps: [{ from: '', type: 'FS' }, { from: '', type: 'FS' }] } },
    ])
    const [a, b, c, d] = ids
    doc.nodes[b].task!.deps = [{ from: a, type: 'FS' }]
    doc.nodes[c].task!.deps = [{ from: a, type: 'FS' }]
    doc.nodes[d].task!.deps = [
      { from: b, type: 'FS' },
      { from: c, type: 'FS' },
    ]
    const cp = criticalPath(doc)
    expect(cp.has(a)).toBe(true)
    expect(cp.has(b)).toBe(true)
    expect(cp.has(c)).toBe(false)
    expect(cp.has(d)).toBe(true)
  })

  it('里程碑工期为 0，不影响关键路径长度判定', () => {
    // A(3d) → M(里程碑,0d) → B(2d) ；三者均在关键路径
    const { doc, ids } = chainFixture([
      { text: 'A', task: { start: '2026-01-01', end: '2026-01-04' } },
      { text: 'M', task: { milestone: true, start: '2026-01-05', deps: [{ from: '', type: 'FS' }] } },
      { text: 'B', task: { start: '2026-01-06', end: '2026-01-08', deps: [{ from: '', type: 'FS' }] } },
    ])
    const [a, m, b] = ids
    doc.nodes[m].task!.deps = [{ from: a, type: 'FS' }]
    doc.nodes[b].task!.deps = [{ from: m, type: 'FS' }]
    expect(criticalPath(doc)).toEqual(new Set([a, m, b]))
  })

  it('两条等长路径时，两条路径上的节点均被标记为关键', () => {
    // A → B(2d) → D ; A → C(2d) → D ；两条路径等长，全部节点关键
    const { doc, ids } = chainFixture([
      { text: 'A', task: { start: '2026-01-01', end: '2026-01-02' } },
      { text: 'B', task: { start: '2026-01-03', end: '2026-01-05', deps: [{ from: '', type: 'FS' }] } },
      { text: 'C', task: { start: '2026-01-03', end: '2026-01-05', deps: [{ from: '', type: 'FS' }] } },
      { text: 'D', task: { start: '2026-01-06', end: '2026-01-07', deps: [{ from: '', type: 'FS' }, { from: '', type: 'FS' }] } },
    ])
    const [a, b, c, d] = ids
    doc.nodes[b].task!.deps = [{ from: a, type: 'FS' }]
    doc.nodes[c].task!.deps = [{ from: a, type: 'FS' }]
    doc.nodes[d].task!.deps = [
      { from: b, type: 'FS' },
      { from: c, type: 'FS' },
    ]
    expect(criticalPath(doc)).toEqual(new Set([a, b, c, d]))
  })
})
