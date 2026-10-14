import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDoc, findTpl } from '../data/templates'
import { EMPTY_DOC, useDoc } from '../store/docStore'
import type { StoredDoc } from '../store/db'
import type { DocData } from '../types'

const fixture = vi.hoisted(() => {
  const docs = new Map<string, StoredDoc>()
  const deleted = new Set<string>()
  const trash = new Set<string>()
  const sources = new Set<string>()
  const blobs = new Set<string>()
  const ownedTable = (ids: Set<string>) => ({ where: () => ({ equals: (id: string) => ({ first: async () => ids.has(id) ? { docId: id } : undefined }) }) })
  return { docs, deleted, trash, sources, blobs, db: {
    docs: { toArray: async () => [...docs.values()], get: async (id: string) => docs.get(id), put: vi.fn(async (row: StoredDoc) => { docs.set(row.id, row); return row.id }) },
    sources: ownedTable(sources), blobs: ownedTable(blobs),
    trash: { get: async (id: string) => trash.has(id) ? { id } : undefined },
    documentTombstones: { get: async (id: string) => deleted.has(id) ? { id } : undefined },
    transaction: vi.fn(async (_mode: string, _tables: unknown, run: () => Promise<DocData>) => run()),
  } }
})

vi.mock('../store/db', () => ({ db: fixture.db }))
vi.mock('./tabs', () => ({ emitDocsChanged: vi.fn() }))

import { getOrCreateLatestTutorial, isUnmodifiedLatestTutorial, openLatestTutorial } from './tutorial'

const store = (doc: DocData) => fixture.docs.set(doc.id, { id: doc.id, title: doc.title,
  createdAt: doc.createdAt, updatedAt: doc.updatedAt, payload: JSON.stringify(doc) })

beforeEach(() => {
  for (const entries of [fixture.docs, fixture.deleted, fixture.trash, fixture.sources, fixture.blobs]) entries.clear()
  fixture.db.docs.put.mockClear()
  fixture.db.transaction.mockClear()
  useDoc.setState({ doc: EMPTY_DOC, sessions: {}, tabs: [], past: [], future: [], selection: [], clipboard: null })
})

describe('explicit current tutorial', () => {
  it('reuses an unchanged current tutorial across different generated IDs and timestamps', async () => {
    const doc = buildDoc(findTpl('welcome'))
    doc.updatedAt += 1000
    store(doc)
    expect(isUnmodifiedLatestTutorial(doc)).toBe(true)
    expect((await getOrCreateLatestTutorial()).id).toBe(doc.id)
    expect(fixture.db.docs.put).not.toHaveBeenCalled()
  })

  it('keeps old and manually edited tutorials untouched and creates the current one separately', async () => {
    const old = buildDoc(findTpl('welcome'))
    old.nodes[old.rootId].text = '欢迎使用猫思之 🐱'
    const edited = buildDoc(findTpl('welcome'))
    edited.nodes[edited.rootId].note = '我的学习计划'
    store(old); store(edited)
    const oldPayloads = [fixture.docs.get(old.id)?.payload, fixture.docs.get(edited.id)?.payload]
    const current = await getOrCreateLatestTutorial()
    expect([old.id, edited.id]).not.toContain(current.id)
    expect([fixture.docs.get(old.id)?.payload, fixture.docs.get(edited.id)?.payload]).toEqual(oldPayloads)
    expect(isUnmodifiedLatestTutorial(current)).toBe(true)
  })

  it.each(['active', 'background'] as const)('preserves unsaved edits in a %s tutorial tab', async (kind) => {
    const stored = buildDoc(findTpl('welcome'))
    store(stored)
    const live = structuredClone(stored)
    live.title = '我的使用笔记'
    if (kind === 'active') useDoc.setState({ doc: live })
    else useDoc.setState({ sessions: { [live.id]: { doc: live, past: [], future: [], clipboard: null } } })
    const current = await getOrCreateLatestTutorial()
    expect(current.id).not.toBe(live.id)
    expect((kind === 'active' ? useDoc.getState().doc : useDoc.getState().sessions[live.id].doc).title).toBe('我的使用笔记')
    expect(fixture.docs.get(stored.id)?.payload).toBe(JSON.stringify(stored))
  })

  it.each(['trash', 'deleted', 'sources', 'blobs'] as const)('does not reuse or restore a tutorial with %s content or a deletion fence', async (kind) => {
    const doc = buildDoc(findTpl('welcome'))
    store(doc)
    fixture[kind].add(doc.id)
    expect((await getOrCreateLatestTutorial()).id).not.toBe(doc.id)
    expect(fixture[kind].has(doc.id)).toBe(true)
    expect(fixture.docs.get(doc.id)?.payload).toBe(JSON.stringify(doc))
  })

  it('ignores malformed stored tutorials and invalid graphs without overwriting them', async () => {
    const doc = buildDoc(findTpl('welcome'))
    doc.nodes[doc.rootId].children.push(doc.rootId)
    store(doc)
    fixture.docs.set('broken', { id: 'broken', title: doc.title, createdAt: 0, updatedAt: 0, payload: 'null' })
    const current = await getOrCreateLatestTutorial()
    expect(isUnmodifiedLatestTutorial(doc)).toBe(false)
    expect(current.id).not.toBe(doc.id)
    expect(fixture.docs.get('broken')?.payload).toBe('null')
  })

  it('coalesces repeated entry clicks and opens a single saved tutorial without losing current edits', async () => {
    const edited = buildDoc(findTpl('blank'))
    edited.nodes[edited.rootId].text = '还没保存的内容'
    useDoc.setState({ doc: edited, tabs: [edited.id] })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    try {
      const first = openLatestTutorial()
      expect(openLatestTutorial()).toBe(first)
      await first
      const currentId = useDoc.getState().doc.id
      await openLatestTutorial()
      expect(useDoc.getState().doc.id).toBe(currentId)
      expect(fixture.db.docs.put).toHaveBeenCalledOnce()
      expect(useDoc.getState().sessions[edited.id].doc.nodes[edited.rootId].text).toBe('还没保存的内容')
    } finally { vi.unstubAllGlobals() }
  })

  it('releases the entry guard after storage failure so the next explicit click can recover', async () => {
    fixture.db.transaction.mockRejectedValueOnce(new Error('storage_unavailable'))
    await expect(openLatestTutorial()).rejects.toThrow('storage_unavailable')
    vi.stubGlobal('requestAnimationFrame', () => 1)
    try {
      await openLatestTutorial()
      expect(isUnmodifiedLatestTutorial(useDoc.getState().doc)).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
})
