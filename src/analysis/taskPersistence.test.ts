import { beforeEach, expect, it, vi } from 'vitest'
import { analysisRequestSchema } from '@cat-thinking/analysis-contracts'
import requestFixture from '../../packages/analysis-contracts/fixtures/analysis-request.valid.json'
import { analysisTaskRepository, parseStoredAnalysisTask, type StoredAnalysisTask } from './taskPersistence'

const store = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn(), sources: vi.fn(), doc: vi.fn(), clearPractices: vi.fn() }))
vi.mock('../store/db', () => ({ db: { analysisTasks: { get: store.get, put: store.put, delete: store.delete }, docs: { get: store.doc }, quizPractices: { where: () => ({ equals: () => ({ delete: store.clearPractices }) }) }, transaction: async (...args: unknown[]) => (args.at(-1) as () => Promise<void>)() }, listSourcesByDoc: store.sources }))
const task = (): StoredAnalysisTask => ({ version: 1, docId: requestFixture.docId, request: analysisRequestSchema.parse(requestFixture), runId: 'run-1', partBytes: 128_000, uploadedParts: { [requestFixture.manifest.sources[0]!.sourceId]: 1 }, revision: 1, lastSequence: 1, lastEventId: 'event-1', updatedAt: 1 })
beforeEach(() => { vi.resetAllMocks(); store.doc.mockResolvedValue({ id: task().docId }) })
it('stores only validated metadata and supports absence/removal/source lookup', async () => {
  store.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce(task())
  expect(await analysisTaskRepository.load(task().docId)).toBeUndefined()
  expect(await analysisTaskRepository.load(task().docId)).toEqual(task())
  store.get.mockResolvedValue(task())
  await analysisTaskRepository.save(task()); expect(store.put).toHaveBeenCalledWith(task())
  await analysisTaskRepository.remove(task().docId); expect(store.delete).toHaveBeenCalledWith(task().docId)
  store.sources.mockResolvedValue([]); expect(await analysisTaskRepository.sources(task().docId)).toEqual([])
  const pending = { ...task(), runId: undefined, lastEventId: undefined }; expect(parseStoredAnalysisTask(pending)).toEqual(pending)
  const extra = { ...task(), authorization: 'synthetic-untrusted-token', payload: { text: 'synthetic-untrusted-result' } }
  await analysisTaskRepository.save(extra)
  expect(store.put).toHaveBeenLastCalledWith(task())
})

it('whitelists artifact identities, preserves newer identities and rejects stale deletion', async () => {
  const current = { ...task(), revision: 10, artifactIdentities: { summary: { artifactId: 'summary-2', attempt: 2, runRevision: 10, contentHash: 'a'.repeat(64) } } }
  store.get.mockResolvedValue(current)
  await analysisTaskRepository.save({ ...task(), artifactIdentities: {} })
  expect(store.put).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 10, artifactIdentities: current.artifactIdentities }))
  await expect(analysisTaskRepository.remove(task().docId, 'b'.repeat(64))).rejects.toMatchObject({ code: 'conflict' })
  expect(store.delete).not.toHaveBeenCalled()
  for (const identity of [{ artifactId: '../bad', attempt: 1, runRevision: 1 }, { artifactId: 'summary-1', attempt: 0, runRevision: 1 }, { artifactId: 'summary-1', attempt: 1, runRevision: 2 }]) {
    expect(() => parseStoredAnalysisTask({ ...task(), artifactIdentities: { summary: identity } })).toThrow('metadata')
  }
  const identity = { artifactId: 'summary-1', attempt: 1, runRevision: 1, contentHash: 'a'.repeat(64), payload: 'untrusted' }
  expect(parseStoredAnalysisTask({ ...task(), artifactIdentities: { summary: identity } }).artifactIdentities?.summary).not.toHaveProperty('payload')
})

it('preserves identities and quiz practice when an equal-revision tab saves an empty or missing identity map', async () => {
  const current = { ...task(), revision: 10, artifactIdentities: {
    quiz: { artifactId: 'quiz-1', attempt: 1, runRevision: 10, contentHash: 'a'.repeat(64) },
  } }
  store.get.mockResolvedValue(current)
  for (const artifactIdentities of [{}, undefined]) {
    const saved = await analysisTaskRepository.save({ ...task(), revision: 10, artifactIdentities })
    expect(saved?.artifactIdentities).toEqual(current.artifactIdentities)
    expect(store.put).toHaveBeenLastCalledWith(expect.objectContaining({ artifactIdentities: current.artifactIdentities }))
  }
  expect(store.clearPractices).not.toHaveBeenCalled()
})

it('merges independent equal-revision readers and promotes only an absent artifact content hash', async () => {
  const current = { ...task(), revision: 10, artifactIdentities: {
    summary: { artifactId: 'summary-1', attempt: 1, runRevision: 5 },
  } }
  store.get.mockResolvedValue(current)
  const saved = await analysisTaskRepository.save({ ...task(), revision: 10, artifactIdentities: {
    summary: { artifactId: 'summary-1', attempt: 1, runRevision: 10, contentHash: 'a'.repeat(64) },
    outline: { artifactId: 'outline-1', attempt: 1, runRevision: 10, contentHash: 'b'.repeat(64) },
  } })
  expect(saved?.artifactIdentities).toEqual({
    summary: { ...current.artifactIdentities.summary, contentHash: 'a'.repeat(64) },
    outline: { artifactId: 'outline-1', attempt: 1, runRevision: 10, contentHash: 'b'.repeat(64) },
  })
})

it('clears equal-revision identities only when an authoritative compare matches', async () => {
  const identities = { quiz: { artifactId: 'quiz-1', attempt: 1, runRevision: 10, contentHash: 'a'.repeat(64) } }
  const current = { ...task(), revision: 10, artifactIdentities: identities }
  store.get.mockResolvedValue(current)
  const stale = await analysisTaskRepository.save({ ...task(), revision: 10, artifactIdentities: {} }, 'tab-2', { expected: {} })
  expect(stale?.artifactIdentities).toEqual(identities)
  expect(store.clearPractices).not.toHaveBeenCalled()
  const cleared = await analysisTaskRepository.save({ ...task(), revision: 10, artifactIdentities: {} }, 'tab-2', { expected: identities })
  expect(cleared?.artifactIdentities).toEqual({})
  expect(store.clearPractices).toHaveBeenCalledTimes(1)
})

it('does not let an older-revision compare clear newer identities but accepts an authoritative newer retry state', async () => {
  const identities = { quiz: { artifactId: 'quiz-1', attempt: 1, runRevision: 10, contentHash: 'a'.repeat(64) } }
  const current = { ...task(), revision: 10, artifactIdentities: identities }
  store.get.mockResolvedValue(current)
  const older = await analysisTaskRepository.save({ ...task(), revision: 9, artifactIdentities: {} }, 'tab-2', { expected: identities })
  expect(older?.artifactIdentities).toEqual(identities)
  expect(store.clearPractices).not.toHaveBeenCalled()
  const retryState = await analysisTaskRepository.save({ ...task(), revision: 11, artifactIdentities: {} })
  expect(retryState?.artifactIdentities).toEqual({})
  expect(store.clearPractices).toHaveBeenCalledTimes(1)
})

it('rejects equal-revision contradictory artifact IDs, attempts and immutable hashes before storing or clearing practice', async () => {
  const identity = { artifactId: 'quiz-1', attempt: 1, runRevision: 10, contentHash: 'a'.repeat(64) }
  const current = { ...task(), revision: 10, artifactIdentities: { quiz: identity } }
  store.get.mockResolvedValue(current)
  for (const patch of [{ artifactId: 'other-quiz' }, { attempt: 2 }, { contentHash: 'b'.repeat(64) }]) {
    for (const identityUpdate of [undefined, { expected: current.artifactIdentities }]) {
      await expect(analysisTaskRepository.save({ ...task(), revision: 10,
        artifactIdentities: { quiz: { ...identity, ...patch } } }, 'tab-2', identityUpdate)).rejects.toMatchObject({ code: 'conflict' })
    }
  }
  expect(store.put).not.toHaveBeenCalled()
  expect(store.clearPractices).not.toHaveBeenCalled()
})

it('preserves a still-successful artifact identity across newer sibling revisions and permits a new attempt identity', async () => {
  const identity = { artifactId: 'quiz-1', attempt: 1, runRevision: 5, contentHash: 'a'.repeat(64) }
  const current = { ...task(), revision: 10, artifactIdentities: { quiz: identity } }
  store.get.mockResolvedValue(current)
  const sibling = await analysisTaskRepository.save({ ...task(), revision: 11,
    artifactIdentities: { quiz: { artifactId: 'quiz-1', attempt: 1, runRevision: 11 } } })
  expect(sibling?.artifactIdentities?.quiz).toEqual(identity)
  expect(store.clearPractices).not.toHaveBeenCalled()
  await expect(analysisTaskRepository.save({ ...task(), revision: 11,
    artifactIdentities: { quiz: { ...identity, contentHash: 'b'.repeat(64) } } })).rejects.toMatchObject({ code: 'conflict' })
  const next = { artifactId: 'quiz-2', attempt: 2, runRevision: 11, contentHash: 'b'.repeat(64) }
  const retry = await analysisTaskRepository.save({ ...task(), revision: 11, artifactIdentities: { quiz: next } })
  expect(retry?.artifactIdentities?.quiz).toEqual(next)
  expect(store.clearPractices).toHaveBeenCalledTimes(1)
})
it('rejects corrupted identity, cursor, limits and counters without silently dropping the task binding', async () => {
  for (const patch of [
    { version: 2 }, { docId: 'wrong' }, { runId: '../bad' }, { lastEventId: '' },
    { partBytes: 3 }, { partBytes: 512_001 }, { partBytes: 4.5 }, { revision: -1 }, { revision: 1.2 },
    { lastSequence: -2 }, { lastSequence: 0.5 }, { updatedAt: NaN }, { uploadedParts: undefined },
    { uploadedParts: [] }, { uploadedParts: 'bad' }, { updatedAt: -1 },
    { uploadedParts: { missing: 1 } }, { uploadedParts: { [task().request.manifest.sources[0]!.sourceId]: 10_001 } },
    { uploadedParts: { [task().request.manifest.sources[0]!.sourceId]: -1 } },
  ]) expect(() => parseStoredAnalysisTask({ ...task(), ...patch } as StoredAnalysisTask)).toThrow('metadata')
  store.get.mockResolvedValue({ ...task(), revision: -1 }); await expect(analysisTaskRepository.load(task().docId)).rejects.toThrow()
})
it('rejects deleted/newer bindings atomically and merges cursors/counters monotonically', async () => {
  for (const existing of [undefined, { ...task(), request: { ...task().request, requestKey: 'b'.repeat(64) } }, { ...task(), runId: 'other-run' }]) {
    store.get.mockResolvedValueOnce(existing)
    await expect(analysisTaskRepository.save(task())).rejects.toMatchObject({ code: 'conflict' })
  }
  store.doc.mockResolvedValueOnce(undefined); store.get.mockResolvedValueOnce(task())
  await expect(analysisTaskRepository.save(task())).rejects.toMatchObject({ code: 'conflict' })
  store.get.mockResolvedValueOnce({ ...task(), revision: 10, lastSequence: 20, lastEventId: 'event-20', uploadedParts: { [task().request.manifest.sources[0]!.sourceId]: 3 } })
  await analysisTaskRepository.save(task())
  expect(store.put).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 10, lastSequence: 20, lastEventId: 'event-20', uploadedParts: { [task().request.manifest.sources[0]!.sourceId]: 3 } }))
  store.get.mockResolvedValueOnce(undefined)
  await analysisTaskRepository.save({ ...task(), runId: undefined, lastEventId: undefined })
  expect(store.put).toHaveBeenCalled()
})
