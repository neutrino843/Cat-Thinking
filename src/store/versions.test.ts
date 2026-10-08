import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('dexie', () => {
  class FakeTable {
    rows: any[] = []
    constructor(public name: string) {}

    async put(row: any) {
      const idx = this.rows.findIndex((r) => r.id === row.id)
      if (idx >= 0) this.rows[idx] = row
      else this.rows.push(row)
      return row.id
    }

    async get(id: string) {
      return this.rows.find((r) => r.id === id) ?? undefined
    }

    async delete(id: string) {
      const idx = this.rows.findIndex((r) => r.id === id)
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
  listVersions,
  loadVersion,
  restoreVersion,
  saveDoc,
} from '../store/db'
import type { DocData } from '../types'

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
    for (const name of ['docs', 'docVersions', 'trash', 'blobs', 'templates', 'fileHandles']) {
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
})
