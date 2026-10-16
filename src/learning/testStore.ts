import { vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '../store/db'

/** Serial, rollback-capable domain double; browser coverage separately exercises actual IndexedDB. */
export function installLearningTestStore() {
  const names = ['learningRecords', 'learningCourseTombstones', 'learningEntityTombstones', 'docs', 'sources', 'blobs', 'docVersions', 'trash', 'documentTombstones', 'analysisTasks'] as const
  const maps = Object.fromEntries(names.map((n) => [n, new Map<string, unknown>()])) as Record<typeof names[number], Map<string, unknown>>
  const context = new AsyncLocalStorage<boolean>()
  let tail: Promise<unknown> = Promise.resolve()
  let failOnTable: string | undefined
  for (const name of names) {
    const table = db[name]
    const keyFor = (row: Record<string, unknown>) => String(row.id ?? row.docId)
    const rows = () => [...maps[name].values()] as Record<string, unknown>[]
    const put = (row: unknown, add = false) => {
      if (name === failOnTable) throw new Error(`synthetic ${name} failure`)
      const key = keyFor(row as Record<string, unknown>); if (add && maps[name].has(key)) throw new Error('duplicate key')
      maps[name].set(key, structuredClone(row)); return Promise.resolve(key)
    }
    vi.spyOn(table, 'get').mockImplementation(((id: string) => Promise.resolve(structuredClone(maps[name].get(String(id))))) as typeof table.get)
    vi.spyOn(table, 'put').mockImplementation(((row: unknown) => put(row)) as typeof table.put)
    vi.spyOn(table, 'add').mockImplementation(((row: unknown) => put(row, true)) as typeof table.add)
    vi.spyOn(table, 'bulkAdd').mockImplementation(((items: unknown[]) => Promise.all(items.map((r) => put(r, true))).then((ids) => ids.at(-1))) as typeof table.bulkAdd)
    vi.spyOn(table, 'bulkPut').mockImplementation(((items: unknown[]) => Promise.all(items.map((r) => put(r))).then((ids) => ids.at(-1))) as typeof table.bulkPut)
    vi.spyOn(table, 'delete').mockImplementation(((id: string) => { maps[name].delete(String(id)); return Promise.resolve() }) as typeof table.delete)
    vi.spyOn(table, 'count').mockImplementation((() => Promise.resolve(maps[name].size)) as typeof table.count)
    vi.spyOn(table, 'toArray').mockImplementation((() => Promise.resolve(structuredClone(rows()))) as typeof table.toArray)
    vi.spyOn(table, 'where').mockImplementation(((index: string) => ({ equals: (value: unknown) => {
      const matching = () => rows().filter((r) => index === '[courseId+kind]' ? JSON.stringify([r.courseId, r.kind]) === JSON.stringify(value) : r[index] === value)
      return { toArray: () => Promise.resolve(structuredClone(matching())), sortBy: (field: string) => Promise.resolve(structuredClone(matching()).sort((left, right) => Number(left[field] ?? 0) - Number(right[field] ?? 0))), delete: () => { const found = matching(); found.forEach((r) => maps[name].delete(keyFor(r))); return Promise.resolve(found.length) } }
    } })) as unknown as typeof table.where)
  }
  vi.spyOn(db, 'transaction').mockImplementation((async (...args: unknown[]) => {
    if (context.getStore()) return (args.at(-1) as () => Promise<unknown>)()
    const work = tail.then(() => context.run(true, async () => {
      const previous = Object.fromEntries(names.map((n) => [n, new Map([...maps[n]].map(([id, value]) => [id, structuredClone(value)]))]))
      try { return await (args.at(-1) as () => Promise<unknown>)() }
      catch (error) { for (const n of names) { maps[n].clear(); for (const [id, value] of previous[n] as Map<string, unknown>) maps[n].set(id, value) } throw error }
    }))
    tail = work.catch(() => undefined); return work
  }) as typeof db.transaction)
  return { maps, failWritesTo: (table?: string) => { failOnTable = table } }
}
