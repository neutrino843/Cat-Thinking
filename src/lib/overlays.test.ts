import { beforeEach, describe, expect, it } from 'vitest'
import { computeLayout, computeRelations, computeSummaries, computeBoxes } from './layout'
import type { LaidNode } from './layout'
import { simpleFixture, buildFixture } from '../test/fixture'
import { useDoc } from '../store/docStore'
import type { Relation, Summary, BoundaryBox } from '../types'

/** 构造测试用 LaidNode */
function mkNode(id: string, x: number, y: number, w = 80, h = 30): LaidNode {
  return { id, x, y, w, h, side: 1, level: 1, color: 'b0', collapsed: false, hasChildren: false, hidden: 0, fontSize: 14, imgH: 0 }
}

/** 构造 [id, LaidNode] 元组用于 Map */
function nodeEntry(id: string, x: number, y: number, w = 80, h = 30): [string, LaidNode] {
  return [id, mkNode(id, x, y, w, h)]
}

describe('M9 computeRelations', () => {
  it('空数组/undefined 返回空', () => {
    expect(computeRelations(undefined, new Map())).toEqual([])
    expect(computeRelations([], new Map())).toEqual([])
  })

  it('两节点间生成贝塞尔曲线 + 箭头 + 标签中点', () => {
    const nodes = new Map<string, LaidNode>([
      nodeEntry('a', 0, 0),
      nodeEntry('b', 200, 100),
    ])
    const rels: Relation[] = [{ id: 'r1', from: 'a', to: 'b', label: '关联' }]
    const out = computeRelations(rels, nodes)
    expect(out).toHaveLength(1)
    const r = out[0]
    expect(r.id).toBe('r1')
    expect(r.label).toBe('关联')
    expect(r.color).toBe('')
    // 8 个点（贝塞尔三次）
    expect(r.points).toHaveLength(8)
    // 起点在 a 节点边缘，终点在 b 节点边缘
    expect(r.points[0]).toBeGreaterThanOrEqual(0)
    expect(r.points[0]).toBeLessThanOrEqual(80)
    expect(r.ax).toBeGreaterThanOrEqual(200)
    expect(r.ax).toBeLessThanOrEqual(280)
    // 箭头角为弧度
    expect(r.angle).toBeGreaterThanOrEqual(-Math.PI)
    expect(r.angle).toBeLessThanOrEqual(Math.PI)
    // 标签在中点附近
    expect(r.lx).toBeGreaterThan(40)
    expect(r.lx).toBeLessThan(240)
  })

  it('from===to 自环跳过', () => {
    const nodes = new Map<string, LaidNode>([nodeEntry('a', 0, 0)])
    const rels: Relation[] = [{ id: 'r1', from: 'a', to: 'a' }]
    expect(computeRelations(rels, nodes)).toEqual([])
  })

  it('from/to 不在布局结果中的悬挂引用跳过', () => {
    const nodes = new Map<string, LaidNode>([nodeEntry('a', 0, 0)])
    const rels: Relation[] = [{ id: 'r1', from: 'a', to: 'ghost' }]
    expect(computeRelations(rels, nodes)).toEqual([])
  })

  it('color 字段传递', () => {
    const nodes = new Map<string, LaidNode>([nodeEntry('a', 0, 0), nodeEntry('b', 200, 0)])
    const rels: Relation[] = [{ id: 'r1', from: 'a', to: 'b', color: 'b1' }]
    const out = computeRelations(rels, nodes)
    expect(out[0].color).toBe('b1')
  })
})

describe('M9 computeSummaries', () => {
  it('空数组/undefined 返回空', () => {
    expect(computeSummaries(undefined, new Map())).toEqual([])
    expect(computeSummaries([], new Map())).toEqual([])
  })

  it('成员 bbox 计算 y 范围与标签位置', () => {
    const nodes = new Map<string, LaidNode>([
      nodeEntry('a', 100, 50),
      nodeEntry('b', 100, 150),
    ])
    const sums: Summary[] = [{ id: 's1', members: ['a', 'b'], label: '概要' }]
    const out = computeSummaries(sums, nodes)
    expect(out).toHaveLength(1)
    const s = out[0]
    expect(s.y1).toBe(50)
    expect(s.y2).toBe(180) // 150 + 30
    expect(s.label).toBe('概要')
    // 标签在 y 中点
    expect(s.ly).toBe((50 + 180) / 2)
  })

  it('成员节点不在布局结果中则跳过', () => {
    const nodes = new Map<string, LaidNode>([nodeEntry('a', 0, 0)])
    const sums: Summary[] = [{ id: 's1', members: ['a', 'ghost'] }]
    const out = computeSummaries(sums, nodes)
    expect(out).toHaveLength(1)
    expect(out[0].y2 - out[0].y1).toBe(30) // 仅 a 一个节点
  })

  it('全部成员不存在则跳过', () => {
    const nodes = new Map<string, LaidNode>()
    const sums: Summary[] = [{ id: 's1', members: ['x', 'y'] }]
    expect(computeSummaries(sums, nodes)).toEqual([])
  })
})

describe('M9 computeBoxes', () => {
  it('空数组/undefined 返回空', () => {
    expect(computeBoxes(undefined, new Map())).toEqual([])
    expect(computeBoxes([], new Map())).toEqual([])
  })

  it('成员 bbox + padding 12px', () => {
    const nodes = new Map<string, LaidNode>([
      nodeEntry('a', 100, 100, 80, 30),
      nodeEntry('b', 200, 200, 60, 40),
    ])
    const boxes: BoundaryBox[] = [{ id: 'bb1', members: ['a', 'b'], label: '框' }]
    const out = computeBoxes(boxes, nodes)
    expect(out).toHaveLength(1)
    const b = out[0]
    // min x=100, max x+ w=260 → x = 100-12=88, w=160+24=184
    expect(b.x).toBe(88)
    expect(b.w).toBe(184)
    // min y=100, max y+h=240 → y=100-12=88, h=140+24=164
    expect(b.y).toBe(88)
    expect(b.h).toBe(164)
    expect(b.label).toBe('框')
  })

  it('全部成员不存在则跳过', () => {
    const nodes = new Map<string, LaidNode>()
    const boxes: BoundaryBox[] = [{ id: 'bb1', members: ['x'] }]
    expect(computeBoxes(boxes, nodes)).toEqual([])
  })
})

describe('M9 computeLayout 集成 overlay', () => {
  it('computeLayout 返回 relations/summaries/boxes 空数组（无 overlay 字段）', () => {
    const r = computeLayout(simpleFixture())
    expect(r.relations).toEqual([])
    expect(r.summaries).toEqual([])
    expect(r.boxes).toEqual([])
  })

  it('带 relations 的文档：computeLayout 正确计算关系线几何', () => {
    const doc = simpleFixture()
    const { a, b } = { a: doc.nodes[doc.rootId].children[0], b: doc.nodes[doc.rootId].children[1] }
    doc.relations = [{ id: 'r1', from: a, to: b, label: '关联' }]
    const r = computeLayout(doc)
    expect(r.relations).toHaveLength(1)
    expect(r.relations[0].label).toBe('关联')
  })
})

describe('M9 docStore 关系表达操作', () => {
  const get = () => useDoc.getState()
  const doc = () => get().doc

  beforeEach(() => {
    get().loadDoc(simpleFixture())
  })

  it('addRelation：成功返回 id；自环/不存在拒绝', () => {
    const { a, b, root } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1], root: doc().rootId }
    const id = get().addRelation(a, b, '关联')
    expect(id).toBeTruthy()
    expect(doc().relations).toHaveLength(1)
    expect(doc().relations![0]).toMatchObject({ from: a, to: b, label: '关联' })

    // 自环拒绝
    get().addRelation(a, a)
    expect(doc().relations).toHaveLength(1)

    // 不存在拒绝
    get().addRelation(a, 'ghost')
    expect(doc().relations).toHaveLength(1)
    void root
  })

  it('updateRelation / removeRelation', () => {
    const { a, b } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1] }
    const id = get().addRelation(a, b)
    get().updateRelation(id, { label: '新标签', color: 'b2' })
    const r = doc().relations!.find((x) => x.id === id)!
    expect(r.label).toBe('新标签')
    expect(r.color).toBe('b2')

    get().removeRelation(id)
    expect(doc().relations).toHaveLength(0)
  })

  it('addSummary / removeSummary', () => {
    const { a, b } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1] }
    const id = get().addSummary([a, b], '总结')
    expect(id).toBeTruthy()
    expect(doc().summaries).toHaveLength(1)
    expect(doc().summaries![0].members).toEqual([a, b])

    get().removeSummary(id)
    expect(doc().summaries).toHaveLength(0)
  })

  it('addBoundaryBox / removeBoundaryBox', () => {
    const { a, b } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1] }
    const id = get().addBoundaryBox([a, b], '区域')
    expect(id).toBeTruthy()
    expect(doc().boundaryBoxes).toHaveLength(1)
    expect(doc().boundaryBoxes![0].label).toBe('区域')

    get().removeBoundaryBox(id)
    expect(doc().boundaryBoxes).toHaveLength(0)
  })

  it('removeNodes 清理悬挂关系线引用', () => {
    const { a, b, a1 } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1], a1: doc().nodes[doc().nodes[doc().rootId].children[0]].children[0] }
    get().addRelation(a, b)
    get().addSummary([a, b])
    get().addBoundaryBox([a, a1])
    expect(doc().relations).toHaveLength(1)

    // 删除 b 后，关系线的 to 悬空 → 被清理
    get().removeNodes([b])
    expect(doc().relations).toHaveLength(0)
    // 概要 members 移除 b
    expect(doc().summaries![0].members).toEqual([a])
    // 边界框成员不含 b，不受影响
    expect(doc().boundaryBoxes![0].members).toEqual([a, a1])
  })

  it('撤销重做覆盖关系表达', () => {
    const { a, b } = { a: doc().nodes[doc().rootId].children[0], b: doc().nodes[doc().rootId].children[1] }
    get().addRelation(a, b, '关联')
    expect(doc().relations).toHaveLength(1)

    get().undo()
    expect(doc().relations).toBeUndefined()

    get().redo()
    expect(doc().relations).toHaveLength(1)
    expect(doc().relations![0].label).toBe('关联')
  })
})

describe('M9 cloneFromTemplate overlay 重映射', () => {
  it('关系线/概要/边界框的 from/to/members 被重映射', async () => {
    const { cloneFromTemplate } = await import('./templateClone')
    const doc = buildFixture({
      text: 'root',
      children: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    })
    const { a, b, c } = { a: doc.nodes[doc.rootId].children[0], b: doc.nodes[doc.rootId].children[1], c: doc.nodes[doc.rootId].children[2] }
    doc.relations = [{ id: 'r1', from: a, to: b }]
    doc.summaries = [{ id: 's1', members: [a, b] }]
    doc.boundaryBoxes = [{ id: 'bb1', members: [a, c] }]

    const { doc: dst } = cloneFromTemplate(doc)
    // overlay 字段存在
    expect(dst.relations).toHaveLength(1)
    expect(dst.summaries).toHaveLength(1)
    expect(dst.boundaryBoxes).toHaveLength(1)
    // from/to 已被重映射为新 id（不等于旧 id）
    expect(dst.relations![0].from).not.toBe(a)
    expect(dst.relations![0].to).not.toBe(b)
    // 新 id 确实存在于 dst.nodes
    expect(dst.nodes[dst.relations![0].from]).toBeDefined()
    expect(dst.nodes[dst.relations![0].to]).toBeDefined()
    // summaries/boxes members 也被重映射
    for (const m of dst.summaries![0].members) expect(dst.nodes[m]).toBeDefined()
    for (const m of dst.boundaryBoxes![0].members) expect(dst.nodes[m]).toBeDefined()
  })
})
