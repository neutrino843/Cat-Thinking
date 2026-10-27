import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../store/db'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { convertMindMapArtifact } from './mindMapApplication'
import { collectLocalSourceReferences, resolveLocalSourceReference } from './localSourceReferences'

afterEach(() => vi.restoreAllMocks())
describe('local copy citation inspection', () => {
  it('collects node and incident relation references with fresh local ids and bounded lists', async () => {
    const fixture = await localArtifactFixtures()
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    const references = collectLocalSourceReferences(converted.doc, converted.doc.rootId, converted.sources)
    expect(references.map((entry) => entry.label)).toEqual(['节点原文', '关系原文：支持'])
    expect(references.every((entry) => entry.sourceId === converted.sources[0]!.id && entry.contentHash === fixture.snapshot.contentHash)).toBe(true)
    converted.sources[0]!.anchors = Array.from({ length: 100 }, (_, index) => ({ nodeId: converted.doc.rootId, start: index, end: index + 1 }))
    expect(collectLocalSourceReferences(converted.doc, converted.doc.rootId, converted.sources)).toHaveLength(20)
    expect(collectLocalSourceReferences(converted.doc, 'unrelated-node', converted.sources)).toEqual([])
  })

  it('verifies copy hash/UTF-16 independently of origin and returns bounded plain text', async () => {
    const fixture = await localArtifactFixtures()
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    const source = converted.sources[0]!
    vi.spyOn(db.docs, 'get').mockImplementation((id) => Dexie.Promise.resolve(String(id) === converted.doc.id ? {} : undefined))
    vi.spyOn(db.sources, 'get').mockImplementation((id) => Dexie.Promise.resolve(String(id) === source.id ? source : undefined))
    const reference = collectLocalSourceReferences(converted.doc, converted.doc.rootId, converted.sources)[0]!
    expect((await resolveLocalSourceReference(converted.doc.id, reference)).quote).toBe('😀')
    await expect(resolveLocalSourceReference(fixture.doc.id, reference)).rejects.toThrow('删除')
    await expect(resolveLocalSourceReference(converted.doc.id, { ...reference, end: 100 })).rejects.toThrow('区间')
    await expect(resolveLocalSourceReference(converted.doc.id, { ...reference, contentHash: 'a'.repeat(64) })).rejects.toThrow('改变')
    const long = { ...source, text: '<script>synthetic</script>' + 'x'.repeat(5_000), charCount: 5_026 }
    long.charCount = long.text.length
    vi.mocked(db.sources.get).mockImplementation(() => Dexie.Promise.resolve(long))
    const plain = await resolveLocalSourceReference(converted.doc.id, { ...reference, contentHash: undefined, start: 0, end: long.text.length })
    expect(plain.truncated).toBe(true); expect(plain.quote.length).toBe(4_000); expect(plain.quote).toContain('<script>')
    const local = { ...reference, contentHash: undefined, start: 0, end: long.text.length }
    const next = await resolveLocalSourceReference(converted.doc.id, local, { offset: 4000 })
    expect(plain.quote + next.quote).toBe(long.text)
    expect(next.truncated).toBe(false)
    expect((await resolveLocalSourceReference(converted.doc.id, local, { full: true })).quote).toBe(long.text)
    for (const offset of [-1, .5, long.text.length]) await expect(resolveLocalSourceReference(converted.doc.id, local, { offset })).rejects.toThrow('位置')
  })

  it('rejects late removal/change and malformed offsets without yielding stale excerpts', async () => {
    const fixture = await localArtifactFixtures()
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    const reference = collectLocalSourceReferences(converted.doc, converted.doc.rootId, converted.sources)[0]!
    vi.spyOn(db.docs, 'get').mockResolvedValue({})
    vi.spyOn(db.sources, 'get').mockResolvedValueOnce(converted.sources[0]).mockResolvedValueOnce(undefined)
    await expect(resolveLocalSourceReference(converted.doc.id, reference)).rejects.toThrow('读取期间')
    vi.mocked(db.sources.get).mockResolvedValue(converted.sources[0])
    for (const patch of [{ start: -1 }, { start: 0.5 }, { end: 0 }, { end: 100 }]) await expect(resolveLocalSourceReference(converted.doc.id, { ...reference, ...patch })).rejects.toThrow()
    vi.mocked(db.sources.get).mockResolvedValue(undefined)
    await expect(resolveLocalSourceReference(converted.doc.id, reference)).rejects.toThrow('删除')
  })
})
