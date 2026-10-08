import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneFromTemplate } from './templateClone'
import { buildFixture, simpleFixture } from '../test/fixture'

describe('cloneFromTemplate 模板克隆', () => {
  it('结构与文本一致，但文档/节点 id 全部换新', () => {
    const src = simpleFixture()
    const { doc: dst } = cloneFromTemplate(src)
    expect(dst.id).not.toBe(src.id)
    expect(Object.keys(dst.nodes)).toHaveLength(4)
    for (const oldId of Object.keys(src.nodes)) expect(dst.nodes[oldId]).toBeUndefined()

    const texts = (d: typeof dst) => {
      const out: string[] = []
      const walk = (id: string) => {
        out.push(d.nodes[id].text)
        d.nodes[id].children.forEach(walk)
      }
      walk(d.rootId)
      return out
    }
    expect(texts(dst)).toEqual(texts(src))
  })

  it('parent / children 正确重映射且自洽', () => {
    const { doc: dst } = cloneFromTemplate(simpleFixture())
    for (const n of Object.values(dst.nodes)) {
      if (n.parent) expect(dst.nodes[n.parent].children).toContain(n.id)
      for (const c of n.children) {
        expect(dst.nodes[c].parent).toBe(n.id)
      }
    }
  })

  it('task.deps 引用同步重映射，不悬空', () => {
    const src = buildFixture({
      text: 'root',
      children: [
        { text: 'a', task: { start: '2026-09-01', end: '2026-09-03', progress: 0 } },
        { text: 'b', task: { start: '2026-09-04', end: '2026-09-05', progress: 0, deps: [] } },
      ],
    })
    // 手工让 b 依赖 a
    const root = src.rootId
    const a = src.nodes[root].children[0]
    const b = src.nodes[root].children[1]
    src.nodes[b].task!.deps = [{ from: a, type: 'FS' }]

    const { doc: dst } = cloneFromTemplate(src)
    const a2 = dst.nodes[dst.rootId].children[0]
    const b2 = dst.nodes[dst.rootId].children[1]
    expect(dst.nodes[b2].task!.deps).toEqual([{ from: a2, type: 'FS' }])
    expect(dst.nodes[a2]).toBeDefined()
  })

  it('折叠重置为展开，时间戳刷新为数字', () => {
    const src = buildFixture({ text: 'root', collapsed: true, children: [{ text: 'a' }] })
    const { doc: dst } = cloneFromTemplate(src)
    expect(dst.nodes[dst.rootId].collapsed).toBe(false)
    expect(dst.createdAt).toBeTypeOf('number')
    expect(dst.updatedAt).toBeTypeOf('number')
    expect(dst.version).toBe(3)
  })

  it('不修改源文档', () => {
    const src = simpleFixture()
    const snapshot = JSON.stringify(src)
    cloneFromTemplate(src)
    expect(JSON.stringify(src)).toBe(snapshot)
  })

  it('无 randomUUID 环境时走 Math.random 兜底 id', () => {
    vi.stubGlobal('crypto', {})
    const { doc: dst } = cloneFromTemplate(simpleFixture())
    expect(dst.id).toBeTruthy()
    expect(dst.id).not.toMatch(/^-?$/)
    expect(Object.keys(dst.nodes)).toHaveLength(4)
    vi.unstubAllGlobals()
  })

  it('M7-P3：图片/附件 blobId 同步重映射到 blobMap', () => {
    const src = buildFixture({
      text: 'root',
      children: [{ text: 'with-image' }],
    })
    const childId = src.nodes[src.rootId].children[0]
    src.nodes[childId].images = [{ id: 'i1', blobId: 'b1', w: 10, h: 10 }]
    src.nodes[childId].attachments = [
      { id: 'a1', blobId: 'b2', name: 'f.bin', size: 1, mime: 'application/octet-stream' },
    ]
    const result = cloneFromTemplate(src)
    const clonedChild = result.doc.nodes[result.doc.rootId].children[0]
    // 源节点不应被改写
    expect(src.nodes[childId].images![0].blobId).toBe('b1')
    // blobMap 应记录旧→新映射
    expect(result.blobMap.has('b1')).toBe(true)
    expect(result.blobMap.has('b2')).toBe(true)
    // 克隆节点的 blobId 已重映射且不等于旧值
    const cloned = result.doc.nodes[clonedChild]
    expect(cloned.images![0].blobId).not.toBe('b1')
    expect(cloned.images![0].blobId).toBe(result.blobMap.get('b1'))
    expect(cloned.attachments![0].blobId).toBe(result.blobMap.get('b2'))
  })

  afterEach(() => vi.unstubAllGlobals())
})
