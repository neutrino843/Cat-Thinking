import { afterEach, describe, expect, it, vi } from 'vitest'
import { analysisEventSchema, analysisRunSchema, type ProviderRouteV1 } from '@cat-thinking/analysis-contracts'
import { PersistentDispatcher } from '../src/domain/persistentDispatcher.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION } from '../src/providers/evidenceMapPrompt.js'
import type { ModelProvider } from '../src/providers/modelProvider.js'
import { RunService } from '../src/domain/runService.js'
import { MemoryPersonalProfileStore, personalFixtureSettings } from './fixtures/personalProviderFixture.js'

afterEach(() => vi.useRealTimers())
const prepare = async (key: string, now: () => number = Date.now) => {
  const store = new InMemoryJobStore()
  const { service, runId } = await prepareFixtureRun(store, key, now)
  const provider = new FakeAnalysisProvider()
  const runtime = createAnalysisProviderRuntime({ store, provider, broker: service.broker, leaseMs: 120, now, estimateCostMicros: () => 1 })
  const options = { store, ...runtime, cleanupExpired: () => service.cleanupExpired(10), leaseMs: 120, pollMs: 10, maxRunMs: 1000, now }
  return { store, service, runId, provider, runtime, options }
}
const block = (signal: AbortSignal) => new Promise<string>((_, reject) => {
  if (signal.aborted) { reject(signal.reason); return }
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

const pinPlanningRoute = async (store: InMemoryJobStore, runId: string, route: ProviderRouteV1, now: number) => {
  const current = (await store.getRun(FIXTURE_TENANT, runId))!
  await store.transitionRun(FIXTURE_TENANT, runId, current.revision, (run, sequence) => {
    const next = analysisRunSchema.parse({ ...run, revision: run.revision + 1, status: 'planning', stage: 'planning',
      progress: 0.05, providerRoutes: [route], updatedAt: now })
    return { run: next, event: analysisEventSchema.parse({ version: 1, type: 'stage.started', eventId: `planning-${runId}`,
      runId, runRevision: next.revision, sequence, createdAt: now, stage: 'planning' }) }
  })
}

describe('persistent dispatcher', () => {
  it('makes progress through a backlog larger than the lease window across expiry and competing instances', async () => {
    let time = 1_000
    const now = () => time
    const store = new InMemoryJobStore()
    const provider = new FakeAnalysisProvider()
    const incompatible: { runId: string; run: Awaited<ReturnType<typeof store.getRun>> }[] = []
    for (let index = 0; index < 40; index += 1) {
      const prepared = await prepareFixtureRun(store, `large-incompatible-${index}`, now)
      await pinPlanningRoute(store, prepared.runId, { providerId: provider.id, modelId: provider.modelId,
        profileVersion: provider.profileVersion, promptVersion: 'evidence-source-ref-v999' }, time)
      incompatible.push({ runId: prepared.runId, run: await store.getRun(FIXTURE_TENANT, prepared.runId) })
      time += 1
    }
    const current = await prepareFixtureRun(store, 'large-backlog-compatible', now)
    const attempts: string[] = []
    const makeDispatcher = (ownerId: string) => {
      const runtime = createAnalysisProviderRuntime({ store, provider, broker: current.service.broker,
        leaseMs: 120, now, estimateCostMicros: () => 1 })
      const evidence = { runOnce: async (...args: Parameters<typeof runtime.evidence.runOnce>) => {
        attempts.push(args[1]); return runtime.evidence.runOnce(...args)
      } }
      return new PersistentDispatcher({ store, evidence, artifacts: runtime.artifacts, ownerId, cleanupExpired: async () => undefined,
        leaseMs: 120, pollMs: 10, maxRunMs: 1_000, concurrency: 1, now })
    }
    const first = makeDispatcher('large-backlog-first')
    const second = makeDispatcher('large-backlog-second')
    const initialTime = time
    // Both instances may discover the same oldest row before either acquires it;
    // fencing permits only one winner, so N older rows need at most N+1 rounds.
    for (let round = 0; round < incompatible.length + 1; round += 1) {
      await Promise.all([first.tick(), second.tick()])
      if ((await store.getRun(FIXTURE_TENANT, current.runId))!.status === 'succeeded') break
      time += 25
    }
    expect(time - initialTime).toBeGreaterThan(120)
    expect((await store.getRun(FIXTURE_TENANT, current.runId))!.status).toBe('succeeded')
    expect(provider.calls).toHaveLength(6)
    for (const entry of incompatible) {
      expect(attempts.filter((runId) => runId === entry.runId)).toHaveLength(1)
      expect(await store.getRun(FIXTURE_TENANT, entry.runId)).toEqual(entry.run)
      expect(await store.getSourceContent(FIXTURE_TENANT, entry.runId, 'synthetic-source')).toMatchObject({ text: FIXTURE_TEXT })
      expect(await store.getRunLedgerUsage(FIXTURE_TENANT, entry.runId)).toMatchObject({ invocationCount: 0 })
    }
    await Promise.all([first.stop(500), second.stop(500)])
  })

  it('uses the same active-lease filtering and expired-lease ranking for the personal memory profile fixture before LIMIT', async () => {
    let time = 1_000
    const store = new InMemoryJobStore()
    const profiles = new MemoryPersonalProfileStore(store)
    const saved = await profiles.save(0, personalFixtureSettings())
    await profiles.setCheck(saved.revision, 'ready')
    await profiles.setEnabled(saved.revision + 1, true)
    const profileId = saved.profileId!
    const service = new RunService({ store, retentionSeconds: 3600, now: () => time, providerProfileMode: 'personal' })
    const create = async (name: string, bound: boolean, requestProfile = profileId) => {
      const created = await service.createRun(FIXTURE_TENANT, { ...fixtureRequest(name, ['summary']), providerProfileId: requestProfile })
      if (bound) profiles.bindings.set(`${FIXTURE_TENANT}:${created.run.id}`, requestProfile)
      await service.uploadSource(FIXTURE_TENANT, created.run.id, { version: 1, sourceId: 'synthetic-source',
        contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
        start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
      await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
      time += 1
      return { tenantId: FIXTURE_TENANT, runId: created.run.id }
    }
    const deferred = await create('personal-deferred', true)
    const untouched = await create('personal-untouched', true)
    await create('personal-unbound', false)
    await create('personal-other-profile', true, 'other-synthetic-profile')
    const newer = await create('personal-newer', true)
    const before = await store.getRun(FIXTURE_TENANT, deferred.runId)
    await store.acquireLease({ ...deferred, nodeKey: 'dispatcher:run', ownerId: 'incompatible-profile-worker', now: time, durationMs: 120 })
    // Leases for individual work nodes do not suppress discovery of the run.
    await store.acquireLease({ ...untouched, nodeKey: 'artifact:summary', ownerId: 'artifact-worker', now: time, durationMs: 500 })
    expect(await profiles.listDispatchableRuns(time, 2)).toEqual([untouched, newer])
    time += 120
    expect(await profiles.listDispatchableRuns(time, 2)).toEqual([untouched, newer])
    expect(await profiles.listDispatchableRuns(time, 3)).toEqual([untouched, newer, deferred])
    expect(await store.getRun(FIXTURE_TENANT, deferred.runId)).toEqual(before)
    expect(await store.listDispatchableRuns(time, 10)).toEqual([])
    await expect(profiles.listDispatchableRuns(time, 0)).rejects.toThrow('positive')
  })

  it('defers two older profile-mismatched runs durably, lets newer work finish, and recovers them after bounded expiry', async () => {
    let time = 1_000
    const now = () => time
    const store = new InMemoryJobStore()
    const first = await prepareFixtureRun(store, 'older-mismatched-first', now)
    time += 1
    const second = await prepareFixtureRun(store, 'older-mismatched-second', now)
    time += 1
    const current = await prepareFixtureRun(store, 'newer-compatible', now)
    const restoredSynthetic = new FakeAnalysisProvider()
    const restoredProvider: ModelProvider = { id: 'restored-synthetic-provider', modelId: 'restored-synthetic-model',
      profileVersion: 'restored-synthetic-profile', capabilities: restoredSynthetic.capabilities,
      isReady: () => true, generate: restoredSynthetic.generate.bind(restoredSynthetic) }
    const oldRoute = { providerId: restoredProvider.id, modelId: restoredProvider.modelId,
      profileVersion: restoredProvider.profileVersion, promptVersion: EVIDENCE_ARTIFACT_REF_PROMPT_VERSION }
    await pinPlanningRoute(store, first.runId, oldRoute, 1_000)
    await pinPlanningRoute(store, second.runId, oldRoute, 1_001)
    await store.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId: first.runId,
      invocationId: 'retained-synthetic-usage', nodeKey: 'retained:synthetic-proof', runAttempt: 1, role: 'artifact-summary',
      ...oldRoute, estimatedInputTokens: 1, reservedOutputTokens: 1, estimatedCostMicros: 1,
      maxRunEstimatedTokens: 4_000_000, maxRunEstimatedCostMicros: 50_000_000, staleAfterMs: 600_000, now: time })
    await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'retained-synthetic-usage',
      result: 'succeeded', actualInputTokens: 7, actualOutputTokens: 4, transportAttempts: 1, now: time })
    const preserved = await Promise.all([first.runId, second.runId].map(async (runId) => ({
      run: await store.getRun(FIXTURE_TENANT, runId), source: await store.getSourceContent(FIXTURE_TENANT, runId, 'synthetic-source'),
      ledger: await store.getRunLedgerUsage(FIXTURE_TENANT, runId),
    })))
    const provider = new FakeAnalysisProvider()
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: current.service.broker,
      leaseMs: 120, now, estimateCostMicros: () => 1 })
    const options = { store, ...runtime, cleanupExpired: async () => undefined, leaseMs: 120, pollMs: 10, maxRunMs: 1000, now }
    const dispatcher = new PersistentDispatcher({ ...options, ownerId: 'current-consumer' })
    const releases = vi.spyOn(store, 'releaseLease')
    await dispatcher.tick()
    expect(provider.calls).toHaveLength(0)
    expect(releases).not.toHaveBeenCalled()
    expect(await store.listDispatchableRuns(time, 10)).toEqual([{ tenantId: FIXTURE_TENANT, runId: current.runId }])
    for (const [index, runId] of [first.runId, second.runId].entries()) {
      expect(await store.getRun(FIXTURE_TENANT, runId)).toEqual(preserved[index]!.run)
      expect(await store.getSourceContent(FIXTURE_TENANT, runId, 'synthetic-source')).toEqual(preserved[index]!.source)
      expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual(preserved[index]!.ledger)
    }
    await dispatcher.tick()
    expect((await current.service.getRun(FIXTURE_TENANT, current.runId)).status).toBe('succeeded')
    expect(provider.calls).toHaveLength(6)
    await dispatcher.stop(500)
    // A process restart does not forget the deferral: the persisted lease still excludes both runs.
    const restoredRuntime = createAnalysisProviderRuntime({ store, provider: restoredProvider, broker: current.service.broker,
      leaseMs: 120, now, estimateCostMicros: () => 1 })
    const restored = new PersistentDispatcher({ ...options, ...restoredRuntime, ownerId: 'restored-consumer' })
    time = 1_121
    await restored.tick()
    expect(restoredSynthetic.calls).toHaveLength(0)
    time = 1_122
    await restored.tick()
    expect(restoredSynthetic.calls).toHaveLength(12)
    expect((await first.service.getRun(FIXTURE_TENANT, first.runId)).status).toBe('succeeded')
    expect((await second.service.getRun(FIXTURE_TENANT, second.runId)).status).toBe('succeeded')
    expect(await store.getProviderInvocation(FIXTURE_TENANT, 'retained-synthetic-usage'))
      .toMatchObject({ status: 'succeeded', actualInputTokens: 7, actualOutputTokens: 4, transportAttempts: 1 })
    await restored.stop(500)
  })

  it.each(['evidence', 'artifacts'] as const)('defers an unknown execution version rejected by %s without changing its data or invoking the Provider', async (stage) => {
    const f = await prepare(`unknown-version-${stage}`, () => 1_000)
    if (stage === 'artifacts') await f.runtime.evidence.runOnce(FIXTURE_TENANT, f.runId, 'prepare-owner', new AbortController().signal)
    const current = (await f.store.getRun(FIXTURE_TENANT, f.runId))!
    await f.store.transitionRun(FIXTURE_TENANT, f.runId, current.revision, (run, sequence) => ({
      run: analysisRunSchema.parse({ ...run, revision: run.revision + 1,
        providerRoutes: [{ providerId: f.provider.id, modelId: f.provider.modelId, profileVersion: f.provider.profileVersion,
          promptVersion: 'evidence-source-ref-v999' }] }),
      event: analysisEventSchema.parse({ version: 1, type: 'usage.updated', eventId: `future-${stage}`, runId: run.id,
        runRevision: run.revision + 1, sequence, createdAt: 1_000, usage: run.usage }),
    }))
    const before = await f.store.getRun(FIXTURE_TENANT, f.runId)
    const source = await f.store.getSourceContent(FIXTURE_TENANT, f.runId, 'synthetic-source')
    const ledger = await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)
    const callsBefore = f.provider.calls.length
    const release = vi.spyOn(f.store, 'releaseLease')
    const dispatcher = new PersistentDispatcher({ ...f.options, ownerId: 'unsupported-consumer' })
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(callsBefore)
    expect(release).not.toHaveBeenCalled()
    expect(await f.store.getRun(FIXTURE_TENANT, f.runId)).toEqual(before)
    expect(await f.store.getSourceContent(FIXTURE_TENANT, f.runId, 'synthetic-source')).toEqual(source)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toEqual(ledger)
    expect(await f.store.listDispatchableRuns(1_119, 5)).toEqual([])
    expect(await f.store.listDispatchableRuns(1_120, 5)).toEqual([{ tenantId: FIXTURE_TENANT, runId: f.runId }])
    await dispatcher.stop(500)
  })

  it.each([
    { outcome: 'busy', reason: 'unsupported_execution_version' },
    { outcome: 'stopped' },
    { outcome: 'stopped', reason: 'cancelled' },
    { outcome: 'stopped', reason: 'aborted' },
  ])('releases normal worker result $outcome/$reason rather than pausing arbitrary stopped work', async (result) => {
    const f = await prepare(`ordinary-stop-${JSON.stringify(result)}`, () => 1_000)
    const dispatcher = new PersistentDispatcher({ ...f.options, ownerId: 'ordinary-owner',
      evidence: { runOnce: async () => result } })
    await dispatcher.tick()
    expect(await f.store.listDispatchableRuns(1_000, 5)).toEqual([{ tenantId: FIXTURE_TENANT, runId: f.runId }])
    expect(await f.store.acquireLease({ tenantId: FIXTURE_TENANT, runId: f.runId, nodeKey: 'dispatcher:run',
      ownerId: 'immediate-successor', now: 1_000, durationMs: 120 })).toMatchObject({ attempt: 2 })
    expect(f.provider.calls).toHaveLength(0)
    await dispatcher.stop(500)
  })

  it('releases leases on worker exceptions and on shutdown during an in-flight mismatch result', async () => {
    const f = await prepare('dispatch-worker-exception', () => 1_000)
    const broken = new PersistentDispatcher({ ...f.options, ownerId: 'broken-worker',
      evidence: { runOnce: async () => { throw new Error('synthetic_worker_failure') } } })
    await expect(broken.tick()).rejects.toThrow('synthetic_worker_failure')
    expect(await f.store.listDispatchableRuns(1_000, 5)).toEqual([{ tenantId: FIXTURE_TENANT, runId: f.runId }])
    await broken.stop(500)
    const release = vi.spyOn(f.store, 'releaseLease')
    const workerStarted = vi.fn()
    const stopped = new PersistentDispatcher({ ...f.options, ownerId: 'shutdown-worker', evidence: {
      runOnce: async (_tenantId, _runId, _ownerId, signal) => {
        workerStarted()
        await block(signal).catch(() => undefined)
        return { outcome: 'stopped', reason: 'provider_profile_mismatch' }
      },
    } })
    const tick = stopped.tick()
    await vi.waitFor(() => expect(workerStarted).toHaveBeenCalledOnce())
    await stopped.stop(500)
    await tick
    expect(release).toHaveBeenCalledOnce()
    expect(await f.store.listDispatchableRuns(1_000, 5)).toEqual([{ tenantId: FIXTURE_TENANT, runId: f.runId }])
    expect(f.provider.calls).toHaveLength(0)
  })

  it('recovers health before evaluating execution readiness without depending on its own admission flag', async () => {
    const f = await prepare('dispatcher-health-recovery')
    let healthy = false
    vi.spyOn(f.store, 'checkHealth').mockImplementation(async () => healthy)
    const dispatcher = new PersistentDispatcher({ ...f.options, canDispatch: async () => healthy })
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(0)
    healthy = true
    await dispatcher.tick()
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('succeeded')
    expect(f.provider.calls).toHaveLength(6)
  })
  it('refuses acquisition while the release proof is closed or unreadable', async () => {
    const f = await prepare('release-closed')
    const cleanup = vi.fn(async () => undefined)
    const canDispatch = vi.fn(async () => false)
    const dispatcher = new PersistentDispatcher({ ...f.options, cleanupExpired: cleanup, canDispatch })
    await dispatcher.tick()
    canDispatch.mockRejectedValueOnce(new Error('proof_unreadable'))
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(0)
    expect(cleanup).not.toHaveBeenCalled()
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('queued')
    canDispatch.mockResolvedValue(true)
    await dispatcher.tick()
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('succeeded')
  })
  it('aborts in-flight network work when a release proof is revoked', async () => {
    const f = await prepare('release-revoked')
    let ready = true
    f.provider.override = (_request, signal) => block(signal)
    const dispatcher = new PersistentDispatcher({ ...f.options, canDispatch: async () => ready })
    const running = dispatcher.tick()
    await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1))
    ready = false
    await running
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(1)
    expect((await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId))?.unresolvedCount).toBe(1)
    await dispatcher.stop(500)
  })
  it('discovers queued work, conflicts across instances and restores all artifacts', async () => {
    const f = await prepare('dispatcher-conflict')
    const first = new PersistentDispatcher({ ...f.options, ownerId: 'first' })
    const second = new PersistentDispatcher({ ...f.options, ownerId: 'second' })
    await Promise.all([first.tick(), second.tick()])
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('succeeded')
    expect(f.provider.calls).toHaveLength(6)
    expect(await f.store.listDispatchableRuns(Date.now(), 5)).toEqual([])
    await Promise.all([first.stop(500), second.stop(500)])
  })
  it('reclaims expired dispatch leases and fences previous owners including same-owner ABA', async () => {
    const f = await prepare('dispatcher-reclaim', () => 1000)
    const identity = { tenantId: FIXTURE_TENANT, runId: f.runId, nodeKey: 'dispatcher:run', ownerId: 'crashed' }
    const old = (await f.store.acquireLease({ ...identity, now: 800, durationMs: 100 }))!
    const dispatcher = new PersistentDispatcher({ ...f.options, ownerId: 'recovered' })
    await dispatcher.tick()
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('succeeded')
    expect(await f.store.renewLease({ ...identity, attempt: old.attempt }, 1000, 100)).toBeUndefined()
    const other = await prepare('same-owner-fencing', () => 1000)
    const request = { ...identity, runId: other.runId, now: 1000, durationMs: 100 }
    const lease = (await other.store.acquireLease(request))!
    await other.store.releaseLease({ ...request, attempt: lease.attempt })
    const next = (await other.store.acquireLease(request))!
    expect(next.attempt).toBe(lease.attempt + 1)
    expect(await other.store.releaseLease({ ...request, attempt: lease.attempt })).toBe(false)
  })
  it('renews slow work and propagates persisted cancellation to the provider', async () => {
    const f = await prepare('dispatcher-cancel')
    f.provider.override = (_request, signal) => block(signal)
    const first = new PersistentDispatcher({ ...f.options, ownerId: 'slow-owner' })
    const running = first.tick()
    await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 170))
    expect(await f.store.acquireLease({ tenantId: FIXTURE_TENANT, runId: f.runId, nodeKey: 'dispatcher:run', ownerId: 'contender', now: Date.now(), durationMs: 120 })).toBeUndefined()
    const run = await f.service.getRun(FIXTURE_TENANT, f.runId)
    await f.service.cancel(FIXTURE_TENANT, f.runId, run.revision)
    await running
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('cancelled')
    expect(await f.store.getEvidenceGraph(FIXTURE_TENANT, f.runId)).toBeUndefined()
  })
  it('aborts stalled work on execution timeout and recovers without repeating the invocation', async () => {
    const f = await prepare('dispatcher-timeout')
    f.provider.override = (_request, signal) => block(signal)
    const dispatcher = new PersistentDispatcher({ ...f.options, maxRunMs: 25 })
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(1)
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(1)
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).status).toBe('failed')
  })
  it('stops acquisition, aborts in-flight work, drains and exposes readiness', async () => {
    const f = await prepare('dispatcher-shutdown')
    f.provider.override = (_request, signal) => block(signal)
    const dispatcher = new PersistentDispatcher(f.options)
    expect(dispatcher.isReady()).toBe(false)
    await dispatcher.start()
    await dispatcher.start()
    expect(dispatcher.isReady()).toBe(true)
    await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1))
    await dispatcher.stop(500)
    expect(dispatcher.isReady()).toBe(false)
    await dispatcher.tick()
    expect(f.provider.calls).toHaveLength(1)
    await expect(dispatcher.start()).rejects.toThrow('stopped')
    await expect(dispatcher.stop(0)).rejects.toThrow('positive')
  })
  it('does not acquire expired/receiving runs and validates configuration', async () => {
    const f = await prepare('dispatcher-expired', () => 1000)
    const expired = new PersistentDispatcher({ ...f.options, now: () => 4_000_000, cleanupExpired: async () => undefined })
    await expired.tick()
    expect(f.provider.calls).toHaveLength(0)
    for (const field of ['leaseMs', 'pollMs', 'maxRunMs', 'concurrency']) {
      expect(() => new PersistentDispatcher({ ...f.options, [field]: 0 })).toThrow('positive')
    }
    await expect(f.store.listDispatchableRuns(1000, 0)).rejects.toThrow('positive')
    const failing = new PersistentDispatcher({ ...f.options, store: { ...f.store, checkHealth: async () => false } as unknown as InMemoryJobStore })
    await expect(failing.start()).rejects.toThrow('unavailable')
  })
  it('fails closed on store outage and bounds shutdown of an uncooperative worker', async () => {
    const f = await prepare('dispatcher-outage')
    const errors: unknown[] = []
    vi.spyOn(f.store, 'listDispatchableRuns').mockRejectedValueOnce(new Error('store_down'))
    const dispatcher = new PersistentDispatcher({ ...f.options, onError: (error) => errors.push(error) })
    await dispatcher.start()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    await dispatcher.stop(500)
    let resolveWorker!: () => void
    const worker = { runOnce: () => new Promise<void>((resolve) => { resolveWorker = resolve }) }
    const separate = await prepare('dispatcher-stuck')
    const stuck = new PersistentDispatcher({ ...separate.options, evidence: worker })
    const tick = stuck.tick()
    await vi.waitFor(() => expect(resolveWorker).toBeTypeOf('function'))
    await expect(stuck.stop(5)).rejects.toThrow('shutdown_timeout')
    resolveWorker()
    await tick
  })
})
