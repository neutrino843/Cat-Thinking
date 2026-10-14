import { analysisEventSchema, analysisRunSchema, type ProviderRouteV1 } from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { JobStore } from '../src/domain/jobStore.js'
import { PersistentDispatcher } from '../src/domain/persistentDispatcher.js'
import { RunService } from '../src/domain/runService.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { PostgresPersonalProfileStore } from '../src/infrastructure/postgres/postgresPersonalProfileStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION } from '../src/providers/evidenceMapPrompt.js'
import type { ModelProvider } from '../src/providers/modelProvider.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
if (databaseUrl) assertDedicatedPostgresTestDatabase(databaseUrl)
const raw = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined
const key = Buffer.alloc(32, 63)
const cipher = new AesGcmContentCipher(key)
const jobConfig = () => ({ mode: 'postgres' as const, connectionString: databaseUrl!, ssl: 'disable' as const,
  poolMax: 4, connectTimeoutMs: 10_000, encryptionKey: key.toString('base64') })
const openJobs = new Set<PostgresJobStore>()
const openProfiles = new Set<PostgresPersonalProfileStore>()
const dispatchers = new Set<PersistentDispatcher>()
const ownedRuns = new Set<string>()
let unlock: (() => Promise<void>) | undefined

const connectJobs = async () => {
  const store = await PostgresJobStore.connectFromConfig(jobConfig(), cipher)
  openJobs.add(store)
  return store
}
const closeJobs = async (store: PostgresJobStore) => { openJobs.delete(store); await store.close() }
const connectProfiles = async (jobs: PostgresJobStore) => {
  const profiles = await PostgresPersonalProfileStore.connect(jobConfig(), cipher, jobs)
  openProfiles.add(profiles)
  return profiles
}
const closeProfiles = async (profiles: PostgresPersonalProfileStore) => { openProfiles.delete(profiles); await profiles.close() }
const stopDispatcher = async (dispatcher: PersistentDispatcher) => { dispatchers.delete(dispatcher); await dispatcher.stop(1_000) }

beforeAll(async () => {
  if (raw) unlock = await acquireSyntheticDatabaseLock(raw)
})
afterEach(async () => {
  for (const dispatcher of [...dispatchers]) await stopDispatcher(dispatcher)
  for (const profiles of [...openProfiles]) await closeProfiles(profiles)
  for (const store of [...openJobs]) await closeJobs(store)
  if (raw && ownedRuns.size > 0) {
    await raw.query('DELETE FROM analysis_runs WHERE run_id=ANY($1::text[])', [[...ownedRuns]])
    ownedRuns.clear()
  }
})
afterAll(async () => { await unlock?.(); await raw?.end() })

const pinRoute = async (store: JobStore, runId: string, route: ProviderRouteV1, now: number) => {
  const current = (await store.getRun(FIXTURE_TENANT, runId))!
  await store.transitionRun(FIXTURE_TENANT, runId, current.revision, (run, sequence) => {
    const next = analysisRunSchema.parse({ ...run, revision: run.revision + 1, status: 'planning', stage: 'planning',
      progress: 0.05, providerRoutes: [route], updatedAt: now })
    return { run: next, event: analysisEventSchema.parse({ version: 1, type: 'stage.started', eventId: `planning-${runId}`,
      runId, runRevision: next.revision, sequence, createdAt: now, stage: 'planning' }) }
  })
}
const retainSyntheticUsage = async (store: JobStore, runId: string, route: ProviderRouteV1, now: number) => {
  const invocationId = `retained-${runId}`
  await store.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId, invocationId,
    nodeKey: 'retained:synthetic-proof', runAttempt: 1, role: 'artifact-summary', ...route,
    estimatedInputTokens: 1, reservedOutputTokens: 1, estimatedCostMicros: 1,
    maxRunEstimatedTokens: 4_000_000, maxRunEstimatedCostMicros: 50_000_000, staleAfterMs: 600_000, now })
  await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId, result: 'succeeded',
    actualInputTokens: 7, actualOutputTokens: 4, transportAttempts: 1, now })
  return invocationId
}

describe.skipIf(!databaseUrl)('PostgreSQL dispatcher compatibility and fair recovery', () => {
  it('persists mismatch deferral across connections, processes newer work, and recovers exact old runs after expiry', async () => {
    let time = 20_000
    const now = () => time
    const firstJobs = await connectJobs()
    // These are isolated synthetic fixtures in an explicitly checked test database under its shared advisory lock.
    await raw!.query('TRUNCATE analysis_runs, analysis_evidence_cache, analysis_abandoned_requests CASCADE')
    const prepareDistinctSource = async (name: string) => {
      const service = new RunService({ store: firstJobs, retentionSeconds: 3600, now })
      const sourceId = `${name}-source`
      const request = fixtureRequest(name)
      const created = await service.createRun(FIXTURE_TENANT, { ...request, docId: `${name}-document`,
        manifest: { version: 1, sources: [{ ...request.manifest.sources[0]!, sourceId }] } })
      ownedRuns.add(created.run.id)
      await service.uploadSource(FIXTURE_TENANT, created.run.id, { version: 1, sourceId,
        contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
        start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
      await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
      return { service, runId: created.run.id, sourceId }
    }
    // Distinct documents must have distinct source identities. Otherwise the
    // legitimate exact Evidence cache may save one of these two mapping calls.
    const first = await prepareDistinctSource('pg-dispatch-old-first')
    time += 1
    const second = await prepareDistinctSource('pg-dispatch-old-second')
    time += 1
    const newer = await prepareFixtureRun(firstJobs, 'pg-dispatch-newer', now); ownedRuns.add(newer.runId)
    const oldSynthetic = new FakeAnalysisProvider()
    const oldProvider: ModelProvider = { id: 'previous-synthetic-provider', modelId: 'previous-synthetic-model',
      profileVersion: 'previous-synthetic-profile', capabilities: oldSynthetic.capabilities,
      isReady: () => true, generate: oldSynthetic.generate.bind(oldSynthetic) }
    const oldRoute = { providerId: oldProvider.id, modelId: oldProvider.modelId, profileVersion: oldProvider.profileVersion,
      promptVersion: EVIDENCE_ARTIFACT_REF_PROMPT_VERSION }
    await pinRoute(firstJobs, first.runId, oldRoute, 20_000)
    await pinRoute(firstJobs, second.runId, oldRoute, 20_001)
    const retainedId = await retainSyntheticUsage(firstJobs, first.runId, oldRoute, time)
    const preserved = await Promise.all([first, second].map(async ({ runId, sourceId }) => ({
      run: await firstJobs.getRun(FIXTURE_TENANT, runId), source: await firstJobs.getSourceContent(FIXTURE_TENANT, runId, sourceId),
      ledger: await firstJobs.getRunLedgerUsage(FIXTURE_TENANT, runId),
    })))
    const retained = await firstJobs.getProviderInvocation(FIXTURE_TENANT, retainedId)
    const makeDispatcher = (store: PostgresJobStore, provider: ModelProvider, ownerId: string, concurrency = 2) => {
      const service = new RunService({ store, retentionSeconds: 3600, now })
      const runtime = createAnalysisProviderRuntime({ store, provider, broker: service.broker, leaseMs: 120, now, estimateCostMicros: () => 1 })
      const dispatcher = new PersistentDispatcher({ store, ...runtime, ownerId, cleanupExpired: async () => undefined,
        leaseMs: 120, pollMs: 10, maxRunMs: 1_000, concurrency, now })
      dispatchers.add(dispatcher)
      return dispatcher
    }
    const currentProvider = new FakeAnalysisProvider()
    const incompatible = makeDispatcher(firstJobs, currentProvider, 'mismatched-consumer')
    await incompatible.tick()
    expect(currentProvider.calls).toHaveLength(0)
    const leases = await raw!.query<{ run_id: string; expires_at: string }>(
      "SELECT run_id,expires_at FROM analysis_leases WHERE run_id=ANY($1::text[]) AND node_key='dispatcher:run'", [[first.runId, second.runId]])
    expect(leases.rows).toHaveLength(2)
    expect(leases.rows.every((row) => Number(row.expires_at) === 20_122)).toBe(true)
    await stopDispatcher(incompatible)
    await closeJobs(firstJobs)

    const secondJobs = await connectJobs()
    expect(await secondJobs.listDispatchableRuns(time, 2)).toEqual([{ tenantId: FIXTURE_TENANT, runId: newer.runId }])
    for (const [index, { runId, sourceId }] of [first, second].entries()) {
      expect(await secondJobs.getRun(FIXTURE_TENANT, runId)).toEqual(preserved[index]!.run)
      expect(await secondJobs.getSourceContent(FIXTURE_TENANT, runId, sourceId)).toEqual(preserved[index]!.source)
      expect(await secondJobs.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual(preserved[index]!.ledger)
    }
    time = 20_121
    expect(await secondJobs.listDispatchableRuns(time, 1)).toEqual([{ tenantId: FIXTURE_TENANT, runId: newer.runId }])
    time = 20_122
    // After both old leases expire, ranking must still choose untouched newer
    // work before LIMIT. Filtering active leases alone cannot satisfy this.
    expect(await secondJobs.listDispatchableRuns(time, 1)).toEqual([{ tenantId: FIXTURE_TENANT, runId: newer.runId }])
    const current = makeDispatcher(secondJobs, currentProvider, 'new-work-consumer', 1)
    await current.tick()
    expect((await secondJobs.getRun(FIXTURE_TENANT, newer.runId))!.status).toBe('succeeded')
    expect(currentProvider.calls).toHaveLength(6)
    await stopDispatcher(current)
    await closeJobs(secondJobs)

    const restoredJobs = await connectJobs()
    const restored = makeDispatcher(restoredJobs, oldProvider, 'compatible-restored-consumer')
    expect(oldSynthetic.calls).toHaveLength(0)
    await restored.tick()
    expect(oldSynthetic.calls).toHaveLength(12)
    for (const role of ['evidence-map', 'artifact-summary', 'artifact-outline', 'artifact-mindmap', 'artifact-quiz', 'artifact-knowledge']) {
      expect(oldSynthetic.calls.filter((request) => request.role === role)).toHaveLength(2)
    }
    expect((await restoredJobs.getRun(FIXTURE_TENANT, first.runId))!.status).toBe('succeeded')
    expect((await restoredJobs.getRun(FIXTURE_TENANT, second.runId))!.status).toBe('succeeded')
    for (const { runId, sourceId } of [first, second]) {
      const graph = (await restoredJobs.getEvidenceGraph(FIXTURE_TENANT, runId))!
      expect(graph.chunks.map((chunk) => chunk.sourceId)).toEqual([sourceId])
      expect(graph.claims.flatMap((claim) => claim.citations).every((citation) => citation.sourceId === sourceId)).toBe(true)
    }
    expect(await restoredJobs.getProviderInvocation(FIXTURE_TENANT, retainedId)).toEqual(retained)
    expect(await restoredJobs.getSourceContent(FIXTURE_TENANT, first.runId, first.sourceId)).toMatchObject({ text: FIXTURE_TEXT })
  })

  it('ranks expired personal dispatch leases after untouched bound work before LIMIT across store and profile reconnection', async () => {
    let time = 40_000
    let jobs = await connectJobs()
    let profiles = await connectProfiles(jobs)
    await profiles.clear((await profiles.readState()).revision)
    const saved = await profiles.save((await profiles.readState()).revision, personalFixtureSettings())
    const checked = await profiles.setCheck(saved.revision, 'ready')
    const state = await profiles.setEnabled(checked.revision, true)
    const boundStore = new Proxy(jobs, { get: (target, property) => {
      if (property === 'createRun') return profiles.createRun.bind(profiles)
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const service = new RunService({ store: boundStore, retentionSeconds: 3600, now: () => time, providerProfileMode: 'personal' })
    const createBound = async (name: string) => {
      const created = await service.createRun(FIXTURE_TENANT, { ...fixtureRequest(name, ['summary']), providerProfileId: state.profileId })
      ownedRuns.add(created.run.id)
      await service.uploadSource(FIXTURE_TENANT, created.run.id, { version: 1, sourceId: 'synthetic-source',
        contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
        start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
      await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
      time += 1
      return { tenantId: FIXTURE_TENANT, runId: created.run.id }
    }
    const deferred = await createBound('pg-personal-deferred')
    const untouched = await createBound('pg-personal-untouched')
    const newer = await createBound('pg-personal-newer')
    const generic = await prepareFixtureRun(jobs, 'pg-personal-independent-generic', () => time); ownedRuns.add(generic.runId)
    const before = { run: await jobs.getRun(FIXTURE_TENANT, deferred.runId),
      source: await jobs.getSourceContent(FIXTURE_TENANT, deferred.runId, 'synthetic-source') }
    const retainedId = await retainSyntheticUsage(jobs, deferred.runId, { providerId: 'synthetic-personal-provider',
      modelId: 'synthetic-model', profileVersion: state.profileId!, promptVersion: EVIDENCE_ARTIFACT_REF_PROMPT_VERSION }, time)
    const usage = await jobs.getRunLedgerUsage(FIXTURE_TENANT, deferred.runId)
    await jobs.acquireLease({ ...deferred, nodeKey: 'dispatcher:run', ownerId: 'older-personal-consumer', now: time, durationMs: 120 })
    await jobs.acquireLease({ ...untouched, nodeKey: 'artifact:summary', ownerId: 'artifact-owner', now: time, durationMs: 500 })
    expect(await profiles.listDispatchableRuns(time, 2)).toEqual([untouched, newer])
    time = 40_122
    expect(await profiles.listDispatchableRuns(time, 3)).toEqual([untouched, newer])
    await closeProfiles(profiles)
    await closeJobs(jobs)

    jobs = await connectJobs()
    profiles = await connectProfiles(jobs)
    time = 40_123
    expect(await profiles.readState()).toEqual(state)
    expect(await profiles.listDispatchableRuns(time, 2)).toEqual([untouched, newer])
    expect(await profiles.listDispatchableRuns(time, 3)).toEqual([untouched, newer, deferred])
    expect(await jobs.listDispatchableRuns(time, 2)).toEqual([{ tenantId: FIXTURE_TENANT, runId: generic.runId }])
    expect(await jobs.getRun(FIXTURE_TENANT, deferred.runId)).toEqual(before.run)
    expect(await jobs.getSourceContent(FIXTURE_TENANT, deferred.runId, 'synthetic-source')).toEqual(before.source)
    expect(await jobs.getRunLedgerUsage(FIXTURE_TENANT, deferred.runId)).toEqual(usage)
    expect(await jobs.getProviderInvocation(FIXTURE_TENANT, retainedId)).toMatchObject({ status: 'succeeded', transportAttempts: 1 })
    await expect(profiles.listDispatchableRuns(time, 0)).rejects.toThrow('positive')
  })
})
