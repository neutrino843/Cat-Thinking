import { describe, expect, it } from 'vitest'
import type { DocData } from '../types'
import { computeLayout } from '../lib/layout'
import { simpleFixture, buildFixture } from '../test/fixture'

describe('布局算法', () => {
  it('logic：根在左、全部子节点在右侧且无重叠', () => {
    const doc = simpleFixture('logic')
    const r = computeLayout(doc)
    expect(r.nodes.size).toBe(4)
    const root = r.nodes.get(doc.rootId)!
    for (const [id, n] of r.nodes) {
      if (id === doc.rootId) continue
      expect(n.x).toBeGreaterThan(root.x + root.w)
      expect(n.side).toBe(1)
    }
    // 边数 = 非根节点数，其中根 → 一级分支两条
    expect(r.edges.length).toBe(3)
    expect(r.edges.filter((e) => e.from === doc.rootId).map((e) => e.to).sort()).toEqual(
      doc.nodes[doc.rootId].children.slice().sort(),
    )
    // 边界包含所有节点
    for (const n of r.nodes.values()) {
      expect(n.x).toBeGreaterThanOrEqual(r.bounds.x - 0.01)
      expect(n.y).toBeGreaterThanOrEqual(r.bounds.y - 0.01)
      expect(n.x + n.w).toBeLessThanOrEqual(r.bounds.x + r.bounds.w + 0.01)
      expect(n.y + n.h).toBeLessThanOrEqual(r.bounds.y + r.bounds.h + 0.01)
    }
    // 兄弟节点垂直不重叠
    const laid = [...r.nodes.values()].filter((n) => n.level === 1)
    for (let i = 0; i < laid.length - 1; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        const a = laid[i]
        const b = laid[j]
        const overlap = !(a.y + a.h <= b.y || b.y + b.h <= a.y)
        expect(overlap).toBe(false)
      }
    }
  })

  it('tree：多分支时左右两侧都有节点', () => {
    const doc = buildFixture({
      children: [{ text: 'c1' }, { text: 'c2' }, { text: 'c3' }, { text: 'c4' }],
    }, 'tree')
    const r = computeLayout(doc)
    const root = r.nodes.get(doc.rootId)!
    const sides = new Set(
      [...r.nodes.values()].filter((n) => n.level === 1).map((n) => (n.x < root.x ? -1 : 1)),
    )
    expect(sides.has(-1)).toBe(true)
    expect(sides.has(1)).toBe(true)
  })

  it('折叠：隐藏后代不参与布局且 hidden 计数正确', () => {
    const doc = simpleFixture('logic')
    const a = doc.nodes[doc.rootId].children[0]
    doc.nodes[a].collapsed = true
    const r = computeLayout(doc)
    const a1 = doc.nodes[a].children[0]
    expect(r.nodes.has(a1)).toBe(false)
    expect(r.nodes.get(a)!.hidden).toBe(1)
    expect(r.nodes.get(a)!.collapsed).toBe(true)
    // 折叠节点的出边不绘制
    expect(r.edges.some((e) => e.from === a)).toBe(false)
  })

  it('根子节点分配轮转分支色', () => {
    const doc = buildFixture({
      children: [{ children: [{ text: 'x' }] }, { text: 'c2' }],
    })
    const r = computeLayout(doc)
    const [c1, c2] = doc.nodes[doc.rootId].children
    expect(r.nodes.get(c1)!.color).toBe('b0')
    expect(r.nodes.get(c2)!.color).toBe('b1')
    // 孙节点继承分支色
    const grand = doc.nodes[c1].children[0]
    expect(r.nodes.get(grand)!.color).toBe('b0')
  })

  it('M11：节点显式 color 优先于轮转色，子孙继承钉住色（四种分支布局）', () => {
    for (const layout of ['logic', 'tree', 'org', 'fishbone'] as const) {
      const doc = buildFixture({
        children: [{ children: [{ text: 'x' }] }, { text: 'c2' }],
      }, layout)
      const [c1, c2] = doc.nodes[doc.rootId].children
      doc.nodes[c1].color = 'b4' // 钉住：无视位置轮转（c1 本应 b0）
      const r = computeLayout(doc)
      const grand = doc.nodes[c1].children[0]
      expect(r.nodes.get(c1)!.color, `一级分支 @${layout}`).toBe('b4')
      expect(r.nodes.get(grand)!.color, `子孙继承 @${layout}`).toBe('b4')
      // 未钉色的兄弟仍按位置轮转
      expect(r.nodes.get(c2)!.color, `兄弟轮转 @${layout}`).toBe('b1')
      // 钉色一级边也用该色（取边的 color 字段）
      const rootEdge = r.edges.find((e) => e.from === doc.rootId && e.to === c1)
      expect(rootEdge?.color, `一级边色 @${layout}`).toBe('b4')
    }
  })

  it('M11：timeline 节点显式 color 透出，未钉色为空串', () => {
    const doc = buildFixture({
      children: [{ text: 'c1' }, { text: 'c2' }],
    }, 'timeline')
    const [c1, c2] = doc.nodes[doc.rootId].children
    doc.nodes[c1].color = 'b2'
    const r = computeLayout(doc)
    expect(r.nodes.get(c1)!.color).toBe('b2')
    expect(r.nodes.get(c2)!.color).toBe('')
  })

  it('空树不崩溃，返回兜底边界', () => {
    const r = computeLayout(simpleFixture())
    expect(r.bounds.w).toBeGreaterThan(0)
    expect(r.bounds.h).toBeGreaterThan(0)
  })

  /* ---------- M7-P4 新布局 ---------- */

  it('org：根在顶部、所有子节点向下展开、同层水平排布', () => {
    const doc = simpleFixture('org')
    const r = computeLayout(doc)
    const root = r.nodes.get(doc.rootId)!
    // 所有非根节点 y 严格大于根 y（向下展开）
    for (const [id, n] of r.nodes) {
      if (id === doc.rootId) continue
      expect(n.y).toBeGreaterThan(root.y)
    }
    // 一级分支（a、b）同 y（同层）
    const a = doc.nodes[doc.rootId].children[0]
    const b = doc.nodes[doc.rootId].children[1]
    expect(r.nodes.get(a)!.y).toBe(r.nodes.get(b)!.y)
    // 根居中：cx=0 → root.x = -root.w/2
    expect(root.x).toBeCloseTo(-root.w / 2, 5)
    // 兄弟 x 区间不重叠
    const la = [a, b].map((id) => r.nodes.get(id)!)
    expect(la[0].x + la[0].w).toBeLessThanOrEqual(la[1].x)
  })

  it('fishbone：根在最左、一级分支 y 上下交替', () => {
    const doc = simpleFixture('fishbone')
    const r = computeLayout(doc)
    const root = r.nodes.get(doc.rootId)!
    const SPINE_Y = root.h / 2
    // 根 x 最小（所有节点 x >= root.x）
    for (const n of r.nodes.values()) {
      expect(n.x).toBeGreaterThanOrEqual(root.x)
    }
    // 一级分支 y 上下交替：一个在脊线上、一个在下
    const [a, b] = doc.nodes[doc.rootId].children
    const ay = r.nodes.get(a)!.y
    const by = r.nodes.get(b)!.y
    expect(ay).toBeLessThan(SPINE_Y) // 上斜
    expect(by).toBeGreaterThan(SPINE_Y) // 下斜
    // 一级分支 side 上下相反
    expect(r.nodes.get(a)!.side).toBe(-1)
    expect(r.nodes.get(b)!.side).toBe(1)
  })

  it('timeline：无 task 时按 DFS 序兜底、上下交错', () => {
    const doc = simpleFixture('timeline')
    const r = computeLayout(doc)
    // DFS 序：a → a1 → b（simpleFixture 结构）
    const [a, b] = doc.nodes[doc.rootId].children
    const a1 = doc.nodes[a].children[0]
    const na = r.nodes.get(a)!
    const na1 = r.nodes.get(a1)!
    const nb = r.nodes.get(b)!
    // x 严格递增（按 DFS 序）
    expect(na.x).toBeLessThan(na1.x)
    expect(na1.x).toBeLessThan(nb.x)
    // 上下交错：side 集合含 1 与 -1
    const sides = new Set([na.side, na1.side, nb.side])
    expect(sides.has(1)).toBe(true)
    expect(sides.has(-1)).toBe(true)
    // 所有非根节点 level=1（扁平化）
    for (const [id, n] of r.nodes) {
      if (id === doc.rootId) continue
      expect(n.level).toBe(1)
    }
  })

  it('timeline：有 task.start 时按日期排序', () => {
    const doc = buildFixture(
      {
        text: 'root',
        children: [
          { text: 'late', task: { start: '2026-12-31' } },
          { text: 'early', task: { start: '2026-01-01' } },
          { text: 'mid', task: { start: '2026-06-15' } },
        ],
      },
      'timeline',
    )
    const r = computeLayout(doc)
    const [late, early, mid] = doc.nodes[doc.rootId].children
    const nEarly = r.nodes.get(early)!
    const nMid = r.nodes.get(mid)!
    const nLate = r.nodes.get(late)!
    expect(nEarly.x).toBeLessThan(nMid.x)
    expect(nMid.x).toBeLessThan(nLate.x)
  })

  it('节点数守恒：同一文档五种布局返回相同 nodes.size', () => {
    const layouts: DocData['layout'][] = ['logic', 'tree', 'org', 'fishbone', 'timeline']
    const sizes = layouts.map((l) => computeLayout(simpleFixture(l)).nodes.size)
    // simpleFixture 4 个节点（root/a/a1/b），无折叠
    expect(new Set(sizes).size).toBe(1)
    expect(sizes[0]).toBe(4)
  })

  it('三新布局：bounds 包含所有节点、兄弟节点不重叠', () => {
    const layouts: DocData['layout'][] = ['org', 'fishbone', 'timeline']
    for (const l of layouts) {
      const doc = simpleFixture(l)
      const r = computeLayout(doc)
      // bounds 包含所有节点
      for (const n of r.nodes.values()) {
        expect(n.x).toBeGreaterThanOrEqual(r.bounds.x - 0.01)
        expect(n.y).toBeGreaterThanOrEqual(r.bounds.y - 0.01)
        expect(n.x + n.w).toBeLessThanOrEqual(r.bounds.x + r.bounds.w + 0.01)
        expect(n.y + n.h).toBeLessThanOrEqual(r.bounds.y + r.bounds.h + 0.01)
      }
      // 一级兄弟节点不重叠（org/fishbone 同层；timeline 上下交错天然不重叠）
      if (l !== 'timeline') {
        const [a, b] = doc.nodes[doc.rootId].children
        const na = r.nodes.get(a)!
        const nb = r.nodes.get(b)!
        const overlap = !(na.x + na.w <= nb.x || nb.x + nb.w <= na.x)
        expect(overlap).toBe(false)
      }
    }
  })

  it('折叠：org/fishbone/timeline 三布局均正确隐藏后代', () => {
    const layouts: DocData['layout'][] = ['org', 'fishbone', 'timeline']
    for (const l of layouts) {
      const doc = simpleFixture(l)
      const a = doc.nodes[doc.rootId].children[0]
      doc.nodes[a].collapsed = true
      const r = computeLayout(doc)
      const a1 = doc.nodes[a].children[0]
      expect(r.nodes.has(a1)).toBe(false)
      expect(r.nodes.get(a)!.hidden).toBe(1)
      expect(r.nodes.get(a)!.collapsed).toBe(true)
    }
  })
})
