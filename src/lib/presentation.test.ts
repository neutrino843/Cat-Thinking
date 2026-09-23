import { describe, expect, it } from 'vitest'
import { buildSlides, presentDoc } from './presentation'
import { simpleFixture } from '../test/fixture'

describe('presentation 演示幻灯片', () => {
  it('页数等于节点数；首页只有根；末页包含全部节点', () => {
    const doc = simpleFixture()
    const slides = buildSlides(doc)
    expect(slides).toHaveLength(4)
    expect(slides[0]).toMatchObject({ index: 0, total: 4, focusId: doc.rootId })
    expect(slides[0].visible).toEqual([doc.rootId])
    expect(slides[3].visible).toHaveLength(4)
    expect(new Set(slides[3].visible).size).toBe(4)
  })

  it('按先序揭示：父先于子；visible 单调增长', () => {
    const doc = simpleFixture()
    const slides = buildSlides(doc)
    const order = slides.map((s) => s.focusId)
    // root, a, a1, b
    const root = doc.rootId
    const a = doc.nodes[root].children[0]
    const a1 = doc.nodes[a].children[0]
    const b = doc.nodes[root].children[1]
    expect(order).toEqual([root, a, a1, b])
    for (let i = 1; i < slides.length; i++) {
      expect(slides[i].visible.length).toBe(slides[i - 1].visible.length + 1)
    }
  })

  it('presentDoc 只含可见节点且根仍连通；折叠被忽略（全部展开）', () => {
    const doc = simpleFixture()
    doc.nodes[doc.rootId].collapsed = true
    const p = presentDoc(doc, 1) // root + a
    expect(Object.keys(p.nodes).sort()).toEqual([doc.rootId, doc.nodes[doc.rootId].children[0]].sort())
    // 根的 children 只保留可见的 a，b 被裁剪
    const a = doc.nodes[doc.rootId].children[0]
    expect(p.nodes[doc.rootId].children).toEqual([a])
    expect(p.nodes[doc.rootId].collapsed).toBe(false)
    // a 的子 a1 不可见 → a.children 为空
    expect(p.nodes[a].children).toEqual([])
  })

  it('presentDoc 不修改输入文档（节点引用/结构保持）', () => {
    const doc = simpleFixture()
    const beforeRoot = doc.nodes[doc.rootId]
    const beforeChildren = beforeRoot.children
    presentDoc(doc, 2)
    expect(doc.nodes[doc.rootId]).toBe(beforeRoot)
    expect(doc.nodes[doc.rootId].children).toBe(beforeChildren)
  })

  it('slideIndex 越界时钳制到首页/末页', () => {
    const doc = simpleFixture()
    expect(Object.keys(presentDoc(doc, -5).nodes)).toHaveLength(1)
    expect(Object.keys(presentDoc(doc, 999).nodes)).toHaveLength(4)
  })

  it('根节点缺失时返回空节点集（防御）', () => {
    const doc = { ...simpleFixture(), rootId: 'ghost', nodes: {} }
    expect(buildSlides(doc)).toHaveLength(0)
    expect(presentDoc(doc, 0).nodes).toEqual({})
  })
})
