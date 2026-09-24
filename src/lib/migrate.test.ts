import { describe, expect, it } from 'vitest'
import { migrateDoc, isV2 } from './migrate'
import type { DocData, DocDataV1, MindNodeData } from '../types'

/** 构建一个 v1 文档用于迁移测试 */
function v1Doc(opts?: {
  href?: string
  note?: string
  text?: string
}): DocDataV1 {
  const root: MindNodeData = {
    id: 'root',
    parent: null,
    children: ['c1'],
    text: opts?.text ?? '根节点',
    ...(opts?.href ? { href: opts.href } : {}),
    ...(opts?.note ? { note: opts.note } : {}),
  }
  const c1: MindNodeData = {
    id: 'c1',
    parent: 'root',
    children: [],
    text: '子节点',
  }
  return {
    version: 1,
    id: 'test-doc',
    title: '测试文档',
    rootId: 'root',
    layout: 'logic',
    nodes: { root, c1 },
    createdAt: 1000,
    updatedAt: 2000,
  }
}

describe('migrateDoc', () => {
  it('version=1 的文档迁移后 version=2', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    expect(m.version).toBe(2)
  })

  it('已是 v2 的文档浅拷贝原样返回，不修改', () => {
    const doc: DocData = {
      version: 2,
      id: 'd2',
      title: 'T',
      rootId: 'r',
      layout: 'logic',
      nodes: { r: { id: 'r', parent: null, children: [], text: 'r' } },
      createdAt: 1,
      updatedAt: 2,
    }
    const m = migrateDoc(doc)
    expect(m.version).toBe(2)
    expect(m).not.toBe(doc) // 浅拷贝
    expect(m.nodes).toEqual(doc.nodes)
  })

  it('v1 href 迁移为 links[0] { kind:url, url:href }', () => {
    const doc = v1Doc({ href: 'https://example.com' })
    const m = migrateDoc(doc)
    const root = m.nodes['root']
    expect(root.links).toBeDefined()
    expect(root.links!).toHaveLength(1)
    expect(root.links![0].kind).toBe('url')
    expect(root.links![0].url).toBe('https://example.com')
    expect(root.links![0].id).toBeTruthy() // uuid 已生成
    // 旧 href 不清空（兼容旧读取方）
    expect(root.href).toBe('https://example.com')
  })

  it('v1 无 href 的节点不补 links', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    expect(m.nodes['root'].links).toBeUndefined()
    expect(m.nodes['c1'].links).toBeUndefined()
  })

  it('v1 note 迁移为 richNote.html（HTML 特殊字符转义）', () => {
    const doc = v1Doc({ note: 'a<b>c & d' })
    const m = migrateDoc(doc)
    const root = m.nodes['root']
    expect(root.richNote).toBeDefined()
    expect(root.richNote!.html).toBe('a&lt;b&gt;c &amp; d')
  })

  it('v1 无 note 的节点不补 richNote', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    expect(m.nodes['root'].richNote).toBeUndefined()
  })

  it('迁移后 v2 新字段（tags/icons/images/attachments）不补，undefined 即无', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    for (const n of Object.values(m.nodes)) {
      expect(n.tags).toBeUndefined()
      expect(n.icons).toBeUndefined()
      expect(n.images).toBeUndefined()
      expect(n.attachments).toBeUndefined()
    }
  })

  it('迁移不改 id/title/rootId/layout/createdAt/updatedAt', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    expect(m.id).toBe(doc.id)
    expect(m.title).toBe(doc.title)
    expect(m.rootId).toBe(doc.rootId)
    expect(m.layout).toBe(doc.layout)
    expect(m.createdAt).toBe(doc.createdAt)
    expect(m.updatedAt).toBe(doc.updatedAt)
  })

  it('迁移不丢子节点关系（children 保留）', () => {
    const doc = v1Doc()
    const m = migrateDoc(doc)
    expect(m.nodes['root'].children).toEqual(['c1'])
    expect(m.nodes['c1'].parent).toBe('root')
  })

  it('多个节点有 href 和 note 各自独立迁移', () => {
    const doc = v1Doc({ href: 'https://a.com', note: 'note-a' })
    doc.nodes['c1'] = {
      ...doc.nodes['c1'],
      href: 'https://b.com',
      note: 'note-b',
    }
    const m = migrateDoc(doc)
    expect(m.nodes['root'].links![0].url).toBe('https://a.com')
    expect(m.nodes['root'].richNote!.html).toBe('note-a')
    expect(m.nodes['c1'].links![0].url).toBe('https://b.com')
    expect(m.nodes['c1'].richNote!.html).toBe('note-b')
    // link id 各不相同
    expect(m.nodes['root'].links![0].id).not.toBe(m.nodes['c1'].links![0].id)
  })
})

describe('isV2', () => {
  it('version=2 返回 true', () => {
    expect(isV2({ version: 2 })).toBe(true)
  })
  it('version=1 返回 false', () => {
    expect(isV2({ version: 1 })).toBe(false)
  })
  it('version=0 返回 false', () => {
    expect(isV2({ version: 0 })).toBe(false)
  })
})
