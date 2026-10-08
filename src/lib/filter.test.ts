import { describe, expect, it } from 'vitest'
import type { DocData } from '../types'
import { simpleFixture } from '../test/fixture'
import {
  applyFilter,
  collectTagTexts,
  computeFilter,
  emptyFilter,
  isFilterActive,
  nodeMatches,
  nodeStatus,
  type NodeFilter,
} from './filter'

/** simpleFixture：root → a → a1；root → b。返回各节点引用 */
function tree() {
  const d = simpleFixture()
  const root = d.rootId
  const a = d.nodes[root].children[0]
  const b = d.nodes[root].children[1]
  const a1 = d.nodes[a].children[0]
  return { d, root, a, b, a1 }
}

const tag = (text: string, color = 'blue') => ({ id: 't-' + text, text, color })

describe('filter 基础判定', () => {
  it('emptyFilter 未激活', () => {
    expect(isFilterActive(emptyFilter)).toBe(false)
    expect(isFilterActive({ tag: 'x', status: '' })).toBe(true)
    expect(isFilterActive({ tag: '', status: 'done' })).toBe(true)
  })

  it('nodeStatus：里程碑优先，其次 done/doing/todo；缺省 task 即 todo', () => {
    const t = tree()
    expect(t.d.nodes[t.a1].task).toBeUndefined()
    expect(nodeStatus(t.d.nodes[t.a1])).toBe('todo')
    t.d.nodes[t.a1].task = { progress: 0.5 }
    expect(nodeStatus(t.d.nodes[t.a1])).toBe('doing')
    t.d.nodes[t.a1].task = { progress: 1 }
    expect(nodeStatus(t.d.nodes[t.a1])).toBe('done')
    // 里程碑即使 progress=1 也判里程碑
    t.d.nodes[t.a1].task = { progress: 1, milestone: true }
    expect(nodeStatus(t.d.nodes[t.a1])).toBe('milestone')
  })

  it('nodeMatches：标签与状态 AND 组合', () => {
    const t = tree()
    t.d.nodes[t.a1].tags = [tag('重点')]
    t.d.nodes[t.a1].task = { progress: 0.3 }
    expect(nodeMatches(t.d.nodes[t.a1], { tag: '重点', status: '' })).toBe(true)
    expect(nodeMatches(t.d.nodes[t.a1], { tag: '没有', status: '' })).toBe(false)
    expect(nodeMatches(t.d.nodes[t.a1], { tag: '', status: 'doing' })).toBe(true)
    expect(nodeMatches(t.d.nodes[t.a1], { tag: '重点', status: 'done' })).toBe(false)
    // 其他节点不带标签
    expect(nodeMatches(t.d.nodes[t.a], { tag: '重点', status: '' })).toBe(false)
  })
})

describe('computeFilter 命中分支集合', () => {
  it('命中深层节点时保留全部祖先链，排除无关分支', () => {
    const t = tree()
    t.d.nodes[t.a1].tags = [tag('重点')]
    const { shown, expand } = computeFilter(t.d, { tag: '重点', status: '' })
    expect([...shown].sort()).toEqual([t.root, t.a, t.a1].sort())
    expect(shown.has(t.b)).toBe(false)
    expect(expand.size).toBe(0)
  })

  it('根始终保留；空命中结果只剩根', () => {
    const t = tree()
    const r = computeFilter(t.d, { tag: '不存在', status: '' })
    expect([...r.shown]).toEqual([t.root])
  })

  it('路径上折叠的节点进入 expand 集合', () => {
    const t = tree()
    t.d.nodes[t.a].collapsed = true
    t.d.nodes[t.a1].task = { progress: 1 }
    const { shown, expand } = computeFilter(t.d, { tag: '', status: 'done' })
    expect(shown.has(t.a)).toBe(true)
    expect(expand.has(t.a)).toBe(true)
  })

  it('状态过滤：里程碑', () => {
    const t = tree()
    t.d.nodes[t.b].task = { milestone: true }
    const { shown } = computeFilter(t.d, { tag: '', status: 'milestone' })
    expect([...shown].sort()).toEqual([t.root, t.b].sort())
  })
})

describe('applyFilter 派生裁剪文档', () => {
  it('未激活返回 null', () => {
    const t = tree()
    expect(applyFilter(t.d, emptyFilter)).toBeNull()
  })

  it('裁剪 children、临时展开折叠节点，且不改动原文档', () => {
    const t = tree()
    t.d.nodes[t.a].collapsed = true
    t.d.nodes[t.a1].tags = [tag('重点')]
    const f: NodeFilter = { tag: '重点', status: '' }
    const out = applyFilter(t.d, f) as DocData
    expect(out).not.toBeNull()
    // 原文档不被修改
    expect(t.d.nodes[t.a].collapsed).toBe(true)
    expect(t.d.nodes[t.root].children).toEqual(expect.arrayContaining([t.a, t.b]))
    // 派生文档：root 只剩 a；a 在视图层展开
    expect(out.nodes[t.root].children).toEqual([t.a])
    expect(out.nodes[t.a].children).toEqual([t.a1])
    expect(out.nodes[t.a].collapsed).toBe(false)
    expect(out.nodes[t.b]).toBeUndefined()
    // 派生节点是副本
    expect(out.nodes[t.a]).not.toBe(t.d.nodes[t.a])
  })

  it('关系线/概要/边界框同步按可见成员裁剪', () => {
    const t = tree()
    t.d.nodes[t.a1].tags = [tag('重点')]
    t.d.relations = [
      { id: 'r1', from: t.a1, to: t.b }, // b 隐藏 → 剔除
      { id: 'r2', from: t.root, to: t.a1 }, // 两端可见 → 保留
    ]
    t.d.summaries = [{ id: 's1', members: [t.a, t.b] }] // 裁剪后只剩 a
    t.d.boundaryBoxes = [
      { id: 'box1', members: [t.b] }, // 裁剪后为空 → 整条剔除
      { id: 'box2', members: [t.a, t.a1] },
    ]
    const out = applyFilter(t.d, { tag: '重点', status: '' }) as DocData
    expect(out.relations?.map((r) => r.id)).toEqual(['r2'])
    expect(out.summaries?.map((s) => s.id)).toEqual(['s1'])
    expect(out.summaries?.[0].members).toEqual([t.a])
    expect(out.boundaryBoxes?.map((b) => b.id)).toEqual(['box2'])
  })
})

describe('collectTagTexts', () => {
  it('去重并保持首次出现顺序', () => {
    const t = tree()
    t.d.nodes[t.a].tags = [tag('红'), tag('蓝')]
    t.d.nodes[t.a1].tags = [tag('蓝'), tag('绿')]
    t.d.nodes[t.b].tags = [tag('红')]
    expect(collectTagTexts(t.d)).toEqual(['红', '蓝', '绿'])
  })

  it('无标签返回空数组', () => {
    expect(collectTagTexts(tree().d)).toEqual([])
  })
})
