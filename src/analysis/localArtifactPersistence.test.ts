import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import { db, type StoredDoc } from '../store/db'
import type { SourceDocument } from '../types'
import type { StoredAnalysisTask } from './taskPersistence'
import { applyMindMapArtifact, type ApplicationReceipt } from './mindMapApplication'
import { artifactContentHash, prepareArtifactIdentity, verifyPreparedArtifactIdentity } from './localArtifactIdentity'
import { cleanupQuizPractices, clearQuizPractice, loadQuizPractice, saveQuizPractice, type QuizPracticeRecord } from './quizPractice'
import { localArtifactFixtures } from '../test/localArtifactFixtures'

// Domain transaction tests use a serial store double. Chromium tests independently verify real Dexie atomicity.
let docs: Map<string, StoredDoc>, sources: Map<string, SourceDocument>, tasks: Map<string, StoredAnalysisTask>
let receipts: Map<string, ApplicationReceipt>, practices: Map<string, QuizPracticeRecord>
let beforeTransaction: (() => void) | undefined
let failSources: boolean
let tail: Promise<unknown>
const copyMap = <T>(map: Map<string, T>): Map<string, T> => new Map([...map].map(([key, value]) => [key, structuredClone(value)]))

beforeEach(() => {
  docs = new Map(); sources = new Map(); tasks = new Map(); receipts = new Map(); practices = new Map(); tail = Promise.resolve(); beforeTransaction = undefined; failSources = false
  vi.spyOn(db.docs, 'get').mockImplementation((id) => Dexie.Promise.resolve(docs.get(String(id))))
  vi.spyOn(db.docs, 'add').mockImplementation((row) => { if (docs.has(row.id)) throw new Error('duplicate'); docs.set(row.id, structuredClone(row)); return Dexie.Promise.resolve(row.id) })
  vi.spyOn(db.trash, 'get').mockResolvedValue(undefined)
  vi.spyOn(db.sources, 'get').mockImplementation((id) => Dexie.Promise.resolve(sources.get(String(id))))
  vi.spyOn(db.sources, 'bulkAdd').mockImplementation((async (rows: SourceDocument[]) => {
    if (failSources) throw new Error('synthetic source failure')
    for (const row of rows) { if (sources.has(row.id)) throw new Error('duplicate'); sources.set(row.id, structuredClone(row)) }
    return rows.at(-1)?.id
  }) as typeof db.sources.bulkAdd)
  vi.spyOn(db.analysisTasks, 'get').mockImplementation((id) => Dexie.Promise.resolve(tasks.get(String(id))))
  vi.spyOn(db.applicationReceipts, 'get').mockImplementation((id) => Dexie.Promise.resolve(receipts.get(String(id))))
  vi.spyOn(db.applicationReceipts, 'add').mockImplementation((row) => { receipts.set(row.applicationIntentId, structuredClone(row)); return Dexie.Promise.resolve(row.applicationIntentId) })
  vi.spyOn(db.quizPractices, 'get').mockImplementation((id) => Dexie.Promise.resolve(practices.get(String(id))))
  vi.spyOn(db.quizPractices, 'put').mockImplementation((row) => { practices.set(row.id, structuredClone(row)); return Dexie.Promise.resolve(row.id) })
  vi.spyOn(db.quizPractices, 'delete').mockImplementation((id) => { practices.delete(id); return Dexie.Promise.resolve() })
  vi.spyOn(db.quizPractices, 'where').mockImplementation((() => ({ equals: (docId: string) => ({ delete: async () => {
    let deleted = 0; for (const [id, row] of practices) if (row.docId === docId) { practices.delete(id); deleted++ } return deleted
  } }) })) as unknown as typeof db.quizPractices.where)
  vi.spyOn(db, 'transaction').mockImplementation((async (...args: unknown[]) => {
    const run = tail.then(async () => {
      beforeTransaction?.(); beforeTransaction = undefined
      const snapshots = [copyMap(docs), copyMap(sources), copyMap(tasks), copyMap(receipts), copyMap(practices)] as const
      try { return await (args.at(-1) as () => Promise<unknown>)() }
      catch (error) { [docs, sources, tasks, receipts, practices] = snapshots; throw error }
    })
    tail = run.catch(() => {})
    return run
  }) as typeof db.transaction)
})
afterEach(() => vi.restoreAllMocks())

async function initialize() {
  const fixture = await localArtifactFixtures()
  docs.set(fixture.doc.id, { id: fixture.doc.id, title: fixture.doc.title, createdAt: 1, updatedAt: 1, payload: JSON.stringify(fixture.doc) })
  sources.set(fixture.source.id, fixture.source)
  tasks.set(fixture.doc.id, fixture.task)
  return fixture
}

describe('local artifact binding authority', () => {
  it('rejects missing, mismatched, replaced or unhashed artifacts before saving', async () => {
    const fixture = await initialize()
    const context = { docId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.mindmap }
    const valid = await prepareArtifactIdentity(context)
    await verifyPreparedArtifactIdentity(valid)
    for (const task of [undefined, { ...fixture.task, runId: 'other-run' }, { ...fixture.task, artifactIdentities: {} },
      { ...fixture.task, artifactIdentities: { mindmap: { artifactId: fixture.mindmap.id, attempt: 1, runRevision: 11 } } },
      { ...fixture.task, artifactIdentities: { ...fixture.task.artifactIdentities, mindmap: { ...fixture.task.artifactIdentities!.mindmap!, contentHash: 'b'.repeat(64) } } }]) {
      if (task) tasks.set(fixture.doc.id, task); else tasks.delete(fixture.doc.id)
      await expect(prepareArtifactIdentity(context)).rejects.toThrow()
    }
    tasks.set(fixture.doc.id, fixture.task)
    const bad = structuredClone(fixture.mindmap); bad.sourceContentHashes = ['b'.repeat(64)]
    await expect(prepareArtifactIdentity({ ...context, artifact: bad })).rejects.toThrow('来源')
    const invalid = structuredClone(fixture.mindmap); invalid.payload.nodes[0]!.parentId = 'child'
    await expect(prepareArtifactIdentity({ ...context, artifact: invalid })).rejects.toThrow('结构')
    sources.delete(fixture.source.id); await expect(prepareArtifactIdentity(context)).rejects.toThrow('来源')
    sources.set(fixture.source.id, { ...fixture.source, text: 'changed', charCount: 7 }); await expect(prepareArtifactIdentity(context)).rejects.toThrow('改变')
    sources.set(fixture.source.id, fixture.source); docs.delete(fixture.doc.id); await expect(prepareArtifactIdentity(context)).rejects.toThrow('删除')
  })

  it('rechecks source, intent and attempt inside transaction after hashing', async () => {
    const fixture = await initialize()
    const prepared = await prepareArtifactIdentity({ docId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.mindmap })
    sources.set(fixture.source.id, { ...fixture.source, extractor: 'changed' })
    await expect(verifyPreparedArtifactIdentity(prepared)).rejects.toThrow('变化')
    sources.set(fixture.source.id, fixture.source)
    tasks.set(fixture.doc.id, { ...fixture.task, request: { ...fixture.task.request, requestKey: 'c'.repeat(64) } })
    await expect(verifyPreparedArtifactIdentity(prepared)).rejects.toThrow('改变')
    tasks.set(fixture.doc.id, { ...fixture.task, artifactIdentities: { ...fixture.task.artifactIdentities, mindmap: { ...fixture.task.artifactIdentities!.mindmap!, attempt: 2 } } })
    await expect(verifyPreparedArtifactIdentity(prepared)).rejects.toThrow('改变')
  })
})

describe('MindMap application authority', () => {
  it('serializes concurrent intent, retains edits and tombstones, and rejects changed intent', async () => {
    const fixture = await initialize()
    const input = { originDocId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.mindmap }
    const outcomes = await Promise.all([applyMindMapArtifact(input), applyMindMapArtifact(input)])
    expect(outcomes[0]!.targetDocId).toBe(outcomes[1]!.targetDocId)
    expect(outcomes.filter((result) => !result.reused)).toHaveLength(1)
    const target = docs.get(outcomes[0]!.targetDocId)!
    docs.set(target.id, { ...target, title: 'manual edit' })
    await applyMindMapArtifact(input); expect(docs.get(target.id)!.title).toBe('manual edit')
    docs.delete(target.id)
    expect((await applyMindMapArtifact(input)).status).toBe('deleted')
    vi.mocked(db.trash.get).mockResolvedValue({ ...target, deletedAt: 1 })
    expect((await applyMindMapArtifact(input)).status).toBe('trashed')
    const existing = [...receipts.values()][0]!
    receipts.set(existing.applicationIntentId, { ...existing, runId: 'other-run' })
    await expect(applyMindMapArtifact(input)).rejects.toThrow('意图')
    receipts.set(existing.applicationIntentId, { ...existing, version: 2 } as never)
    await expect(applyMindMapArtifact(input)).rejects.toThrow('损坏')
    receipts.set(existing.applicationIntentId, { ...existing, payload: 'synthetic-disallowed' } as never)
    await expect(applyMindMapArtifact(input)).rejects.toThrow('损坏')
    await expect(applyMindMapArtifact({ ...input, applicationIntentId: '../bad' })).rejects.toThrow('意图')
  })

  it('has zero target writes on source commit failure or a late authoritative source change', async () => {
    const fixture = await initialize()
    const input = { originDocId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.mindmap }
    failSources = true
    await expect(applyMindMapArtifact(input)).rejects.toThrow('source failure')
    expect(docs.size).toBe(1); expect(sources.size).toBe(1); expect(receipts.size).toBe(0)
    failSources = false
    beforeTransaction = () => sources.set(fixture.source.id, { ...fixture.source, text: fixture.source.text + 'late change' })
    await expect(applyMindMapArtifact(input)).rejects.toThrow('变化')
    expect(docs.size).toBe(1); expect(receipts.size).toBe(0)
  })
})

describe('Quiz persisted CAS', () => {
  it('restores only the matching artifact, conflicts across pages and creates separate records for a replacement', async () => {
    const fixture = await initialize()
    const context = { docId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.quiz }
    const state = { answers: { choice: 0 }, submitted: false, selfAssessments: {} }
    expect(await loadQuizPractice(context)).toBeUndefined()
    const initial = await saveQuizPractice(context, state, null)
    expect(await loadQuizPractice(context)).toEqual(initial)
    const outcomes = await Promise.allSettled([saveQuizPractice(context, state, 1), saveQuizPractice(context, { ...state, answers: { choice: 1 } }, 1)])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    await expect(saveQuizPractice(context, state, 0)).rejects.toThrow('版本')
    const replacement = { ...fixture.quiz, id: 'new-quiz' }
    const task = structuredClone(fixture.task)
    task.artifactIdentities!.quiz = { artifactId: replacement.id, attempt: 2, runRevision: 10, contentHash: await artifactContentHash(replacement) }
    tasks.set(fixture.doc.id, task)
    await expect(loadQuizPractice(context)).rejects.toThrow('身份')
    const newContext = { ...context, artifact: replacement }
    expect(await loadQuizPractice(newContext)).toBeUndefined()
    await saveQuizPractice(newContext, state, null)
    expect(practices.size).toBe(2)
    await cleanupQuizPractices(fixture.doc.id); expect(practices.size).toBe(0)
    tasks.delete(fixture.doc.id)
    await expect(saveQuizPractice(newContext, state, null)).rejects.toThrow('删除')
    expect(practices.size).toBe(0)
  })

  it('fails safely on corrupt practice, supports explicit cleanup and rejects identity tampering', async () => {
    const fixture = await initialize()
    const context = { docId: fixture.doc.id, runId: fixture.task.runId!, artifact: fixture.quiz }
    const state = { answers: {}, submitted: false, selfAssessments: {} }
    const first = await saveQuizPractice(context, state, null)
    practices.set(first.id, { ...first, answers: { choice: 'bad' } })
    await expect(loadQuizPractice(context)).rejects.toThrow('损坏')
    await expect(saveQuizPractice(context, state, 1)).rejects.toThrow('损坏')
    await clearQuizPractice(context)
    expect(await loadQuizPractice(context)).toBeUndefined()
    const next = await saveQuizPractice(context, state, null)
    await expect(clearQuizPractice(context)).rejects.toThrow('有效记录')
    expect(practices.size).toBe(1)
    practices.set(next.id, { ...next, sourceFingerprint: 'b'.repeat(64) })
    await expect(loadQuizPractice(context)).rejects.toThrow('不一致')
    await expect(saveQuizPractice(context, state, 1)).rejects.toThrow('不一致')
  })
})
