import { describe, expect, it, vi } from 'vitest'
import type { JobStore } from '../src/domain/jobStore.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest } from './fixtures/fakeAnalysisProvider.js'
import { MemoryPersonalProfileStore, personalFixtureSettings } from './fixtures/personalProviderFixture.js'

const prepare = async (store: JobStore, key: string, profileId?: string) => {
  const service = new RunService({ store, retentionSeconds: 3600, providerProfileMode: profileId ? 'personal' : 'deployment' })
  const created = await service.createRun(FIXTURE_TENANT, { ...fixtureRequest(key), providerProfileId: profileId })
  await service.uploadSource(FIXTURE_TENANT, created.run.id, { version: 1, sourceId: 'synthetic-source',
    contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
    start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
  await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
  return { service, runId: created.run.id }
}
const runtime = (store: JobStore, service: RunService, provider = new FakeAnalysisProvider(), expectedPersonalProfileId?: string) =>
  createAnalysisProviderRuntime({ store, broker: service.broker, provider, expectedPersonalProfileId,
    leaseMs: 1000, estimateCostMicros: () => 0 })

describe('provider runtime immutable run binding', () => {
  it.each(['queued', 'generating'])('stops deployment workers before reading or changing a personal %s run', async (phase) => {
    const store = new InMemoryJobStore()
    const { service, runId } = await prepare(store, `personal-cross-mode-${phase}`, 'synthetic-v1')
    if (phase === 'generating') await runtime(store, service, new FakeAnalysisProvider(), 'synthetic-v1').evidence
      .runOnce(FIXTURE_TENANT, runId, 'personal-seed', new AbortController().signal)
    const beforeRun = await store.getRun(FIXTURE_TENANT, runId)
    const beforeUsage = await store.getRunLedgerUsage(FIXTURE_TENANT, runId)
    const provider = new FakeAnalysisProvider()
    const deployment = runtime(store, service, provider)
    const graphRead = vi.spyOn(store, 'getEvidenceGraph')
    const claim = vi.spyOn(store, 'acquireLease')
    expect((await deployment.evidence.runOnce(FIXTURE_TENANT, runId, 'wrong-mode-evidence', new AbortController().signal)).outcome).toBe('stopped')
    expect((await deployment.artifacts.runOnce(FIXTURE_TENANT, runId, 'wrong-mode-artifacts', new AbortController().signal)).outcome).toBe('stopped')
    expect(graphRead).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(0)
    expect(await store.getRun(FIXTURE_TENANT, runId)).toEqual(beforeRun)
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual(beforeUsage)
  })
  it('allows the matching personal snapshot to finish all five artifacts', async () => {
    const store = new InMemoryJobStore()
    const { service, runId } = await prepare(store, 'matching-personal-profile', 'synthetic-v1')
    const provider = new FakeAnalysisProvider()
    const personal = runtime(store, service, provider, provider.profileVersion)
    expect((await personal.evidence.runOnce(FIXTURE_TENANT, runId, 'matching-evidence', new AbortController().signal)).outcome).toBe('completed')
    expect((await personal.artifacts.runOnce(FIXTURE_TENANT, runId, 'matching-artifacts', new AbortController().signal)).run.status).toBe('succeeded')
    expect(provider.calls).toHaveLength(6)
    expect((await store.getRunLedgerUsage(FIXTURE_TENANT, runId))?.invocationCount).toBe(6)
  })
  it('refuses a personal runtime bound to another profile without reserving calls', async () => {
    const store = new InMemoryJobStore()
    const { service, runId } = await prepare(store, 'wrong-personal-profile', 'synthetic-v1')
    const provider = new FakeAnalysisProvider()
    const personal = runtime(store, service, provider, 'different-profile')
    expect((await personal.evidence.runOnce(FIXTURE_TENANT, runId, 'wrong-profile', new AbortController().signal)).outcome).toBe('stopped')
    expect((await store.getRunLedgerUsage(FIXTURE_TENANT, runId))?.invocationCount).toBe(0)
    expect(provider.calls).toHaveLength(0)
  })
  it.each([{ id: 'changed-provider' }, { modelId: 'changed-model' }, { profileVersion: 'changed-profile' }])(
    'refuses a static deployment change %j after prior model work', async (change) => {
      const store = new InMemoryJobStore()
      const { service, runId } = await prepare(store, `legacy-profile-${JSON.stringify(change)}`)
      const original = new FakeAnalysisProvider()
      await runtime(store, service, original).evidence.runOnce(FIXTURE_TENANT, runId, 'original-evidence', new AbortController().signal)
      const before = await store.getRun(FIXTURE_TENANT, runId)
      const usage = await store.getRunLedgerUsage(FIXTURE_TENANT, runId)
      const changed = { ...original, ...change, isReady: () => true, generate: vi.fn(original.generate.bind(original)) }
      const next = createAnalysisProviderRuntime({ store, provider: changed, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 0 })
      expect((await next.evidence.runOnce(FIXTURE_TENANT, runId, 'changed-evidence', new AbortController().signal)).outcome).toBe('stopped')
      expect((await next.artifacts.runOnce(FIXTURE_TENANT, runId, 'changed-artifacts', new AbortController().signal)).outcome).toBe('stopped')
      expect(changed.generate).not.toHaveBeenCalled()
      expect(await store.getRun(FIXTURE_TENANT, runId)).toEqual(before)
      expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual(usage)
    },
  )
  it('keeps generic and personal discovery separate for one memory job store', async () => {
    const store = new InMemoryJobStore()
    const profiles = new MemoryPersonalProfileStore(store)
    const saved = await profiles.save(0, personalFixtureSettings())
    await profiles.setCheck(saved.revision, 'ready'); await profiles.setEnabled(saved.revision + 1, true)
    const personal = await prepare(store, 'memory-personal-discovery', saved.profileId)
    profiles.bindings.set(`${FIXTURE_TENANT}:${personal.runId}`, saved.profileId ?? '')
    const legacy = await prepare(store, 'memory-legacy-discovery')
    expect(await store.listDispatchableRuns(Date.now(), 10)).toEqual([{ tenantId: FIXTURE_TENANT, runId: legacy.runId }])
    expect(await profiles.listDispatchableRuns(Date.now(), 10)).toEqual([{ tenantId: FIXTURE_TENANT, runId: personal.runId }])
  })
})
