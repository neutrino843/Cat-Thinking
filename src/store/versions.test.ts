import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('dexie', () => {
  class FakeTable {
    rows: any[] = []
    constructor(public name: string) {}
    private key(row: any) {
      return row[this.name === 'analysisTasks' || this.name === 'fileHandles' ? 'docId' : this.name === 'applicationReceipts' ? 'applicationIntentId' : 'id']
    }

    async put(row: any) {
      const idx = this.rows.findIndex((r) => this.key(r) === this.key(row))
      if (idx >= 0) this.rows[idx] = row
      else this.rows.push(row)
      return this.key(row)
    }

    async bulkPut(rows: any[]) {
      for (const row of rows) await this.put(row)
    }

    async get(id: string) {
      return this.rows.find((r) => this.key(r) === id) ?? undefined
    }

    async delete(id: string) {
      const idx = this.rows.findIndex((r) => this.key(r) === id)
      if (idx >= 0) this.rows.splice(idx, 1)
    }

    async bulkDelete(ids: string[]) {
      this.rows = this.rows.filter((r) => !ids.includes(r.id))
    }

    async toArray() {
      return [...this.rows]
    }

    async clear() {
      this.rows = []
    }

    where(field: string) {
      return {
        equals: (val: any) => {
          const matched = this.rows.filter((r) => r[field] === val)
          return {
            async sortBy(key: string) {
              return [...matched].sort((a, b) =>
                a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1,
              )
            },
            async toArray() {
              return [...matched]
            },
            async first() {
              return matched[0]
            },
            async primaryKeys() {
              return matched.map((r) => r.id)
            },
            delete: async () => {
              this.rows = this.rows.filter((r) => r[field] !== val)
            },
          }
        },
        below: (cutoff: number) => {
          const matched = this.rows.filter((r) => r[field] < cutoff)
          return {
            async toArray() {
              return [...matched]
            },
          }
        },
      }
    }
  }

  class FakeDexie {
    constructor() {}

    version() {
      return {
        stores: (schema: Record<string, string>) => {
          for (const name of Object.keys(schema)) {
            // 直接挂到实例上，避免被 useDefineForClassFields 声明的 ! 字段覆盖
            ;(this as any)[name] = new FakeTable(name)
          }
          return { upgrade: () => ({}) }
        },
      }
    }

    async transaction(_mode: string, ...args: any[]) {
      const fn = args[args.length - 1]
      return fn()
    }
  }

  return { Dexie: FakeDexie, default: FakeDexie }
})

import {
  __resetVersionThrottle,
  db,
  deleteDoc,
  emptyTrash,
  bindFileHandle,
  listSourcesByDoc,
  listVersions,
  loadVersion,
  moveToTrash,
  purgeDoc,
  restoreDoc,
  restoreVersion,
  saveDocumentBundle,
  saveImportedDocumentBundle,
  saveDoc,
  putBlob,
  putSource,
  saveBlob,
  sweepTrash,
} from '../store/db'
import type { DocData, SourceDocument } from '../types'

function makeDoc(id: string, title: string): DocData {
  return {
    version: 3,
    id,
    title,
    layout: 'tree',
    rootId: 'root',
    nodes: { root: { id: 'root', text: title, parent: null, children: [] } },
    createdAt: 1000,
    updatedAt: 1000,
  }
}

describe('M15 版本历史', () => {
  beforeEach(() => {
    __resetVersionThrottle()
    // 清空所有表（FakeTable 的 rows），避免跨用例污染
    for (const name of ['docs', 'docVersions', 'trash', 'blobs', 'templates', 'fileHandles', 'sources', 'analysisTasks', 'applicationReceipts', 'quizPractices', 'documentTombstones']) {
      const t = (db as any)[name]
      if (t) t.rows = []
    }
  })

  it('saveDoc 首次保存产生版本快照', async () => {
    const doc = makeDoc('d1', 'v1')
    await saveDoc(doc)
    const vers = await listVersions('d1')
    expect(vers).toHaveLength(1)
    expect(vers[0].title).toBe('v1')
  })

  it('5 分钟内重复保存节流，不产生新快照', async () => {
    const doc = makeDoc('d1', 'v1')
    await saveDoc(doc)
    const updated = { ...doc, title: 'v2', updatedAt: 2000 }
    await saveDoc(updated)
    const vers = await listVersions('d1')
    expect(vers).toHaveLength(1)
    expect(vers[0].title).toBe('v1')
  })

  it('resetVersionThrottle 后可再次产生快照', async () => {
    const doc = makeDoc('d1', 'v1')
    await saveDoc(doc)
    __resetVersionThrottle()
    await saveDoc({ ...doc, title: 'v2', updatedAt: 2000 })
    const vers = await listVersions('d1')
    expect(vers).toHaveLength(2)
    expect(vers[0].title).toBe('v2')
    expect(vers[1].title).toBe('v1')
  })

  it('restoreVersion 覆盖 docs 表并返回迁移后的文档', async () => {
    const doc = makeDoc('d1', 'v1')
    await saveDoc(doc)
    __resetVersionThrottle()
    await saveDoc({ ...doc, title: 'v2', updatedAt: 2000 })
    const vers = await listVersions('d1')
    const oldest = vers[vers.length - 1]
    const restored = await restoreVersion(oldest.id)
    expect(restored?.title).toBe('v1')

    const loaded = await loadVersion(oldest.id)
    expect(loaded?.title).toBe('v1')
  })

  it('deleteDoc 级联删除该文档全部版本', async () => {
    const doc = makeDoc('d1', 'v1')
    await saveDoc(doc)
    __resetVersionThrottle()
    await saveDoc({ ...doc, title: 'v2', updatedAt: 2000 })
    expect(await listVersions('d1')).toHaveLength(2)

    await deleteDoc('d1')
    expect(await listVersions('d1')).toHaveLength(0)
  })

  it('M17 bundle 完整替换来源集合，不遗留旧来源', async () => {
    const doc = makeDoc('d1', '来源文档')
    const source = (id: string): SourceDocument => ({
      version: 1,
      id,
      docId: doc.id,
      name: `${id}.txt`,
      kind: 'text',
      mime: 'text/plain',
      size: 3,
      lastModified: 1,
      importedAt: 2,
      extractor: 'test',
      text: 'abc',
      charCount: 3,
      anchors: [{ nodeId: doc.rootId, start: 0, end: 3 }],
    })
    await saveDocumentBundle(doc, [source('s1')])
    await saveDocumentBundle(doc, [source('s2')])
    expect((await listSourcesByDoc(doc.id)).map((item) => item.id)).toEqual(['s2'])
  })

  it('M17 来源随软删还原保留，并在永久删除时清理', async () => {
    const doc = makeDoc('d1', '来源文档')
    const source: SourceDocument = {
      version: 1,
      id: 's1',
      docId: doc.id,
      name: 'x.txt',
      kind: 'text',
      mime: 'text/plain',
      size: 3,
      lastModified: 1,
      importedAt: 2,
      extractor: 'test',
      text: 'abc',
      charCount: 3,
      anchors: [{ nodeId: doc.rootId, start: 0, end: 3 }],
    }
    await saveDocumentBundle(doc, [source])
    await moveToTrash(doc.id)
    expect(await listSourcesByDoc(doc.id)).toHaveLength(1)
    expect(await restoreDoc(doc.id)).toBe(doc.id)
    expect(await listSourcesByDoc(doc.id)).toHaveLength(1)
    await moveToTrash(doc.id)
    await purgeDoc(doc.id)
    expect(await listSourcesByDoc(doc.id)).toHaveLength(0)
  })

  it('ordinary permanent deletion fences every late document/source/blob/handle writer', async () => {
    const doc = makeDoc('ordinary-permanent', '敏感标题不进入 tombstone')
    await saveDoc(doc)
    await putBlob('old-blob', doc.id, new Blob(['attachment']))
    await db.analysisTasks.put({ docId: doc.id } as never)
    await db.quizPractices.put({ id: 'practice', docId: doc.id } as never)
    await deleteDoc(doc.id)
    await expect(saveDoc(doc)).rejects.toThrow(/已删除/)
    await expect(saveDocumentBundle(doc, [])).rejects.toThrow(/已删除/)
    await expect(putBlob('late', doc.id, new Blob(['late']))).rejects.toThrow(/已删除/)
    await expect(saveBlob(doc.id, new Blob(['late']), doc.rootId)).rejects.toThrow(/已删除/)
    await expect(putSource({ id: 'late-source', docId: doc.id } as SourceDocument)).rejects.toThrow(/已删除/)
    await expect(bindFileHandle(doc.id, {} as never)).rejects.toThrow(/已删除/)
    const tombstone = await db.documentTombstones.get(doc.id)
    expect(Object.keys(tombstone!).sort()).toEqual(['deletedAt', 'id'])
    expect(tombstone?.id).toBe(doc.id)
    expect(await db.docs.get(doc.id)).toBeUndefined()
    expect(await db.blobs.toArray()).toHaveLength(0)
    expect(await db.analysisTasks.toArray()).toHaveLength(0)
    expect(await db.quizPractices.toArray()).toHaveLength(0)
  })

  it('trash restore preserves identity; a stale purge cannot delete the restored document', async () => {
    const doc = makeDoc('restorable', '还原')
    await saveDoc(doc)
    await moveToTrash(doc.id)
    await expect(saveDoc(doc)).rejects.toThrow(/已删除/)
    expect(await restoreDoc(doc.id)).toBe(doc.id)
    await purgeDoc(doc.id)
    expect(await db.documentTombstones.get(doc.id)).toBeUndefined()
    await saveDoc({ ...doc, title: '还原后正常保存' })
    expect((await db.docs.get(doc.id))?.title).toBe('还原后正常保存')
  })

  it('purge, empty and retention sweep all retain fences after cleaning associated content', async () => {
    for (const [id, remove] of [['purge', () => purgeDoc('purge')], ['empty', emptyTrash], ['sweep', () => sweepTrash(-1)]] as const) {
      const doc = makeDoc(id, id)
      await saveDoc(doc)
      await putBlob(`${id}-blob`, id, new Blob(['data']))
      await moveToTrash(id)
      await remove()
      expect(await restoreDoc(id)).toBeNull()
      await expect(saveDocumentBundle(doc, [])).rejects.toThrow(/已删除/)
      expect(await listVersions(id)).toHaveLength(0)
      expect(await db.blobs.where('docId').equals(id).toArray()).toHaveLength(0)
      expect(await db.documentTombstones.get(id)).toEqual({ id, deletedAt: expect.any(Number) })
    }
  })

  it('explicit import creates a new identity after deletion, while a normal reopen keeps its identity', async () => {
    const doc = makeDoc('native-original', '导入')
    doc.nodes.root.collapsed = true
    doc.nodes.root.images = [{ id: 'image', blobId: 'blob', w: 1, h: 1 }]
    const blobs = new Map([['blob', new Blob(['binary'])]])
    const initial = await saveImportedDocumentBundle(doc, [], blobs)
    expect(initial.id).toBe(doc.id)
    await deleteDoc(doc.id)
    const copied = await saveImportedDocumentBundle(doc, [], blobs)
    expect(copied.id).not.toBe(doc.id)
    expect(copied.rootId).not.toBe(doc.rootId)
    expect(copied.nodes[copied.rootId].collapsed).toBe(true)
    const copiedBlobId = copied.nodes[copied.rootId].images![0].blobId
    expect(copiedBlobId).not.toBe('blob')
    expect((await db.blobs.get(copiedBlobId))?.docId).toBe(copied.id)
    await expect(saveDoc(doc)).rejects.toThrow(/已删除/)
    expect(await db.documentTombstones.get(doc.id)).toBeDefined()
  })

  it('an import losing the deletion race retries only under a fresh identity', async () => {
    const doc = makeDoc('import-race', '导入竞争')
    await saveDoc(doc)
    const transaction = vi.spyOn(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction')
    transaction.mockImplementationOnce(async (...args: unknown[]) => {
      await deleteDoc(doc.id)
      return (args.at(-1) as () => Promise<void>)()
    })
    const restored = await saveImportedDocumentBundle(doc, [])
    transaction.mockRestore()
    expect(restored.id).not.toBe(doc.id)
    expect(await db.docs.get(doc.id)).toBeUndefined()
    expect(await db.documentTombstones.get(doc.id)).toBeDefined()
    expect(await db.docs.get(restored.id)).toBeDefined()
  })

  it('a stale version cannot recreate its deleted owner, even if a legacy orphan survived', async () => {
    const doc = makeDoc('version-orphan', '旧历史')
    await saveDoc(doc)
    const version = (await db.docVersions.toArray())[0]
    await deleteDoc(doc.id)
    await db.docVersions.put(version)
    expect(await restoreVersion(version.id)).toBeNull()
    expect(await db.docs.get(doc.id)).toBeUndefined()
  })

  it('best-effort version snapshots skip a document removed after its primary save', async () => {
    const doc = makeDoc('snapshot-race', '快照竞争')
    const transaction = vi.spyOn(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction')
    const original = transaction.getMockImplementation()
    let calls = 0
    transaction.mockImplementation(async (...args: unknown[]) => {
      calls++
      if (calls === 2) await deleteDoc(doc.id)
      if (original) return original(...args)
      return (args.at(-1) as () => Promise<void>)()
    })
    await saveDoc(doc)
    transaction.mockRestore()
    expect(await db.docs.get(doc.id)).toBeUndefined()
    expect(await listVersions(doc.id)).toHaveLength(0)
  })

  it('attachments belong to the document and remain writable for newly created unsaved nodes', async () => {
    const doc = makeDoc('attachment-owner', '附件')
    await saveDoc(doc)
    const id = await saveBlob(doc.id, new Blob(['abc']), 'new-node-not-yet-autosaved')
    expect(await db.blobs.get(id)).toMatchObject({ docId: doc.id, nodeId: 'new-node-not-yet-autosaved' })
    await deleteDoc(doc.id)
    expect(await db.blobs.get(id)).toBeUndefined()
    await expect(putBlob('shared', 'foreign-owner', new Blob(['x']))).resolves.toBeUndefined()
    await expect(putBlob('shared', 'another-owner', new Blob(['y']))).rejects.toThrow(/其他文档/)
  })

  it('atomic bundle and raw attachment writes enforce the same 64MB quota, including existing attachments', async () => {
    const doc = makeDoc('quota-owner', '附件限额')
    await saveDoc(doc)
    await db.blobs.put({ id: 'quota-existing', docId: doc.id, blob: { size: 64 * 1024 * 1024 } as Blob, createdAt: 1 })
    await expect(saveDocumentBundle({ ...doc, title: '不能部分提交' }, [], new Map([['quota-extra', new Blob(['x'])]]))).rejects.toThrow(/64MB/)
    expect((await db.docs.get(doc.id))?.title).toBe(doc.title)
    await expect(saveBlob(doc.id, new Blob(['x']), doc.rootId)).rejects.toThrow(/64MB/)
    await expect(putBlob('quota-extra', doc.id, new Blob(['x']))).rejects.toThrow(/64MB/)
    await expect(putBlob('quota-existing', doc.id, new Blob(['replacement']))).resolves.toBeUndefined()
    expect(await db.blobs.get('quota-extra')).toBeUndefined()
  })
})
