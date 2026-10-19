import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analysisRunSchema, type AnalysisEventV1, type AnalysisRequestV1, type AnalysisRunV1, type ArtifactEnvelopeV1, type ArtifactKind, type EngineCapabilitiesV1 } from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'
import { AnalysisClientError, type AnalysisEngineClient } from './engineClient'
import { AnalysisTaskController, analysisActionError, SUMMARY_OUTLINE_OPTIONS } from './taskController'
import { createSourceSnapshot } from './fingerprint'
import * as fingerprints from './fingerprint'
import type { AnalysisTaskRepository, StoredAnalysisTask } from './taskPersistence'
import type { AnalysisBindingChange } from './taskNotifications'

const controllers: AnalysisTaskController[] = []
const source = (): SourceDocument => ({ version: 1, id: 'source-1', docId: 'doc-1', name: 'synthetic.txt', kind: 'text', mime: 'text/plain', size: 12, lastModified: 1, importedAt: 1, extractor: 'synthetic-v1', text: '合成原文 text 🌱', charCount: '合成原文 text 🌱'.length, anchors: [] })
const capabilities: EngineCapabilitiesV1 = { service: 'cat-analysis-engine', serviceVersion: 'synthetic-v1', acceptsRuns: true, degradedReasons: [], contractVersions: [1], qualityProfiles: ['standard'], artifactKinds: ['summary', 'outline'], maxSourcesPerRun: 20, maxSourceCharacters: 2_000_000, maxUploadPartBytes: 512_000, supportsSse: true, supportsCancellation: true, supportsExternalKnowledge: false, retentionSeconds: 3600 }
const clientError = (code: ConstructorParameters<typeof AnalysisClientError>[0] = 'invalid_response', status?: number) => new AnalysisClientError(code, 'Synthetic failure', false, status)
const runFor = (request: AnalysisRequestV1): AnalysisRunV1 => analysisRunSchema.parse({ version: 1, id: 'run-1', docId: request.docId, requestKey: request.requestKey, request, revision: 1, status: 'receiving', stage: 'receiving', progress: 0, coverage: { input: 0, analysis: 0, chunksCompleted: 0, chunksFailed: 0, chunksTotal: 0 }, providerRoutes: [], artifactStates: Object.fromEntries(request.artifacts.map((kind) => [kind, { status: 'pending', attempt: 0, updatedAt: 1 }])), usage: { inputTokens: 20, outputTokens: 10, estimatedCostMicros: 2, currency: 'USD' }, createdAt: 1, updatedAt: 1 })
function harness() {
  let saved: StoredAnalysisTask | undefined
  let sources = [source()]
  let run: AnalysisRunV1 | undefined
  let abandoned = false
  let bindingListener: ((change: AnalysisBindingChange) => void) | undefined
  const artifacts: Partial<Record<ArtifactKind, ArtifactEnvelopeV1>> = {}
  const repository: AnalysisTaskRepository = {
    load: vi.fn(async () => saved && structuredClone(saved)),
    save: vi.fn(async (task) => { saved = structuredClone(task) }),
    remove: vi.fn(async () => { saved = undefined }),
    sources: vi.fn(async () => structuredClone(sources)),
    subscribe: vi.fn((_id, listener) => { bindingListener = listener; return () => { bindingListener = undefined } }),
  }
  const client: AnalysisEngineClient = {
    capabilities: vi.fn(async () => ({ ...capabilities })),
    createRun: vi.fn<AnalysisEngineClient['createRun']>(async (request) => { run = runFor(request); return { version: 1, run, reused: false } }),
    uploadSource: vi.fn<AnalysisEngineClient['uploadSource']>(async (_id, part) => ({ version: 1, sourceId: part.sourceId, receivedParts: part.partCount, partCount: part.partCount, complete: true, computedHash: part.contentHash })),
    startRun: vi.fn(async () => { if (!run) throw new Error(); run = { ...run, revision: 2, status: 'queued' }; return run }),
    getRun: vi.fn(async () => { if (!run) throw clientError('request_failed', 404); return structuredClone(run) }),
    lookupRequest: vi.fn(async () => abandoned ? { version: 1 as const, status: 'abandoned' as const }
      : run ? { version: 1 as const, status: 'found' as const, run: structuredClone(run) } : { version: 1 as const, status: 'absent' as const }),
    abandonRequest: vi.fn(async (requestKey) => { abandoned = true; return { version: 1 as const, requestKey, abandoned: true as const } }),
    getUsage: vi.fn(async () => ({ version: 1 as const, runId: 'run-1', usage: run?.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0, currency: 'USD' },
      invocationCount: 1, unresolvedCount: 0, estimatedInputTokens: 20, reservedOutputTokens: 100, completeness: 'complete' as const })),
    events: vi.fn(async function* () { throw clientError(); yield {} as AnalysisEventV1 }),
    cancel: vi.fn<AnalysisEngineClient['cancel']>(async () => { if (!run) throw new Error(); run = { ...run, revision: run.revision + 1, status: 'cancelled' }; return { version: 1, runId: run.id, revision: run.revision, accepted: true } }),
    retryArtifact: vi.fn<AnalysisEngineClient['retryArtifact']>(async (_id, kind) => { if (!run) throw new Error(); run = { ...run, revision: run.revision + 1, status: 'generating', artifactStates: { ...run.artifactStates, [kind]: { status: 'pending', attempt: 2, updatedAt: 2 } } }; return { version: 1, runId: run.id, kind, revision: run.revision, accepted: true } }),
    getArtifact: vi.fn<AnalysisEngineClient['getArtifact']>(async (_id, kind) => { const artifact = artifacts[kind]; if (!artifact) throw clientError('request_failed', 404); return artifact }),
    deleteContent: vi.fn<AnalysisEngineClient['deleteContent']>(async () => ({ version: 1, runId: 'run-1', deleted: true })),
  }
  const controller = new AnalysisTaskController('doc-1', client, repository)
  controllers.push(controller)
  return { controller, client, repository, artifacts, change(type: AnalysisBindingChange['type']) { bindingListener?.({ version: 1, docId: 'doc-1', type }) }, get saved() { return saved }, set saved(value) { saved = value }, get run() { return run! }, set run(value) { run = value }, get sources() { return sources }, set sources(value) { sources = value } }
}
async function connect(h: ReturnType<typeof harness>) { h.controller.connect(); await vi.waitFor(() => expect(h.controller.getSnapshot().loading).toBe(false)) }
async function seeded(status: AnalysisRunV1['status'] = 'receiving') {
  const h = harness()
  const snapshot = await createSourceSnapshot(source())
  const request: AnalysisRequestV1 = { version: 1, docId: 'doc-1', requestKey: 'a'.repeat(64), manifest: { version: 1, sources: [snapshot] }, artifacts: ['summary', 'outline'], options: SUMMARY_OUTLINE_OPTIONS }
  h.run = { ...runFor(request), status }
  h.saved = { version: 1, docId: 'doc-1', request, runId: 'run-1', partBytes: 16, uploadedParts: {}, revision: 1, lastSequence: -1, updatedAt: 1 }
  return h
}
function summary(h: ReturnType<typeof harness>): Extract<ArtifactEnvelopeV1, { kind: 'summary' }> {
  const point = { id: 'overview', text: '合成摘要', evidenceIds: ['claim'], citations: [{ version: 1 as const, provenance: 'source' as const, sourceId: 'source-1', start: 0, end: 4 }] }
  return { version: 1, schemaVersion: 1, id: 'summary-1', runId: 'run-1', docId: 'doc-1', sourceContentHashes: [h.run.request.manifest.sources[0]!.contentHash], kind: 'summary', payload: { overview: point, keyPoints: [{ ...point, id: 'point' }], confusions: [] }, createdAt: 1, updatedAt: 1 }
}
beforeEach(() => { vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'synthetic-lock' })) } }) })
afterEach(() => { controllers.splice(0).forEach((controller) => controller.disconnect()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('analysis task orchestration', () => {
  it('explains the selected-text limit before persisting any intent and lets the user reduce the same selection', async () => {
    const h = harness()
    await connect(h)
    vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, operatingMode: 'personal', maxSelectedCharacters: 4 })
    await h.controller.create(['source-1'], ['summary'])
    expect(h.controller.getSnapshot().error).toContain('请缩小分析范围')
    expect(h.controller.getSnapshot().task).toBeUndefined()
    expect(h.repository.save).not.toHaveBeenCalled()
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    await h.controller.create(['source-1'], ['summary'], { 'source-1': { start: 0, end: 4 } })
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
    expect(h.saved?.request.manifest.sources[0]?.selectedRange).toEqual({ start: 0, end: 4 })
  })
  it('persists the selected model identity with the explicit intent and refuses a changed selection before create', async () => {
    const h = harness()
    await connect(h)
    const selected = { ...capabilities, operatingMode: 'personal' as const, activeProfileId: 'profile-original' }
    vi.mocked(h.client.capabilities).mockResolvedValueOnce(selected)
      .mockResolvedValueOnce({ ...selected, activeProfileId: 'profile-changed' })
    await h.controller.create(['source-1'], ['summary'])
    expect(h.saved?.request.providerProfileId).toBe('profile-original')
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.controller.getSnapshot().error).toContain('所选模型已改变')
  })
  it.each([undefined, 'profile-original'])('reads a receiving old-model task (%s) without uploading or starting it under a personal selection', async (profileId) => {
    const h = await seeded()
    h.saved = { ...h.saved!, request: { ...h.saved!.request, providerProfileId: profileId } }
    h.run = { ...h.run, request: h.saved.request }
    vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, operatingMode: 'personal', activeProfileId: 'profile-changed' })
    await connect(h)
    await vi.waitFor(() => expect(h.controller.getSnapshot().busy).toBe(false))
    expect(h.client.getRun).toHaveBeenCalled()
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    expect(h.client.startRun).not.toHaveBeenCalled()
    expect(h.client.createRun).not.toHaveBeenCalled()
  })
  it('serializes double clicks, persists intent before create, and uploads the immutable source', async () => {
    const h = harness()
    await connect(h)
    const one = h.controller.create(['source-1'], ['summary', 'outline'])
    expect(h.controller.create(['source-1'], ['summary', 'outline'])).toBe(one)
    await one
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
    expect(h.repository.save).toHaveBeenCalled()
    expect(h.client.startRun).toHaveBeenCalledTimes(1)
    expect(h.saved?.runId).toBe('run-1')
    expect(h.saved?.uploadedParts['source-1']).toBe(1)
    expect(h.client.uploadSource).toHaveBeenCalledWith('run-1', expect.objectContaining({ text: source().text }), expect.any(AbortSignal))
  })
  it('requires current admission and supported nonempty inputs before persisting any task', async () => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.capabilities).mockResolvedValueOnce({ ...capabilities, acceptsRuns: false })
    await h.controller.create(['source-1'], ['summary'])
    expect(h.client.createRun).not.toHaveBeenCalled()
    for (const ids of [[], ['missing']]) await h.controller.create(ids, ['summary'])
    vi.mocked(h.client.capabilities).mockResolvedValueOnce({ ...capabilities, artifactKinds: ['outline'] })
    await h.controller.create(['source-1'], ['summary'])
    h.sources = [{ ...source(), charCount: 2_000_001 }]
    await h.controller.create(['source-1'], ['summary'])
    h.sources = [{ ...source(), text: '', charCount: 0 }]
    await h.controller.create(['source-1'], ['summary'])
    expect(h.repository.save).not.toHaveBeenCalled()
  })
  it('keeps an unconfirmed create and reconciles it only on explicit resume using the same key', async () => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.createRun).mockRejectedValueOnce(new TypeError('Disconnected'))
    await h.controller.create(['source-1'], ['summary'])
    const key = h.saved?.request.requestKey
    expect(h.saved?.runId).toBeUndefined()
    h.controller.disconnect(); await connect(h)
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
    await h.controller.forgetExpired()
    expect(h.saved).toBeDefined()
    await h.controller.resume()
    expect(h.client.lookupRequest).toHaveBeenCalledWith(key, expect.any(AbortSignal))
    expect(h.saved?.request.requestKey).toBe(key)
    expect(h.client.createRun).toHaveBeenCalledTimes(2)
  })
  it('opens receiving tasks read-only and only resends identical parts after explicit resume', async () => {
    const h = await seeded(); await connect(h)
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    expect(h.client.startRun).not.toHaveBeenCalled()
    await h.controller.resume()
    expect(h.client.uploadSource).toHaveBeenCalledTimes(2)
    expect(h.client.startRun).toHaveBeenCalledTimes(1)
    expect(h.saved?.revision).toBe(2)
    await h.controller.resume()
    expect(h.client.startRun).toHaveBeenCalledTimes(1)
  })
  it('does not resume receiving writes while admission is held, but still reads an existing run', async () => {
    const h = await seeded()
    vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, acceptsRuns: false })
    await connect(h)
    expect(h.controller.getSnapshot().run?.id).toBe('run-1')
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    await h.controller.resume()
    expect(h.client.startRun).not.toHaveBeenCalled()
    vi.mocked(h.client.capabilities).mockResolvedValue(capabilities)
    await h.controller.checkService()
    expect(h.controller.getSnapshot().capabilities?.acceptsRuns).toBe(true)
    vi.mocked(h.client.capabilities).mockRejectedValueOnce(new TypeError('offline'))
    await h.controller.checkService()
    expect(h.controller.getSnapshot().capabilities).toBeUndefined()
  })
  it('rejects changed/missing sources and never uploads into the old run', async () => {
    const h = await seeded()
    h.sources = [{ ...source(), text: 'changed', charCount: 7 }]
    await connect(h)
    expect(h.controller.getSnapshot().sourceChanged).toBe(true)
    await h.controller.resume()
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    h.sources = []
    await h.controller.resume()
    expect(h.controller.getSnapshot().sourceChanged).toBe(true)
  })
  it('checks created/run identity and upload receipt identity before start', async () => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.createRun).mockImplementationOnce(async (request) => ({ version: 1, run: { ...runFor(request), docId: 'other-doc' }, reused: false }))
    await h.controller.create(['source-1'], ['summary'])
    expect(h.client.startRun).not.toHaveBeenCalled()
    await h.controller.resume()
    h.run = { ...h.run, id: 'other-run' }
    await h.controller.resume()
    expect(h.controller.getSnapshot().error).toContain('未通过校验')
    const h2 = await seeded()
    vi.mocked(h2.client.uploadSource).mockResolvedValue({ version: 1, sourceId: 'wrong', partCount: 2, receivedParts: 2, complete: true, computedHash: '0'.repeat(64) })
    await connect(h2)
    expect(h2.client.uploadSource).not.toHaveBeenCalled()
    await h2.controller.resume()
    expect(h2.client.startRun).not.toHaveBeenCalled()
    expect(h2.controller.getSnapshot().error).toContain('未通过校验')
  })
  it('loads partial success independently and prevents wrong artifact identity/hash from rendering', async () => {
    const h = await seeded('partial')
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: 'summary-1', attempt: 1, updatedAt: 1 }, outline: { status: 'failed', attempt: 1, updatedAt: 1, error: { version: 1, code: 'provider_unavailable', category: 'provider', retryable: false, messageKey: 'analysis.unknown', details: { reason: 'invocation_outcome_unknown' } } } } }
    h.artifacts.summary = summary(h)
    await connect(h)
    expect(h.controller.getSnapshot().mirror?.artifacts.summary).toEqual(h.artifacts.summary)
    await h.controller.resume()
    expect(h.client.getArtifact).toHaveBeenCalledTimes(1)
    await h.controller.retry('outline')
    expect(h.client.retryArtifact).not.toHaveBeenCalled()
    h.artifacts.summary = { ...summary(h), docId: 'other-doc' }
    h.controller.disconnect(); await connect(h)
    // Existing cache is cleared by remounting a controller, as the React document key does.
    const second = new AnalysisTaskController('doc-1', h.client, h.repository); controllers.push(second); second.connect()
    await vi.waitFor(() => expect(second.getSnapshot().loading).toBe(false))
    expect(second.getSnapshot().error).toContain('未通过校验')
    expect(second.getSnapshot().mirror?.artifacts.summary).toBeUndefined()
    h.artifacts.summary = { ...summary(h), sourceContentHashes: ['b'.repeat(64)] }
    await second.resume()
    expect(second.getSnapshot().mirror?.artifacts.summary).toBeUndefined()
  })
  it('performs explicit CAS retry, clears obsolete results, cancels then deletes and preserves source documents', async () => {
    const h = await seeded('partial')
    h.run = { ...h.run, artifactStates: { ...h.run.artifactStates, outline: { status: 'failed', attempt: 1, updatedAt: 1, error: { version: 1, code: 'provider_timeout', category: 'provider', retryable: true, messageKey: 'analysis.timeout' } } } }
    await connect(h)
    await h.controller.retry('outline')
    expect(h.client.retryArtifact).toHaveBeenCalledWith('run-1', 'outline', 1, expect.any(AbortSignal))
    await h.controller.cancel()
    expect(h.controller.getSnapshot().run?.status).toBe('cancelled')
    await h.controller.deleteContent()
    expect(h.saved).toBeUndefined()
    expect(h.controller.getSnapshot().mirror).toBeUndefined()
    expect(h.sources).toHaveLength(1)
    await h.controller.create(['source-1'], ['summary'])
    expect(h.saved?.request.requestKey).not.toBe('a'.repeat(64))
  })
  it('cancels active work before content deletion and retains binding on unconfirmed deletion', async () => {
    const h = await seeded('generating'); await connect(h)
    vi.mocked(h.client.deleteContent).mockResolvedValueOnce({ version: 1, runId: 'other-run', deleted: true })
    await h.controller.deleteContent()
    expect(h.client.cancel).toHaveBeenCalledTimes(1)
    expect(h.saved).toBeDefined()
    vi.mocked(h.client.deleteContent).mockResolvedValueOnce({ version: 1, runId: 'run-1', deleted: false })
    await h.controller.deleteContent()
    expect(h.saved).toBeUndefined()
  })
  it('forgets only confirmed expired or missing runs and never blindly discards retained content', async () => {
    const h = await seeded('succeeded'); await connect(h)
    await h.controller.forgetExpired(); expect(h.saved).toBeDefined()
    h.run = { ...h.run, status: 'expired' }
    await h.controller.resume()
    expect(h.controller.getSnapshot().mirror?.artifacts).toEqual({})
    await h.controller.forgetExpired(); expect(h.saved).toBeUndefined()
    const h2 = await seeded('succeeded'); await connect(h2)
    vi.mocked(h2.client.getRun).mockRejectedValueOnce(clientError('request_failed', 404))
    await h2.controller.forgetExpired(); expect(h2.saved).toBeUndefined()
  })
  it('prevents stale tab bindings from overwriting a newer task and fails closed without Web Locks', async () => {
    const h = harness(); await connect(h)
    const another = await seeded('succeeded'); h.saved = another.saved
    await h.controller.create(['source-1'], ['summary'])
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.controller.getSnapshot().task?.runId).toBe('run-1')
    vi.stubGlobal('navigator', {})
    await h.controller.cancel()
    expect(h.client.cancel).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', { locks: { request: async (_a: unknown, _b: unknown, callback: (lock: null) => Promise<void>) => callback(null) } })
    await h.controller.cancel()
    expect(h.client.cancel).not.toHaveBeenCalled()
  })
  it('handles capability/storage failures and StrictMode reconnect without duplicate creation', async () => {
    const h = await seeded('succeeded')
    vi.mocked(h.client.capabilities).mockRejectedValue(clientError('service_unavailable'))
    const cleanup = h.controller.connect(); cleanup(); await connect(h)
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.controller.getSnapshot().run?.id).toBe('run-1')
    expect(h.controller.getSnapshot().capabilities).toBeUndefined()
    const bad = harness(); vi.mocked(bad.repository.load).mockRejectedValue(new Error('corrupt'))
    await connect(bad)
    expect(bad.controller.getSnapshot().error).toContain('本地存储失败')
    bad.controller.disconnect()
    expect(() => bad.controller.create(['source-1'], ['summary'])).toThrow('disconnected')
  })
  it('reconciles revision conflicts without repeating mutation', async () => {
    const h = await seeded('generating'); await connect(h)
    vi.mocked(h.client.cancel).mockRejectedValueOnce(clientError('conflict', 409))
    await h.controller.cancel()
    expect(h.client.cancel).toHaveBeenCalledTimes(1)
    expect(h.controller.getSnapshot().error).toContain('状态已改变')
  })
  it('reduces repeated/out-of-order events and persists cursor only after snapshot and artifact retrieval', async () => {
    const h = await seeded('queued')
    vi.mocked(h.client.events).mockImplementation(async function* () {
      const event: AnalysisEventV1 = { version: 1, type: 'progress.updated', eventId: 'event-1', runId: 'run-1', runRevision: 1, sequence: 1, createdAt: 2, stage: 'mapping', progress: 0.3 }
      yield event; yield event; yield { ...event, eventId: 'event-0', sequence: 0 }; yield { ...event, runId: 'wrong', eventId: 'event-other', sequence: 2 }
      h.run = { ...h.run, revision: 2, status: 'succeeded', progress: 1 }
      yield { version: 1, type: 'run.completed', runId: 'run-1', runRevision: 2, sequence: 3, eventId: 'event-3', createdAt: 3, status: 'succeeded', coverage: h.run.coverage }
    })
    await connect(h)
    await vi.waitFor(() => expect(h.saved?.lastEventId).toBe('event-3'))
    expect(h.controller.getSnapshot().mirror?.lastSequence).toBe(3)
    expect(h.client.createRun).not.toHaveBeenCalled()
  })
  it('recovers from a temporary stream failure using read-only polling', async () => {
    vi.useFakeTimers()
    const h = await seeded('queued')
    let calls = 0
    vi.mocked(h.client.events).mockImplementation(async function* () {
      calls++
      h.run = { ...h.run, status: 'succeeded' }
      if (calls === 1) throw new AnalysisClientError('service_unavailable', 'temporary', true)
      yield* []
    })
    await connect(h)
    // 轮询降级后每 2 秒一次快照读取；快照链路含原生异步步骤（哈希），
    // waitFor 的每轮重试让出真实事件循环，避免 fake timers 下链路饿死。
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
      expect(calls).toBe(1)
      expect(h.controller.getSnapshot().run?.status).toBe('succeeded')
    }, { timeout: 10_000 })
    expect(h.client.startRun).not.toHaveBeenCalled()
    expect(h.client.createRun).not.toHaveBeenCalled()
  })
  it('rotates a silent event stream every 30 seconds instead of degrading to polling', async () => {
    vi.useFakeTimers()
    const h = await seeded('generating')
    let streams = 0
    // 静默流生成器有意不 yield：保持挂起直到被轮转/中止信号打断，模拟真实 SSE 长连接。
    // eslint-disable-next-line require-yield
    vi.mocked(h.client.events).mockImplementation(async function* (_runId: string, init?: { signal?: AbortSignal }) {
      streams++
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    await connect(h)
    // 轮转后继续流订阅（streams 增长）；若轮转被误判为流结束会永久降级轮询（streams 停在 1）。
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
      expect(streams).toBeGreaterThanOrEqual(2)
    }, { timeout: 15_000 })
    expect(h.controller.getSnapshot().run?.status).toBe('generating')
    expect(h.client.startRun).not.toHaveBeenCalled()
  })
  it('reports errors without disclosing transport messages or secrets', () => {
    for (const status of [404, 410]) expect(analysisActionError(clientError('request_failed', status))).toContain('已删除或过期')
    for (const code of ['unauthorized', 'forbidden'] as const) expect(analysisActionError(clientError(code))).toContain('拒绝访问')
    for (const code of ['invalid_response', 'response_too_large'] as const) expect(analysisActionError(clientError(code))).toContain('校验')
    expect(analysisActionError(clientError('rate_limited'))).toContain('稍后自动恢复')
    expect(analysisActionError(clientError('rate_limited'))).not.toContain('拒绝')
    expect(analysisActionError(new Error('secret'))).not.toContain('secret')
  })
})

describe('audit recovery regressions', () => {
  it.each(['silent', 'closed', 'unavailable', 'unsupported'] as const)('reconciles terminal state with %s SSE without generating again', async (mode) => {
    vi.useFakeTimers()
    const h = await seeded('mapping')
    vi.spyOn(fingerprints, 'createSourceSnapshot').mockResolvedValue(h.run.request.manifest.sources[0]!)
    if (mode === 'unsupported') vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, supportsSse: false })
    vi.mocked(h.client.events).mockImplementation(async function* (_id, { signal }) {
      if (mode === 'unavailable') throw new TypeError('private-network-detail')
      if (mode === 'silent') await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        if (signal.aborted) reject(signal.reason)
      })
      yield* []
    })
    await connect(h)
    await vi.advanceTimersByTimeAsync(1)
    h.run = { ...h.run, status: 'failed', revision: 2,
      error: { version: 1, code: 'provider_unavailable', category: 'availability', retryable: false,
        messageKey: 'analysis.provider.invocation_unavailable', details: { reason: 'invocation_outcome_unknown', providerCode: 'request_timeout' } } }
    // Silent SSE is discovered by the 30s stream rotation + snapshot reconciliation;
    // degraded modes converge faster via bounded polling. 31s covers both paths.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.controller.getSnapshot().run?.status).toBe('failed')
    expect(h.controller.getSnapshot().run?.error?.details?.providerCode).toBe('request_timeout')
    expect(h.controller.getSnapshot().error).toBeUndefined()
    const reads = vi.mocked(h.client.getRun).mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.client.getRun).toHaveBeenCalledTimes(reads)
    if (mode === 'unsupported') expect(h.client.events).not.toHaveBeenCalled()
    for (const mutation of [h.client.createRun, h.client.startRun, h.client.retryArtifact, h.client.uploadSource]) expect(mutation).not.toHaveBeenCalled()
    h.controller.disconnect()
  })

  it.each(['changed', 'deleted'])('reconciles a lost create response with %s source even while held, without uploading', async (change) => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.createRun).mockImplementationOnce(async (request) => { h.run = runFor(request); throw new TypeError('Synthetic lost response') })
    await h.controller.create(['source-1'], ['summary'])
    h.sources = change === 'changed' ? [{ ...source(), text: 'changed', charCount: 7 }] : []
    vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, acceptsRuns: false })
    await h.controller.checkService()
    await h.controller.resume()
    expect(h.saved?.runId).toBe('run-1')
    expect(h.controller.getSnapshot().sourceChanged).toBe(true)
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
    expect(h.client.uploadSource).not.toHaveBeenCalled()
    await h.controller.deleteContent()
    expect(h.saved).toBeUndefined()
    expect(h.client.deleteContent).toHaveBeenCalledTimes(1)
  })
  it('abandons an unconfirmed intent and resolves a lost acknowledgement through a readonly lookup', async () => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.createRun).mockRejectedValueOnce(new TypeError('lost response'))
    await h.controller.create(['source-1'], ['summary'])
    const key = h.saved!.request.requestKey
    vi.mocked(h.client.abandonRequest).mockImplementationOnce(async (requestKey) => {
      expect(requestKey).toBe(key)
      vi.mocked(h.client.lookupRequest).mockResolvedValue({ version: 1, status: 'abandoned' })
      throw new TypeError('lost acknowledgement')
    })
    await h.controller.deleteContent()
    expect(h.saved).toBeDefined()
    await h.controller.resume()
    expect(h.saved).toBeUndefined()
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
    expect(h.client.abandonRequest).toHaveBeenCalledTimes(1)
  })
  it('loads healthy Outline despite Summary GET failure, then retries terminal reads without new invocations', async () => {
    const h = await seeded('succeeded')
    h.artifacts.summary = summary(h)
    h.artifacts.outline = { ...summary(h), id: 'outline-1', kind: 'outline', payload: { title: '合法大纲', nodes: [{ id: 'root', title: '健康结果', evidenceIds: [], citations: [], children: [] }] } }
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: 'summary-1', attempt: 1, updatedAt: 1 }, outline: { status: 'succeeded', artifactId: 'outline-1', attempt: 1, updatedAt: 1 } } }
    const original = vi.mocked(h.client.getArtifact).getMockImplementation()!
    vi.mocked(h.client.getArtifact).mockImplementationOnce(async () => { throw new AnalysisClientError('service_unavailable', 'Synthetic GET failure', true, 503) }).mockImplementation(original)
    await connect(h)
    expect(h.controller.getSnapshot().mirror?.artifacts.outline?.id).toBe('outline-1')
    expect(h.controller.getSnapshot().artifactReadErrors.summary?.retryable).toBe(true)
    await vi.waitFor(() => expect(h.controller.getSnapshot().mirror?.artifacts.summary?.id).toBe('summary-1'), { timeout: 2000 })
    expect(h.client.createRun).not.toHaveBeenCalled()
    expect(h.client.retryArtifact).not.toHaveBeenCalled()
    expect(h.saved?.artifactIdentities?.outline?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('clears terminal caches synchronously on another tab deletion', async () => {
    const h = await seeded('succeeded'); h.artifacts.summary = summary(h)
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: 'summary-1', attempt: 1, updatedAt: 1 } } }
    await connect(h)
    expect(h.controller.getSnapshot().mirror?.artifacts.summary).toBeDefined()
    h.saved = undefined
    h.change('deleted')
    expect(h.controller.getSnapshot().mirror).toBeUndefined()
    await vi.waitFor(() => expect(h.controller.getSnapshot().loading).toBe(false))
    expect(h.controller.getSnapshot().task).toBeUndefined()
    expect(h.client.createRun).not.toHaveBeenCalled()
  })
  it('a late artifact GET cannot repopulate a deleted binding even if the transport ignores abort', async () => {
    const h = await seeded('succeeded'); const artifact = summary(h)
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: artifact.id, attempt: 1, updatedAt: 1 } } }
    let resolve!: (value: ArtifactEnvelopeV1) => void
    vi.mocked(h.client.getArtifact).mockImplementationOnce(() => new Promise((yes) => { resolve = yes }))
    h.controller.connect()
    await vi.waitFor(() => expect(h.client.getArtifact).toHaveBeenCalledTimes(1))
    h.saved = undefined; h.change('deleted')
    expect(h.controller.getSnapshot().mirror).toBeUndefined()
    resolve(artifact)
    await vi.waitFor(() => expect(h.controller.getSnapshot().loading).toBe(false))
    expect(h.saved).toBeUndefined(); expect(h.controller.getSnapshot().mirror).toBeUndefined()
  })
  it('a fresh response cannot change immutable content under the same artifact ID', async () => {
    const h = await seeded('succeeded'); const artifact = summary(h)
    h.artifacts.summary = artifact
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: artifact.id, attempt: 1, updatedAt: 1 } } }
    await connect(h)
    h.artifacts.summary = { ...artifact, payload: { ...artifact.payload, overview: { ...artifact.payload.overview, text: '擅自改变的结果' } } }
    h.controller.disconnect(); await connect(h)
    expect(h.controller.getSnapshot().mirror?.artifacts.summary).toBeUndefined()
    expect(h.controller.getSnapshot().artifactReadErrors.summary?.retryable).toBe(false)
    expect(h.saved?.artifactIdentities?.summary).toBeUndefined()
  })
  it('bounds terminal readonly retries without opening an event stream or paid action', async () => {
    vi.useFakeTimers()
    const h = await seeded('succeeded')
    vi.spyOn(fingerprints, 'createSourceSnapshot').mockResolvedValue(h.run.request.manifest.sources[0]!)
    h.run = { ...h.run, artifactStates: { summary: { status: 'succeeded', artifactId: 'summary-1', attempt: 1, updatedAt: 1 } } }
    vi.mocked(h.client.getArtifact).mockRejectedValue(new AnalysisClientError('service_unavailable', 'temporary', true, 503))
    await connect(h)
    let calls = 1
    for (const pause of [500, 1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(pause)
      calls++
      await vi.waitFor(() => expect(h.client.getArtifact).toHaveBeenCalledTimes(calls), { interval: 1 })
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.getArtifact).toHaveBeenCalledTimes(6)
    expect(h.client.events).not.toHaveBeenCalled()
    expect(h.client.retryArtifact).not.toHaveBeenCalled()
    expect(h.client.createRun).not.toHaveBeenCalled()
    h.controller.disconnect(); vi.useRealTimers()
  })
  it('includes Outline for MindMap, sends explicit Quiz count and rejects unsupported external knowledge', async () => {
    const h = harness(); await connect(h)
    vi.mocked(h.client.capabilities).mockResolvedValue({ ...capabilities, artifactKinds: ['summary', 'outline', 'mindmap', 'quiz', 'knowledge'] })
    await h.controller.create(['source-1'], ['mindmap', 'quiz'], {}, { ...SUMMARY_OUTLINE_OPTIONS, quizQuestionCount: 10 })
    expect(h.saved?.request.artifacts).toEqual(['outline', 'mindmap', 'quiz'])
    expect(h.saved?.request.options.quizQuestionCount).toBe(10)
    await h.controller.deleteContent()
    await h.controller.create(['source-1'], ['knowledge'], {}, { ...SUMMARY_OUTLINE_OPTIONS, externalKnowledge: true })
    expect(h.client.createRun).toHaveBeenCalledTimes(1)
  })
})
