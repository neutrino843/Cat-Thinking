import { describe, expect, it } from 'vitest'
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

  it('空树不崩溃，返回兜底边界', () => {
    const r = computeLayout(simpleFixture())
    expect(r.bounds.w).toBeGreaterThan(0)
    expect(r.bounds.h).toBeGreaterThan(0)
  })
})
