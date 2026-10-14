import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  artifactEnvelopeSchema,
  canonicalizeJson,
  collectArtifactCitations,
  evidenceCardSchema,
  type AnalysisRequestV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { createArtifactDescriptor } from '../src/domain/artifactValidator.js'
import { hashChunkPlan, planEvidenceChunks } from '../src/domain/chunkPlanner.js'
import { calculateEvidenceCoverage, mergeEvidenceCards } from '../src/domain/evidenceMerger.js'
import { JobStoreConflictError, JobStoreNotFoundError } from '../src/domain/jobStore.js'
import { ServiceHttpError, createContractError } from '../src/errors.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { ANALYSIS_SCHEMA_VERSION, migrateAnalysisDatabase } from '../src/infrastructure/postgres/migrations.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { PersistentDispatcher } from '../src/domain/persistentDispatcher.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { planArtifactBudget } from '../src/domain/artifactBudget.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { BrowserSyntheticProvider } from './fixtures/browserSyntheticProvider.js'
import { ANALYSIS_SYNTHETIC } from './fixtures/browserSyntheticTexts.js'
import { createStableInvocationId } from '../src/providers/invocationId.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'
import { EvidencePipelineWorker } from '../src/domain/evidencePipelineWorker.js'
import { OpenAICompatibleProvider } from '../src/providers/openAICompatibleProvider.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { DEFAULT_PROVIDER_INVOCATION_POLICY } from '../src/providers/providerInvocationCoordinator.js'
import { ARTIFACT_SOURCE_REFERENCE_VERSIONS, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION } from '../src/domain/artifactPolicyVersions.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION } from '../src/providers/evidenceMapPrompt.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
if (databaseUrl) assertDedicatedPostgresTestDatabase(databaseUrl)
const integration = describe.skipIf(!databaseUrl)
const key = Buffer.alloc(32, 11)
const plaintext = 'PostgreSQL 持久加密正文 🌱 '.repeat(8)
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const makeRequest = (requestKey = hash('postgres-integration-request')): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey,
  docId: 'doc-postgres',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-postgres',
      kind: 'text',
      extractor: 'integration@1',
      contentHash: hash(plaintext),
      charCount: plaintext.length,
      byteCount: new TextEncoder().encode(plaintext).byteLength,
    }],
  },
  artifacts: ['summary'],
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount: 1,
    externalKnowledge: false,
  },
})

const sourcePart = (): UploadSourcePartV1 => ({
  version: 1,
  sourceId: 'source-postgres',
  contentHash: hash(plaintext),
  partHash: hash(plaintext),
  partIndex: 0,
  partCount: 1,
  start: 0,
  end: plaintext.length,
  totalChars: plaintext.length,
  text: plaintext,
})

const summaryArtifactFor = (runId: string) => artifactEnvelopeSchema.parse({
  version: 1,
  schemaVersion: 1,
  id: 'artifact-postgres-summary',
  runId,
  docId: 'doc-postgres',
  kind: 'summary',
  sourceContentHashes: [hash(plaintext)],
  payload: {
    overview: {
      id: 'summary-overview',
      text: 'Encrypted artifact marker',
      evidenceIds: ['claim-postgres'],
      citations: [{
        version: 1,
        provenance: 'source',
        sourceId: 'source-postgres',
        start: 0,
        end: 10,
      }],
    },
    keyPoints: [{
      id: 'summary-key-point',
      text: 'Persisted key point',
      evidenceIds: ['claim-postgres'],
      citations: [{
        version: 1,
        provenance: 'source',
        sourceId: 'source-postgres',
        start: 0,
        end: 10,
      }],
    }],
    confusions: [],
  },
  createdAt: 20_100,
  updatedAt: 20_100,
})

const openStores = new Set<PostgresJobStore>()
const connectStore = async (): Promise<PostgresJobStore> => {
  const store = await PostgresJobStore.connectFromConfig({
    mode: 'postgres',
    connectionString: databaseUrl!,
    ssl: 'disable',
    poolMax: 4,
    connectTimeoutMs: 10_000,
    encryptionKey: key.toString('base64'),
  }, new AesGcmContentCipher(key))
  openStores.add(store)
  return store
}
const closeStore = async (store: PostgresJobStore): Promise<void> => {
  openStores.delete(store)
  await store.close()
}

const rawPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined
let releaseDatabaseLock: (() => Promise<void>) | undefined
beforeAll(async () => { if (rawPool) releaseDatabaseLock = await acquireSyntheticDatabaseLock(rawPool) })

beforeEach(async () => {
  if (!rawPool) return
  const store = await connectStore()
  await closeStore(store)
  await rawPool.query('TRUNCATE analysis_runs, analysis_evidence_cache, analysis_abandoned_requests CASCADE')
})

afterEach(async () => {
  await Promise.all([...openStores].map((store) => closeStore(store)))
})

afterAll(async () => {
  await releaseDatabaseLock?.()
  await rawPool?.end()
})

integration('PostgreSQL durable job store', () => {
  it('serializes create/abandon races and retains tenant-isolated tombstones across reopening', async () => {
    const first = await connectStore()
    const second = await connectStore()
    const service = new RunService({ store: first, retentionSeconds: 3600 })
    const rival = new RunService({ store: second, retentionSeconds: 3600 })
    for (const order of ['create-first', 'abandon-first', 'concurrent']) {
      const request = makeRequest(hash(`request-barrier-${order}`))
      if (order === 'create-first') await service.createRun('tenant-barrier', request)
      if (order === 'abandon-first') await rival.abandonRequest('tenant-barrier', request.requestKey)
      await Promise.allSettled([service.createRun('tenant-barrier', request), rival.abandonRequest('tenant-barrier', request.requestKey)])
      expect(await service.lookupRequest('tenant-barrier', request.requestKey)).toMatchObject({ status: 'abandoned' })
      expect(await service.lookupRequest('unrelated-tenant', request.requestKey)).toMatchObject({ status: 'absent' })
      await expect(service.createRun('tenant-barrier', request)).rejects.toMatchObject({ statusCode: 409 })
    }
    await closeStore(first)
    const reopened = await connectStore()
    expect(await new RunService({ store: reopened, retentionSeconds: 3600 }).lookupRequest('tenant-barrier', hash('request-barrier-abandon-first'))).toMatchObject({ status: 'abandoned' })
    expect(await reopened.listDispatchableRuns(Date.now(), 10)).toEqual([])
  })

  it('checks retry liveness, unresolved ledger, admission and two-instance CAS under the run lock', async () => {
    const first = await connectStore()
    const second = await connectStore()
    const time = Date.now()
    for (const reason of ['unknown', 'deleted', 'expired', 'held', 'nonretryable', 'cas']) {
      const prepared = await prepareFixtureRun(first, `retry-guards-${reason}`, () => time, ['summary'])
      const runtime = createAnalysisProviderRuntime({ store: first, provider: new FakeAnalysisProvider(), broker: prepared.service.broker, leaseMs: 1000, now: () => time, estimateCostMicros: () => 1 })
      await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'retry-fixture', new AbortController().signal)
      const baselineInvocations = (await prepared.service.getUsage(FIXTURE_TENANT, prepared.runId)).invocationCount
      if (reason === 'unknown') {
        await first.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId: prepared.runId, invocationId: 'pg-lost-response', nodeKey: 'artifact:summary', runAttempt: 1,
          role: 'artifact-summary', providerId: 'synthetic-provider', modelId: 'synthetic-model', profileVersion: 'synthetic-v1', promptVersion: 'summary-v1',
          estimatedInputTokens: 5, reservedOutputTokens: 10, estimatedCostMicros: 2, maxRunEstimatedTokens: 100000, maxRunEstimatedCostMicros: 100000, staleAfterMs: 1000, now: time })
        await first.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'pg-lost-response', result: 'outcome_unknown', failureKind: 'outcome_unknown', safeCode: 'response_lost', transportAttempts: 1, now: time + 1 })
      }
      const current = await prepared.service.getRun(FIXTURE_TENANT, prepared.runId)
      const error = createContractError('internal_error', 'internal', reason !== 'nonretryable', 'analysis.artifact.synthetic_failed')
      const failed = await first.transitionRun(FIXTURE_TENANT, current.id, current.revision, (run, sequence) => {
        const next = analysisRunSchema.parse({ ...run, revision: run.revision + 1, status: 'failed', stage: undefined, completedAt: time,
          artifactStates: { summary: { status: 'failed', attempt: 1, error, updatedAt: time } } })
        return { run: next, event: analysisEventSchema.parse({ version: 1, type: 'artifact.failed', runId: run.id, eventId: `failed-${reason}`, runRevision: next.revision, sequence, createdAt: time, kind: 'summary', error }) }
      })
      if (failed.outcome !== 'updated') throw new Error('fixture checkpoint failed')
      if (reason === 'deleted') await prepared.service.deleteContent(FIXTURE_TENANT, current.id)
      if (reason === 'held') prepared.service.setAdmissionGuard(async () => false)
      if (reason === 'cas') {
        const rival = new RunService({ store: second, retentionSeconds: 3600, now: () => time })
        const results = await Promise.allSettled([prepared.service.retryArtifact(FIXTURE_TENANT, current.id, 'summary', failed.run.revision), rival.retryArtifact(FIXTURE_TENANT, current.id, 'summary', failed.run.revision)])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect((await prepared.service.getRun(FIXTURE_TENANT, current.id)).artifactStates.summary?.attempt).toBe(2)
      } else {
        const service = reason === 'expired' ? new RunService({ store: second, retentionSeconds: 3600, now: () => failed.run.expiresAt! }) : prepared.service
        await expect(service.retryArtifact(FIXTURE_TENANT, current.id, 'summary', failed.run.revision)).rejects.toMatchObject({ statusCode: reason === 'held' ? 503 : ['deleted', 'expired'].includes(reason) ? 410 : 409 })
        expect((await prepared.service.getRun(FIXTURE_TENANT, current.id)).revision).toBe(failed.run.revision)
      }
      expect((await prepared.service.getUsage(FIXTURE_TENANT, current.id)).invocationCount).toBe(baselineInvocations + (reason === 'unknown' ? 1 : 0))
      if (reason === 'unknown') {
        await prepared.service.abandonRequest(FIXTURE_TENANT, failed.run.requestKey)
        await first.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'pg-lost-response', result: 'succeeded', transportAttempts: 1, actualInputTokens: 7, actualOutputTokens: 4, now: time + 2 })
        expect(await prepared.service.getUsage(FIXTURE_TENANT, current.id)).toMatchObject({ completeness: 'complete', unresolvedCount: 0, usage: { inputTokens: 27, outputTokens: 14 } })
        expect(await first.getEvidenceGraph(FIXTURE_TENANT, current.id)).toBeUndefined()
      }
    }
  })

  it('recovers Outline then separately retries MindMap without automatically invoking the dependent node', async () => {
    const store = await connectStore()
    const time = Date.now()
    const prepared = await prepareFixtureRun(store, 'pg-explicit-dependency-retry', () => time, ['outline', 'mindmap'])
    const provider = new FakeAnalysisProvider()
    let refuseOutline = true
    provider.override = (request) => {
      if (request.role === 'artifact-outline' && refuseOutline) throw new ProviderGatewayError({ providerId: provider.id,
        kind: 'rate_limited', retryable: true, acceptance: 'not_accepted', safeCode: 'synthetic_rate_limit' })
      return provider.output(request)
    }
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 1000, now: () => time, estimateCostMicros: () => 1, policy: { ...DEFAULT_PROVIDER_INVOCATION_POLICY, maxAttempts: 1 } })
    await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'dependency-worker', new AbortController().signal)
    const initial = await runtime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'dependency-worker', new AbortController().signal)
    expect(initial.run.artifactStates.mindmap).toMatchObject({ status: 'failed', attempt: 1, error: { code: 'dependency_failed', retryable: false } })
    refuseOutline = false
    await prepared.service.retryArtifact(FIXTURE_TENANT, prepared.runId, 'outline', initial.run.revision)
    const recovered = await runtime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'dependency-worker', new AbortController().signal)
    expect(recovered.run.artifactStates.mindmap).toMatchObject({ status: 'failed', attempt: 1, error: { retryable: true } })
    expect(provider.calls.filter((request) => request.role === 'artifact-mindmap')).toHaveLength(0)
    const competitor = await connectStore()
    const other = new RunService({ store: competitor, retentionSeconds: 3600, now: () => time })
    const retries = await Promise.allSettled([prepared.service.retryArtifact(FIXTURE_TENANT, prepared.runId, 'mindmap', recovered.run.revision), other.retryArtifact(FIXTURE_TENANT, prepared.runId, 'mindmap', recovered.run.revision)])
    expect(retries.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await runtime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'dependency-worker', new AbortController().signal)).run.status).toBe('succeeded')
    expect(provider.calls.filter((request) => request.role === 'artifact-mindmap')).toHaveLength(1)
    expect(await prepared.service.getUsage(FIXTURE_TENANT, prepared.runId)).toMatchObject({ invocationCount: 4, completeness: 'complete' })
  })

  it('handles a terminated dedicated idle connection and recovers without an unhandled pool error', async () => {
    const applicationName = 'cat-analysis-isolated-idle-fault'
    const store = await PostgresJobStore.connect({ connectionString: databaseUrl!, ssl: 'disable', poolMax: 2, connectTimeoutMs: 10000, cipher: new AesGcmContentCipher(key), applicationName })
    openStores.add(store)
    expect(await store.checkHealth()).toBe(true)
    const killed = await rawPool!.query<{ terminated: boolean }>(`SELECT pg_terminate_backend(pid) terminated FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 AND usename=current_user AND pid<>pg_backend_pid()`, [applicationName])
    expect(killed.rows.length).toBeGreaterThan(0)
    expect(killed.rows.every((row) => row.terminated)).toBe(true)
    await expect.poll(() => store.checkHealth(), { timeout: 5000 }).toBe(true)
    expect(await store.listDispatchableRuns(Date.now(), 10)).toEqual([])
    expect(await rawPool!.query('SELECT 1')).toMatchObject({ rowCount: 1 })
  })
  it('does not allow two destructive synthetic database runners to share a database', async () => {
    const contender = new Pool({ connectionString: databaseUrl, max: 1 })
    try { await expect(acquireSyntheticDatabaseLock(contender)).rejects.toThrow('in use') }
    finally { await contender.end() }
  })
  it('validates repeated long input through both adapters and recovers artifacts without replay after reopening PostgreSQL', async () => {
    const store = await connectStore()
    const service = new RunService({ store, retentionSeconds: 3600 })
    const text = ANALYSIS_SYNTHETIC.upload
    const request = analysisRequestSchema.parse({ ...makeRequest(hash('long-adapter-recovery')), artifacts: ['summary', 'outline'],
      manifest: { version: 1, sources: [{ version: 1, sourceId: 'source-postgres', kind: 'text', extractor: 'synthetic-long-v1', contentHash: hash(text), charCount: text.length, byteCount: Buffer.byteLength(text) }] } })
    const created = await service.createRun('tenant-long', request)
    await service.uploadSource('tenant-long', created.run.id, { version: 1, sourceId: 'source-postgres', contentHash: hash(text), partHash: hash(text), partIndex: 0, partCount: 1, start: 0, end: text.length, totalChars: text.length, text })
    await service.startRun('tenant-long', created.run.id, 1)
    const runtime = createAnalysisProviderRuntime({ store, provider: new BrowserSyntheticProvider(), broker: service.broker, leaseMs: 10000, estimateCostMicros: () => 1 })
    const dispatcher = new PersistentDispatcher({ store, ...runtime, leaseMs: 10000, pollMs: 100, maxRunMs: 60000, cleanupExpired: async () => {} })
    await dispatcher.tick()
    await dispatcher.stop(10000)
    const run = await service.getRun('tenant-long', created.run.id)
    expect(run.status).toBe('succeeded')
    const before = await store.getRunLedgerUsage('tenant-long', created.run.id)
    await closeStore(store)
    const reopened = await connectStore()
    expect((await new RunService({ store: reopened, retentionSeconds: 3600 }).getArtifact('tenant-long', created.run.id, 'summary')).kind).toBe('summary')
    expect(await reopened.getRunLedgerUsage('tenant-long', created.run.id)).toEqual(before)
  }, 30000)
  it.each(['legacy', 'source-reference'] as const)('recovers a stale unknown %s paid invocation without redelivery and preserves reserved usage', async (protocol) => {
    const time = Date.now()
    const first = await connectStore()
    const { service, runId } = await prepareFixtureRun(first, `postgres-unknown-output-${protocol}`, () => time, ['summary'])
    const provider = new FakeAnalysisProvider()
    const initial = createAnalysisProviderRuntime({ store: first, provider, broker: service.broker, leaseMs: 1000, now: () => time, estimateCostMicros: () => 3, artifactProtocol: protocol })
    await initial.evidence.runOnce(FIXTURE_TENANT, runId, 'initial', new AbortController().signal)
    const nodeKey = 'artifact:summary'
    const invocationId = createStableInvocationId({ runId, nodeKey, runAttempt: 1, role: 'artifact-summary' })
    await first.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId, invocationId, nodeKey, runAttempt: 1, role: 'artifact-summary',
      providerId: provider.id, modelId: provider.modelId, profileVersion: provider.profileVersion,
      promptVersion: protocol === 'legacy' ? 'artifact-v1' : ARTIFACT_SOURCE_REFERENCE_VERSIONS.summary,
      estimatedInputTokens: 1, reservedOutputTokens: 1, estimatedCostMicros: 2, maxRunEstimatedTokens: 100000,
      maxRunEstimatedCostMicros: 1000, staleAfterMs: 600000, now: time })
    await closeStore(first)
    const reopened = await connectStore()
    const recovered = new RunService({ store: reopened, retentionSeconds: 3600 })
    const runtime = createAnalysisProviderRuntime({ store: reopened, provider, broker: recovered.broker, leaseMs: 1000, now: () => time + 600001, estimateCostMicros: () => 3 })
    const dispatcher = new PersistentDispatcher({ store: reopened, ...runtime, leaseMs: 1000, pollMs: 20, maxRunMs: 10000,
      now: () => time + 600001, cleanupExpired: async () => undefined })
    await dispatcher.tick()
    expect(provider.calls).toHaveLength(1)
    expect((await reopened.getProviderInvocation(FIXTURE_TENANT, invocationId))?.status).toBe('outcome_unknown')
    expect(await reopened.getRunLedgerUsage(FIXTURE_TENANT, runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 1,
      usage: { inputTokens: 20, outputTokens: 10, estimatedCostMicros: 5 } })
    expect((await recovered.getRun(FIXTURE_TENANT, runId)).status).toBe('failed')
    await dispatcher.stop(1000)
  })
  it('restores provider Evidence and dispatch leases across connections, with five fake artifacts and consistent usage', async () => {
    const first = await connectStore()
    const { service, runId } = await prepareFixtureRun(first, 'postgres-provider-recovery')
    const provider = new FakeAnalysisProvider()
    const runtime = createAnalysisProviderRuntime({ store: first, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    await runtime.evidence.runOnce(FIXTURE_TENANT, runId, 'old-evidence', new AbortController().signal)
    const old = (await first.acquireLease({ tenantId: FIXTURE_TENANT, runId, nodeKey: 'dispatcher:run', ownerId: 'crashed-process', now: Date.now() - 2000, durationMs: 500 }))!
    await closeStore(first)
    const leftStore = await connectStore()
    const rightStore = await connectStore()
    const leftService = new RunService({ store: leftStore, retentionSeconds: 3600 })
    const dispatcherFor = (store: PostgresJobStore, ownerId: string) => {
      const current = createAnalysisProviderRuntime({ store, provider, broker: leftService.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
      return new PersistentDispatcher({ store, ...current, ownerId, leaseMs: 1000, pollMs: 20, maxRunMs: 5000, cleanupExpired: async () => undefined })
    }
    const left = dispatcherFor(leftStore, 'left-instance')
    const right = dispatcherFor(rightStore, 'right-instance')
    await Promise.all([left.tick(), right.tick()])
    expect((await leftService.getRun(FIXTURE_TENANT, runId)).status).toBe('succeeded')
    expect(provider.calls).toHaveLength(6)
    expect(await rightStore.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual({ invocationCount: 6, unresolvedCount: 0,
      estimatedInputTokens: expect.any(Number), reservedOutputTokens: expect.any(Number),
      usage: { inputTokens: 120, outputTokens: 60, estimatedCostMicros: 18, currency: 'USD' } })
    expect(await rightStore.getRunLedgerUsage('other-tenant', runId)).toBeUndefined()
    expect(await rightStore.renewLease({ tenantId: FIXTURE_TENANT, ...old }, Date.now(), 1000)).toBeUndefined()
    await Promise.all([left.stop(1000), right.stop(1000)])
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM analysis_artifacts WHERE run_id=$1', [runId])
    expect(encrypted.rows).toHaveLength(5)
    expect(encrypted.rows.some((row) => row.ciphertext.includes(Buffer.from('Photosynthesis')))).toBe(false)
    await closeStore(leftStore)
    await closeStore(rightStore)
    const reopened = await connectStore()
    expect((await reopened.listArtifactDescriptors(FIXTURE_TENANT, runId))?.length).toBe(5)
    expect((await reopened.getRunLedgerUsage(FIXTURE_TENANT, runId))?.usage.inputTokens).toBe(120)
  })

  it.each(['legacy', 'source-reference'] as const)('restores %s Artifact protocol from an Evidence checkpoint across new connections without upgrading or duplicating calls', async (protocol) => {
    const first = await connectStore()
    const prepared = await prepareFixtureRun(first, `postgres-artifact-protocol-${protocol}`)
    const provider = new FakeAnalysisProvider()
    const original = createAnalysisProviderRuntime({ store: first, provider, broker: prepared.service.broker, leaseMs: 1000,
      estimateCostMicros: () => 3, artifactProtocol: protocol })
    await original.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'checkpoint-writer', new AbortController().signal)
    const graph = await first.getEvidenceGraph(FIXTURE_TENANT, prepared.runId)
    expect(graph?.promptVersion).toBe(protocol === 'legacy' ? EVIDENCE_SOURCE_REF_PROMPT_VERSION : EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)
    expect(provider.calls).toHaveLength(1)
    expect(await first.listArtifactDescriptors(FIXTURE_TENANT, prepared.runId)).toEqual([])
    await closeStore(first)
    const reopened = await connectStore()
    const service = new RunService({ store: reopened, retentionSeconds: 3600 })
    // Configuration now defaults to references; the saved checkpoint still selects the exact family.
    const recovered = createAnalysisProviderRuntime({ store: reopened, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    expect((await recovered.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'checkpoint-reader', new AbortController().signal)).run.status).toBe('succeeded')
    const artifactRequests = provider.calls.filter((request) => request.role.startsWith('artifact-'))
    expect(artifactRequests).toHaveLength(5)
    expect(artifactRequests.every((request) => request.output.name.includes('_source_refs_'))).toBe(protocol === 'source-reference')
    const descriptors = await reopened.listArtifactDescriptors(FIXTURE_TENANT, prepared.runId)
    expect(descriptors).toHaveLength(5)
    for (const descriptor of descriptors ?? []) {
      const saved = await reopened.getArtifact(FIXTURE_TENANT, prepared.runId, descriptor.kind)
      expect(saved?.artifact.version).toBe(1)
      const citations = collectArtifactCitations(saved!.artifact)
      expect(citations.length).toBeGreaterThan(0)
      expect(citations.every((citation) => citation.provenance === 'source' && citation.quote !== undefined
        && citation.quote === FIXTURE_TEXT.slice(citation.start, citation.end))).toBe(true)
    }
    if (protocol === 'source-reference') {
      const finalRun = await service.getRun(FIXTURE_TENANT, prepared.runId)
      expect(Object.values(ARTIFACT_SOURCE_REFERENCE_VERSIONS).every((version) => finalRun.providerRoutes.some((route) => route.promptVersion === version))).toBe(true)
    }
    const usage = await reopened.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)
    expect(usage).toMatchObject({ invocationCount: 6, unresolvedCount: 0, usage: { inputTokens: 120, outputTokens: 60, estimatedCostMicros: 18 } })
    await closeStore(reopened)
    const twice = await connectStore()
    const twiceRuntime = createAnalysisProviderRuntime({ store: twice, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    expect((await twiceRuntime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'read-again', new AbortController().signal)).outcome).toBe('already_complete')
    expect(await twice.listArtifactDescriptors(FIXTURE_TENANT, prepared.runId)).toEqual(descriptors)
    expect(await twice.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)).toEqual(usage)
    expect(provider.calls).toHaveLength(6)
  })

  it('persists a separate source-reference Artifact repair and exact usage across reconnecting', async () => {
    const first = await connectStore()
    const prepared = await prepareFixtureRun(first, 'postgres-source-ref-independent-repair')
    const provider = new FakeAnalysisProvider()
    provider.override = (request) => {
      const output = JSON.parse(provider.output(request)) as { payload: { overview?: { citations: unknown[] } } }
      if (request.role === 'artifact-summary') output.payload.overview!.citations = [{ refId: 'cite-not-in-the-catalog' }]
      return JSON.stringify(output)
    }
    const runtime = createAnalysisProviderRuntime({ store: first, provider, broker: prepared.service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'repair-evidence', new AbortController().signal)
    expect((await runtime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'repair-artifacts', new AbortController().signal)).run.status).toBe('succeeded')
    const repairs = provider.calls.filter((request) => request.role === 'repair')
    expect(repairs).toHaveLength(1)
    const invoice = await first.getProviderInvocation(FIXTURE_TENANT, repairs[0].invocationId)
    expect(invoice).toMatchObject({ status: 'succeeded', nodeKey: 'artifact:summary:repair', promptVersion: ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION })
    expect(invoice?.invocationId).not.toBe(provider.calls.find((request) => request.role === 'artifact-summary')?.invocationId)
    expect((await first.getArtifact(FIXTURE_TENANT, prepared.runId, 'summary'))?.artifact.id).toBe(`artifact-${invoice?.invocationId}`)
    const before = await first.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)
    expect(before).toMatchObject({ invocationCount: 7, unresolvedCount: 0, usage: { inputTokens: 140, outputTokens: 70, estimatedCostMicros: 21 } })
    await closeStore(first)
    const reopened = await connectStore()
    expect(await reopened.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)).toEqual(before)
    const after = createAnalysisProviderRuntime({ store: reopened, provider, broker: prepared.service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    expect((await after.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'repair-recovery', new AbortController().signal)).outcome).toBe('already_complete')
    expect(provider.calls).toHaveLength(7)
    expect((await reopened.listArtifactDescriptors(FIXTURE_TENANT, prepared.runId))?.length).toBe(5)
  })

  it('accounts generation before commit across restart and refuses duplicate paid output replay', async () => {
    const first = await connectStore()
    const { service, runId } = await prepareFixtureRun(first, 'postgres-crash-before-commit', Date.now, ['summary'])
    const provider = new FakeAnalysisProvider()
    const runtime = createAnalysisProviderRuntime({ store: first, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    await runtime.evidence.runOnce(FIXTURE_TENANT, runId, 'evidence', new AbortController().signal)
    const run = (await first.getRun(FIXTURE_TENANT, runId))!
    const graph = (await first.getEvidenceGraph(FIXTURE_TENANT, runId))!
    await runtime.artifactGenerator.generate({ tenantId: FIXTURE_TENANT, run, attempt: 1, runId, docId: run.docId, kind: 'summary',
      options: run.request.options, budget: planArtifactBudget('summary', run.request.options), graph }, new AbortController().signal)
    expect(await first.getArtifact(FIXTURE_TENANT, runId, 'summary')).toBeUndefined()
    await closeStore(first)
    const reopened = await connectStore()
    const recovered = new RunService({ store: reopened, retentionSeconds: 3600 })
    expect((await recovered.getRun(FIXTURE_TENANT, runId)).usage.inputTokens).toBe(40)
    const resumed = createAnalysisProviderRuntime({ store: reopened, provider, broker: recovered.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    const dispatcher = new PersistentDispatcher({ store: reopened, ...resumed, leaseMs: 1000, pollMs: 20, maxRunMs: 5000, cleanupExpired: async () => undefined })
    await dispatcher.tick()
    expect((await recovered.getRun(FIXTURE_TENANT, runId)).status).toBe('failed')
    expect(provider.calls).toHaveLength(2)
    expect((await recovered.getRun(FIXTURE_TENANT, runId)).usage.inputTokens).toBe(40)
    await dispatcher.stop(1000)
  })

  it('serializes first lease acquisition without an existing row and preserves fencing after release', async () => {
    const left = await connectStore()
    const right = await connectStore()
    const { runId } = await prepareFixtureRun(left, 'postgres-first-lease-race')
    const request = { tenantId: FIXTURE_TENANT, runId, nodeKey: 'dispatcher:run', now: Date.now(), durationMs: 1000 }
    const leases = await Promise.all([left.acquireLease({ ...request, ownerId: 'left' }), right.acquireLease({ ...request, ownerId: 'right' })])
    expect(leases.filter(Boolean)).toHaveLength(1)
    const winner = leases.find(Boolean)!
    expect(await left.releaseLease({ tenantId: FIXTURE_TENANT, ...winner })).toBe(true)
    const next = (await right.acquireLease({ ...request, ownerId: winner.ownerId }))!
    expect(next.attempt).toBe(winner.attempt + 1)
    expect(await left.releaseLease({ tenantId: FIXTURE_TENANT, ...winner })).toBe(false)
    expect(await left.listDispatchableRuns(request.now, 10)).toEqual([])
    expect((await right.listDispatchableRuns(request.now + 1001, 10)).map((ref) => ref.runId)).toContain(runId)
    await expect(left.listDispatchableRuns(request.now, 0)).rejects.toThrow('positive')
  })
  it('survives a store restart and never stores plaintext source content', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 10_000,
      createId: (() => { let id = 0; return () => `postgres-id-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest())
    await service.uploadSource('tenant-postgres', created.run.id, sourcePart())
    await expect(service.uploadSource('tenant-postgres', created.run.id, sourcePart())).resolves.toMatchObject({
      complete: true,
      receivedParts: 1,
    })
    await service.startRun('tenant-postgres', created.run.id, 1)
    await closeStore(store)

    const reopened = await connectStore()
    expect(await reopened.checkHealth()).toBe(true)
    const recovered = new RunService({ store: reopened, retentionSeconds: 3_600 })
    expect(await recovered.getRun('tenant-postgres', created.run.id)).toMatchObject({ status: 'queued', revision: 2 })
    const events = await recovered.listEvents('tenant-postgres', created.run.id)
    expect(events.map((event) => event.type)).toEqual([
      'run.accepted',
      'stage.started',
    ])
    expect((await recovered.listEvents('tenant-postgres', created.run.id, events[0]?.eventId))
      .map((event) => event.type)).toEqual(['stage.started'])
    expect(await reopened.getSourceReceipt('tenant-postgres', created.run.id, 'source-postgres')).toMatchObject({
      complete: true,
      computedHash: hash(plaintext),
    })
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_source_parts WHERE run_id=$1',
      [created.run.id],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from(plaintext, 'utf8'))).toBe(false)
    await closeStore(reopened)
    expect(await reopened.checkHealth()).toBe(false)
  })

  it('serializes concurrent idempotent create and revision transitions', async () => {
    const firstStore = await connectStore()
    const secondStore = await connectStore()
    const first = new RunService({ store: firstStore, retentionSeconds: 3_600 })
    const second = new RunService({ store: secondStore, retentionSeconds: 3_600 })
    const [left, right] = await Promise.all([
      first.createRun('tenant-postgres', makeRequest()),
      second.createRun('tenant-postgres', makeRequest()),
    ])
    expect(left.run.id).toBe(right.run.id)
    expect([left.reused, right.reused].sort()).toEqual([false, true])
    await first.uploadSource('tenant-postgres', left.run.id, sourcePart())

    const transitions = await Promise.allSettled([
      first.startRun('tenant-postgres', left.run.id, 1),
      second.startRun('tenant-postgres', left.run.id, 1),
    ])
    expect(transitions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = transitions.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.any(ServiceHttpError) })
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      contractError: { code: 'conflict' },
    })
    await closeStore(firstStore)
    await closeStore(secondStore)
  })

  it('persists lease attempts and performs transactional TTL expiration', async () => {
    let now = 1_000
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 1,
      now: () => now,
      createId: (() => { let id = 0; return () => `ttl-id-${++id}` })(),
    })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    await service.uploadSource('tenant-postgres', run.id, sourcePart())
    const terminal = (await service.createRun('tenant-postgres', makeRequest('7'.repeat(64)))).run
    await service.uploadSource('tenant-postgres', terminal.id, sourcePart())
    await service.cancel('tenant-postgres', terminal.id, 1)
    const first = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now, durationMs: 100,
    })
    const takeover = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 1_100, durationMs: 100,
    })
    expect(first?.attempt).toBe(1)
    expect(takeover).toMatchObject({ attempt: 2, ownerId: 'worker-2' })

    now = 2_000
    expect(await service.cleanupExpired(10)).toEqual({ examined: 2, cleaned: 2, expired: 1 })
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ status: 'expired', revision: 2 })
    expect(await service.getRun('tenant-postgres', terminal.id)).toMatchObject({ status: 'cancelled', revision: 2 })
    expect(await rawPool!.query('SELECT 1 FROM analysis_source_parts WHERE run_id=$1', [run.id]))
      .toMatchObject({ rowCount: 0 })
    expect(await store.cleanupExpiredRun('tenant-postgres', run.id, now, () => undefined))
      .toEqual({ outcome: 'already_clean' })
    await closeStore(store)
  })

  it('enforces tenant, cursor, source mutation, deletion, and lease CAS boundaries', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 5_000,
      createId: (() => { let id = 0; return () => `boundary-id-${++id}` })(),
    })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    expect(await store.getRun('tenant-other', run.id)).toBeUndefined()
    expect(await store.listEvents('tenant-other', run.id)).toBeUndefined()
    expect(await store.deleteContent('tenant-other', run.id)).toBeUndefined()
    expect(await store.getSourceReceipt('tenant-postgres', run.id, 'missing-source')).toBeUndefined()
    await expect(store.listEvents('tenant-postgres', run.id, 'missing-event'))
      .rejects.toBeInstanceOf(JobStoreNotFoundError)

    await service.uploadSource('tenant-postgres', run.id, sourcePart())
    const changedText = `X${plaintext.slice(1)}`
    const changed = { ...sourcePart(), text: changedText, partHash: hash(changedText) }
    await expect(service.uploadSource('tenant-postgres', run.id, changed))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(store.markSourceComplete('tenant-postgres', run.id, 'source-postgres', 'f'.repeat(64)))
      .rejects.toBeInstanceOf(JobStoreConflictError)
    expect(await store.markSourceComplete('tenant-postgres', run.id, 'missing-source', 'f'.repeat(64)))
      .toBeUndefined()

    const sameOwner = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 10, durationMs: 100,
    })
    expect((await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 20, durationMs: 100,
    }))?.attempt).toBe(sameOwner?.attempt)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 25, durationMs: 100,
    })).toBeUndefined()
    const renewed = await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 30, 100)
    expect(renewed?.expiresAt).toBe(130)
    expect(await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 2,
    }, 40, 100)).toBeUndefined()
    await expect(store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 40, 0)).rejects.toThrow(/positive/)
    expect(await store.releaseLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', attempt: 1,
    })).toBe(false)
    expect(await store.releaseLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    })).toBe(true)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: 'missing-run', nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 1,
    })).toBeUndefined()
    await expect(store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 0,
    })).rejects.toThrow(/positive/)

    await service.cancel('tenant-postgres', run.id, 1)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'late-worker', now: 200, durationMs: 100,
    })).toBeUndefined()

    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: true })
    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: false })
    await expect(service.uploadSource('tenant-postgres', run.id, sourcePart()))
      .rejects.toMatchObject({ statusCode: 409 })
    await closeStore(store)
  })

  it('rolls back an invalid transition and reports direct cleanup edge cases', async () => {
    const store = await connectStore()
    const service = new RunService({ store, retentionSeconds: 1, now: () => 1_000 })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    await service.uploadSource('tenant-postgres', run.id, sourcePart())
    await expect(store.transitionRun('tenant-postgres', run.id, 1, (current, sequence) => ({
      run: { ...current, revision: 4 },
      event: {
        version: 1,
        type: 'run.expired',
        eventId: 'invalid-transition-event',
        runId: current.id,
        runRevision: 4,
        sequence,
        createdAt: 1,
        reason: 'retention_elapsed',
      },
    }))).rejects.toThrow(/transition/)
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ revision: 1, status: 'receiving' })
    expect(await store.transitionRun('tenant-postgres', 'missing-run', 1, () => {
      throw new Error('must not build')
    })).toEqual({ outcome: 'missing' })
    expect(await store.transitionRun('tenant-postgres', run.id, 2, () => {
      throw new Error('must not build')
    })).toMatchObject({ outcome: 'revision_conflict' })
    expect(await store.cleanupExpiredRun('tenant-postgres', run.id, 1, () => undefined))
      .toEqual({ outcome: 'not_due' })
    expect(await store.cleanupExpiredRun('tenant-postgres', 'missing-run', 1, () => undefined))
      .toEqual({ outcome: 'missing' })
    const cleanupNow = 2_000
    await expect(store.cleanupExpiredRun('tenant-postgres', run.id, cleanupNow, (current, sequence) => {
      const next = analysisRunSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: 'expired',
        stage: undefined,
        artifactStates: {
          ...current.artifactStates,
          summary: { ...current.artifactStates.summary, status: 'cancelled', updatedAt: cleanupNow },
        },
        updatedAt: cleanupNow,
        completedAt: cleanupNow,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'run.expired',
          eventId: 'invalid-cleanup-transition',
          runId: current.id,
          runRevision: next.revision,
          sequence: sequence + 1,
          createdAt: cleanupNow,
          reason: 'retention_elapsed',
        }),
      }
    })).rejects.toThrow(/expired run transition/)
    expect(await store.getSourceReceipt('tenant-postgres', run.id, 'source-postgres'))
      .toMatchObject({ complete: true })
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ revision: 1, status: 'receiving' })
    await closeStore(store)
  })

  it('refuses a database schema newer than the service supports and closes failed pools', async () => {
    await rawPool!.query('INSERT INTO cat_analysis_schema_migrations(version) VALUES (999)')
    try {
      await expect(PostgresJobStore.connect({
        connectionString: databaseUrl!,
        ssl: 'disable',
        poolMax: 1,
        connectTimeoutMs: 10_000,
        cipher: new AesGcmContentCipher(key),
      })).rejects.toThrow(/newer than supported/)
    } finally {
      await rawPool!.query('DELETE FROM cat_analysis_schema_migrations WHERE version=999')
    }
  })

  it('upgrades an existing v2 schema through the current version without rebuilding earlier tables', async () => {
    const downgrade = await rawPool!.connect()
    try {
      await downgrade.query('BEGIN')
      await downgrade.query('DROP TABLE analysis_abandoned_requests')
      await downgrade.query('DROP TABLE analysis_provider_invocations')
      await downgrade.query('DROP TABLE analysis_artifacts')
      await downgrade.query('DELETE FROM cat_analysis_schema_migrations WHERE version >= 3')
      await downgrade.query('COMMIT')
    } catch (error) {
      await downgrade.query('ROLLBACK')
      throw error
    } finally { downgrade.release() }

    try {
    const upgraded = await connectStore()
    expect(await upgraded.checkHealth()).toBe(true)
    expect(await rawPool!.query<{ version: number }>(
      'SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations',
    )).toMatchObject({ rows: [{ version: ANALYSIS_SCHEMA_VERSION }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_artifacts'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_artifacts' }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_runs'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_runs' }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_provider_invocations'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_provider_invocations' }] })
    await closeStore(upgraded)
    } finally {
      // A failing assertion/connection must not leave subsequent tests on the old schema.
      const restore = await rawPool!.connect()
      try { await migrateAnalysisDatabase(restore) } finally { restore.release() }
    }
  })

  it('atomically encrypts, restores, isolates, and deletes generated artifacts', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 20_000,
      createId: (() => { let id = 0; return () => `artifact-postgres-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest('9'.repeat(64)))
    const generating = await store.transitionRun('tenant-postgres', created.run.id, 1, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 2,
        status: 'generating',
        stage: 'summary',
        progress: 0.55,
        artifactStates: {
          ...run.artifactStates,
          summary: { status: 'running', attempt: 1, updatedAt: 20_000 },
        },
        updatedAt: 20_000,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'artifact-stage-started',
          runId: run.id,
          runRevision: next.revision,
          sequence,
          createdAt: 20_000,
          stage: 'summary',
        }),
      }
    })
    expect(generating.outcome).toBe('updated')
    const lease = await store.acquireLease({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      nodeKey: 'artifacts:dag',
      ownerId: 'artifact-worker',
      now: 20_000,
      durationMs: 10_000,
    })
    expect(lease).toBeDefined()
    const identity = { tenantId: 'tenant-postgres', ...lease! }
    const artifact = summaryArtifactFor(created.run.id)
    const descriptor = createArtifactDescriptor(artifact)
    const buildSuccess = (run: typeof created.run, sequence: number) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'succeeded',
        stage: undefined,
        progress: 1,
        artifactStates: {
          ...run.artifactStates,
          summary: {
            status: 'succeeded',
            attempt: 1,
            artifactId: artifact.id,
            updatedAt: 20_100,
          },
        },
        updatedAt: 20_100,
        completedAt: 20_100,
      })
      return {
        run: next,
        events: [
          analysisEventSchema.parse({
            version: 1,
            type: 'artifact.ready',
            eventId: 'artifact-ready',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 20_100,
            descriptor,
          }),
          analysisEventSchema.parse({
            version: 1,
            type: 'run.completed',
            eventId: 'artifact-run-completed',
            runId: run.id,
            runRevision: next.revision,
            sequence: sequence + 1,
            createdAt: 20_100,
            status: 'succeeded',
            coverage: next.coverage,
          }),
        ],
      }
    }
    const commitInput = {
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      kind: 'summary' as const,
      expectedRevision: 2,
      expectedAttempt: 1,
      lease: identity,
      now: 20_100,
      result: 'succeeded' as const,
      artifact,
      descriptor,
      build: buildSuccess,
    }

    await expect(store.commitArtifact({
      ...commitInput,
      descriptor: { ...descriptor, artifactHash: hash('incorrect artifact hash') },
    })).rejects.toMatchObject({
      name: 'ArtifactValidationError',
      issues: [{
        code: 'identity_invalid',
        path: 'descriptor',
        message: 'artifact descriptor does not match its payload',
      }],
    })
    expect(await store.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()
    expect(await store.getRun('tenant-postgres', created.run.id)).toMatchObject({ revision: 2, status: 'generating' })
    expect(await store.commitArtifact({ ...commitInput, expectedRevision: 1 })).toMatchObject({
      outcome: 'revision_conflict',
    })
    expect(await store.commitArtifact({
      ...commitInput,
      lease: { ...identity, ownerId: 'inactive-worker' },
    })).toEqual({ outcome: 'lease_conflict' })
    expect(await store.commitArtifact({ ...commitInput, expectedAttempt: 2 })).toEqual({
      outcome: 'attempt_conflict',
    })
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        return {
          ...transition,
          run: analysisRunSchema.parse({ ...transition.run, revision: transition.run.revision + 1 }),
        }
      },
    })).rejects.toThrow(/artifact transition identity/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        const first = transition.events[0]
        if (!first || first.type !== 'artifact.ready') throw new Error('expected ready event fixture')
        return {
          ...transition,
          events: [{
            ...first,
            descriptor: { ...first.descriptor, artifactHash: hash('wrong event descriptor') },
          }, ...transition.events.slice(1)],
        }
      },
    })).rejects.toThrow(/does not match its result/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        return {
          ...transition,
          events: transition.events.map((event, index) => index === 0
            ? { ...event, sequence: event.sequence + 1 }
            : event),
        }
      },
    })).rejects.toThrow(/artifact event identity/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        const first = transition.events[0]
        if (!first) throw new Error('expected ready event fixture')
        return {
          ...transition,
          events: [first, analysisEventSchema.parse({
            version: 1,
            type: 'stage.started',
            eventId: 'invalid-artifact-terminal-event',
            runId: run.id,
            runRevision: transition.run.revision,
            sequence: sequence + 1,
            createdAt: 20_100,
            stage: 'summary',
          })],
        }
      },
    })).rejects.toThrow(/artifact terminal event/)
    expect(await store.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()

    const committed = await store.commitArtifact(commitInput)
    expect(committed).toMatchObject({ outcome: 'updated', run: { status: 'succeeded', revision: 3 } })
    expect(await store.getArtifact('tenant-other', created.run.id, 'summary')).toBeUndefined()
    expect(await store.listArtifactDescriptors('tenant-other', created.run.id)).toBeUndefined()
    await closeStore(store)

    const recovered = await connectStore()
    expect(await recovered.getArtifact('tenant-postgres', created.run.id, 'summary'))
      .toEqual({ artifact, descriptor })
    expect(await recovered.listArtifactDescriptors('tenant-postgres', created.run.id)).toEqual([descriptor])
    expect(await new RunService({ store: recovered, retentionSeconds: 3_600 })
      .getArtifact('tenant-postgres', created.run.id, 'summary')).toEqual(artifact)
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_artifacts WHERE tenant_id=$1 AND run_id=$2 AND kind=$3',
      ['tenant-postgres', created.run.id, 'summary'],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from('Encrypted artifact marker', 'utf8'))).toBe(false)
    expect(await rawPool!.query<{ version: number }>(
      'SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations',
    )).toMatchObject({ rows: [{ version: ANALYSIS_SCHEMA_VERSION }] })
    expect(await recovered.deleteContent('tenant-postgres', created.run.id)).toBe(true)
    expect(await recovered.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()
    expect(await recovered.listArtifactDescriptors('tenant-postgres', created.run.id)).toEqual([])
    expect(await rawPool!.query('SELECT 1 FROM analysis_artifacts WHERE run_id=$1', [created.run.id]))
      .toMatchObject({ rowCount: 0 })
    await closeStore(recovered)
  })

  it('encrypts exact evidence cache and graph data across restart and deletes derived content', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 10_000,
      createId: (() => { let id = 0; return () => `evidence-postgres-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest('8'.repeat(64)))
    await service.uploadSource('tenant-postgres', created.run.id, sourcePart())
    await service.startRun('tenant-postgres', created.run.id, 1)
    expect(await store.getSourceContent('tenant-postgres', created.run.id, 'source-postgres'))
      .toMatchObject({ text: plaintext, contentHash: hash(plaintext) })

    const snapshot = created.run.request.manifest.sources[0]!
    const chunks = planEvidenceChunks([{ snapshot, text: plaintext }], {
      version: 'postgres-evidence-v1',
      targetCharacters: 100,
      maxCharacters: 140,
      overlapCharacters: 10,
      minimumBoundaryRatio: 0.5,
    })
    const chunk = chunks[0]!
    const citationEnd = Math.min(chunk.end, chunk.start + 12)
    const citation = {
      version: 1 as const,
      provenance: 'source' as const,
      sourceId: chunk.sourceId,
      start: chunk.start,
      end: citationEnd,
      quote: plaintext.slice(chunk.start, citationEnd),
    }
    const card = evidenceCardSchema.parse({
      version: 1,
      chunkId: chunk.chunkId,
      chunkHash: chunk.chunkHash,
      sourceId: chunk.sourceId,
      titlePath: [],
      claims: [{ id: 'claim-local', kind: 'fact', statement: '持久证据正文', conceptIds: [], citations: [citation] }],
      terms: [],
      learningObjectives: [{ id: 'objective-local', text: '验证持久证据', evidenceIds: ['claim-local'] }],
    })
    const lease = await store.acquireLease({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      nodeKey: 'evidence:pipeline',
      ownerId: 'worker-evidence',
      now: 10_000,
      durationMs: 10_000,
    })
    expect(lease).toBeDefined()
    const identity = { tenantId: 'tenant-postgres', ...lease! }
    const cacheKey = hash('postgres-evidence-cache')
    const cardHash = hash(canonicalizeJson(card))
    const evidenceInput = {
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      lease: identity,
      now: 10_000,
      cacheKey,
      cardHash,
      chunk,
      card,
      expiresAt: 3_610_000,
    }
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      tenantId: 'tenant-other',
    })).rejects.toThrow(/lease identity/)
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      lease: { ...identity, runId: 'different-run' },
    })).rejects.toThrow(/lease identity/)
    expect(await store.storeEvidenceCard(evidenceInput)).toBe(true)
    expect(await store.storeEvidenceCard(evidenceInput)).toBe(true)

    const changedCard = evidenceCardSchema.parse({
      ...card,
      claims: [{ ...card.claims[0]!, statement: 'A different grounded claim' }],
    })
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      card: changedCard,
      cardHash: hash(canonicalizeJson(changedCard)),
    })).rejects.toBeInstanceOf(JobStoreConflictError)
    const conflictingCacheKey = hash('postgres-evidence-cache-conflict')
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      cacheKey: conflictingCacheKey,
    })).rejects.toBeInstanceOf(JobStoreConflictError)
    expect(await store.getCachedEvidenceCard('tenant-postgres', conflictingCacheKey, 10_000)).toBeUndefined()
    expect(await store.storeEvidenceCard({
      ...evidenceInput,
      lease: { ...identity, ownerId: 'inactive-worker' },
    })).toBe(false)
    expect(await store.getCachedEvidenceCard('tenant-other', cacheKey, 10_000)).toBeUndefined()
    expect(await store.getCachedEvidenceCard('tenant-postgres', cacheKey, 3_610_000)).toBeUndefined()
    expect(await store.listEvidenceCards('tenant-postgres', 'missing-evidence-run')).toBeUndefined()
    await closeStore(store)

    const reopened = await connectStore()
    expect(await reopened.getCachedEvidenceCard('tenant-postgres', cacheKey, 10_000))
      .toMatchObject({ cardHash, card: { claims: [{ statement: '持久证据正文' }] } })
    expect(await reopened.listEvidenceCards('tenant-postgres', created.run.id)).toHaveLength(1)
    const transitioned = await reopened.transitionRun('tenant-postgres', created.run.id, 2, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 3,
        status: 'merging',
        stage: 'merging',
        updatedAt: 10_100,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'evidence-merging-event',
          runId: run.id,
          runRevision: 3,
          sequence,
          createdAt: 10_100,
          stage: 'merging',
        }),
      }
    })
    expect(transitioned.outcome).toBe('updated')
    const coverage = calculateEvidenceCoverage({
      selectedRanges: { 'source-postgres': { start: 0, end: plaintext.length } },
      chunks: [chunk],
      cards: [card],
    })
    const graph = mergeEvidenceCards({
      runId: created.run.id,
      chunks: [chunk],
      cards: [card],
      sourceContentHashes: [hash(plaintext)],
      coverage,
      missingChunkIds: [],
      chunkPlanHash: hashChunkPlan([chunk]),
      policyVersion: 'postgres-evidence-v1',
      promptVersion: 'evidence-map-v1',
      generatorProfile: 'fixture-v1',
      createdAt: 10_100,
    })
    await expect(reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph: { ...graph, runId: 'different-run' },
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).rejects.toThrow(/graph run identity/)
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: 'missing-evidence-run',
      expectedRevision: 3,
      lease: { ...identity, runId: 'missing-evidence-run' },
      graph: { ...graph, runId: 'missing-evidence-run' },
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toEqual({ outcome: 'missing' })
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 2,
      lease: identity,
      graph,
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toMatchObject({ outcome: 'revision_conflict', run: { revision: 3 } })
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: { ...identity, ownerId: 'inactive-worker' },
      graph,
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toEqual({ outcome: 'lease_conflict' })
    await expect(reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph,
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'invalid-evidence-sequence',
            runId: run.id,
            runRevision: next.revision,
            sequence: sequence + 1,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toThrow(/evidence commit identity/)
    await expect(reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph,
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          coverage: graph.coverage,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'evidence-merging-event',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toThrow()
    expect(await reopened.getEvidenceGraph('tenant-postgres', created.run.id)).toBeUndefined()
    expect(await reopened.getRun('tenant-postgres', created.run.id)).toMatchObject({ revision: 3, status: 'merging' })
    // A graph already recorded at the built revision under a different hash is a same-revision conflict.
    // The placeholder row carries the legitimate graph hash so the subsequent commit upserts through it.
    await rawPool!.query(`
      INSERT INTO analysis_evidence_graphs(
        run_id, tenant_id, run_revision, graph_hash, key_id, iv, auth_tag, ciphertext, created_at
      ) VALUES ($1, $2, 4, $3, $4, $5, $5, $5, $6)
    `, [
      created.run.id,
      'tenant-postgres',
      graph.graphHash,
      'placeholder-key',
      Buffer.from([0]),
      10_099,
    ])
    await expect(reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph: { ...graph, graphHash: hash('conflicting-graph-at-revision-4') },
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'evidence-ready-conflicting',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 10_100,
            graphHash: hash('conflicting-graph-at-revision-4'),
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toBeInstanceOf(JobStoreConflictError)
    const committed = await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph,
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          coverage: graph.coverage,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'evidence-ready-event',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })
    expect(committed).toMatchObject({ outcome: 'updated', run: { revision: 4, status: 'generating' } })
    expect((await reopened.listEvents('tenant-postgres', created.run.id))?.at(-1))
      .toMatchObject({ type: 'evidence.ready', runRevision: 4, graphHash: graph.graphHash })
    await closeStore(reopened)

    const recovered = await connectStore()
    expect(await recovered.getEvidenceGraph('tenant-postgres', created.run.id))
      .toMatchObject({ graphHash: graph.graphHash, runId: created.run.id })
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_evidence_cache WHERE tenant_id=$1 AND cache_key=$2',
      ['tenant-postgres', cacheKey],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from('持久证据正文', 'utf8'))).toBe(false)
    expect(await recovered.deleteContent('tenant-postgres', created.run.id)).toBe(true)
    expect(await recovered.getEvidenceGraph('tenant-postgres', created.run.id)).toBeUndefined()
    expect(await recovered.listEvidenceCards('tenant-postgres', created.run.id)).toEqual([])
    expect(await recovered.getCachedEvidenceCard('tenant-postgres', cacheKey, 10_200)).toBeUndefined()
    await closeStore(recovered)
  })

  it('atomically reserves provider budgets and recovers stale invocation metadata without replay', async () => {
    const firstStore = await connectStore()
    const secondStore = await connectStore()
    const service = new RunService({
      store: firstStore,
      retentionSeconds: 3_600,
      now: () => 30_000,
      createId: (() => { let id = 0; return () => `provider-ledger-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest(hash('provider-ledger-request')))
    const reservation = (invocationId: string, nodeKey: string, now: number, maxTokens = 400) => ({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      invocationId,
      nodeKey,
      runAttempt: 1,
      role: 'evidence-map' as const,
      providerId: 'approved-provider',
      modelId: 'approved/model-v1',
      profileVersion: 'profile-v1',
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 100,
      reservedOutputTokens: 200,
      estimatedCostMicros: 500,
      maxRunEstimatedTokens: maxTokens,
      maxRunEstimatedCostMicros: 10_000,
      staleAfterMs: 1_000,
      now,
    })

    const concurrent = await Promise.all([
      firstStore.reserveProviderInvocation(reservation('provider-call-a', 'provider-node-a', 30_000)),
      secondStore.reserveProviderInvocation(reservation('provider-call-b', 'provider-node-b', 30_000)),
    ])
    expect(concurrent.map((result) => result.outcome).sort()).toEqual(['budget_exceeded', 'reserved'])
    const reserved = concurrent.find((result) => result.outcome === 'reserved')
    if (!reserved || reserved.outcome !== 'reserved') throw new Error('expected one provider reservation')

    const completed = await firstStore.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: reserved.invocation.invocationId,
      transportAttempts: 1,
      now: 30_100,
      result: 'succeeded',
      actualInputTokens: 80,
      actualOutputTokens: 40,
      providerRequestId: 'provider-request-postgres',
    })
    expect(completed).toMatchObject({ outcome: 'updated', invocation: { status: 'succeeded' } })
    await expect(firstStore.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: reserved.invocation.invocationId,
      transportAttempts: 1,
      now: 30_200,
      result: 'failed',
      safeCode: 'must_not_overwrite',
    })).resolves.toMatchObject({ outcome: 'state_conflict', invocation: { status: 'succeeded' } })

    const staleId = reserved.invocation.invocationId === 'provider-call-a' ? 'provider-call-b' : 'provider-call-a'
    const staleNode = staleId === 'provider-call-a' ? 'provider-node-a' : 'provider-node-b'
    expect(await firstStore.reserveProviderInvocation(reservation(staleId, staleNode, 31_000, 420)))
      .toMatchObject({ outcome: 'reserved', invocation: { status: 'running' } })
    expect(await secondStore.reserveProviderInvocation(reservation(staleId, staleNode, 32_000, 1_000)))
      .toMatchObject({ outcome: 'existing', invocation: { status: 'outcome_unknown' } })
    await expect(firstStore.reserveProviderInvocation({
      ...reservation(staleId, 'different-node', 32_100, 1_000),
    })).rejects.toBeInstanceOf(JobStoreConflictError)

    await closeStore(firstStore)
    await closeStore(secondStore)
    const reopened = await connectStore()
    expect(await reopened.getProviderInvocation('tenant-postgres', reserved.invocation.invocationId))
      .toMatchObject({ status: 'succeeded', actualInputTokens: 80, actualOutputTokens: 40 })
    expect(await reopened.getProviderInvocation('tenant-postgres', staleId))
      .toMatchObject({ status: 'outcome_unknown' })
    expect(await reopened.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: 'missing-provider-call',
      transportAttempts: 0,
      now: 32_200,
      result: 'failed',
      safeCode: 'missing',
    })).toEqual({ outcome: 'missing' })

    const columns = await rawPool!.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='analysis_provider_invocations'
    `)
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      'prompt',
      'source_text',
      'raw_response',
      'api_key',
    ]))
    await closeStore(reopened)
  })

  it('guards provider reservations against terminal runs, duplicate nodes, and cost overruns', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 40_000,
      createId: (() => { let id = 0; return () => `provider-guard-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest(hash('provider-guard-request')))
    type ReservationInput = Parameters<PostgresJobStore['reserveProviderInvocation']>[0]
    const reserve = (overrides: Partial<ReservationInput> = {}): ReservationInput => ({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      invocationId: 'guard-call',
      nodeKey: 'guard-node',
      runAttempt: 1,
      role: 'evidence-map',
      providerId: 'approved-provider',
      modelId: 'approved/model-v1',
      profileVersion: 'profile-v1',
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 100,
      reservedOutputTokens: 200,
      estimatedCostMicros: 500,
      maxRunEstimatedTokens: 400,
      maxRunEstimatedCostMicros: 10_000,
      staleAfterMs: 1_000,
      now: 40_000,
      ...overrides,
    })

    // Cost ceiling is checked before any ledger row is written.
    await expect(store.reserveProviderInvocation(reserve({ maxRunEstimatedCostMicros: 100 })))
      .resolves.toMatchObject({ outcome: 'budget_exceeded', dimension: 'cost' })

    expect(await store.reserveProviderInvocation(reserve()))
      .toMatchObject({ outcome: 'reserved', invocation: { invocationId: 'guard-call', status: 'running' } })

    // A fresh duplicate returns the existing row without marking it stale or reserving twice.
    expect(await store.reserveProviderInvocation(reserve({ now: 40_500 })))
      .toMatchObject({ outcome: 'existing', invocation: { status: 'running' } })

    // Same run/node/attempt under a different invocation identity is a conflict.
    await expect(store.reserveProviderInvocation(reserve({ invocationId: 'guard-call-other' })))
      .rejects.toBeInstanceOf(JobStoreConflictError)

    const terminal = await service.createRun('tenant-postgres', makeRequest(hash('provider-terminal-request')))
    await rawPool!.query("UPDATE analysis_runs SET status='succeeded' WHERE run_id=$1", [terminal.run.id])
    await expect(store.reserveProviderInvocation(reserve({
      runId: terminal.run.id,
      invocationId: 'guard-terminal',
      nodeKey: 'guard-terminal-node',
    }))).rejects.toBeInstanceOf(JobStoreConflictError)

    const deleted = await service.createRun('tenant-postgres', makeRequest(hash('provider-deleted-request')))
    expect(await store.deleteContent('tenant-postgres', deleted.run.id)).toBe(true)
    await expect(store.reserveProviderInvocation(reserve({
      runId: deleted.run.id,
      invocationId: 'guard-deleted',
      nodeKey: 'guard-deleted-node',
    }))).rejects.toBeInstanceOf(JobStoreConflictError)

    // A missing source/run resolves to undefined instead of surfacing the not-found error.
    expect(await store.getSourceContent('tenant-postgres', 'missing-guard-run', 'source-postgres')).toBeUndefined()

    await closeStore(store)
  })

  it('rolls back a failed migration without recording its version', async () => {
    // Isolated schema: pre-create an incompatible analysis_runs so v1 DDL aborts mid-transaction.
    const schemaName = `migfail_${Date.now().toString(36)}`
    await rawPool!.query(`CREATE SCHEMA ${schemaName}`)
    const failPool = new Pool({ connectionString: databaseUrl! })
    const client = await failPool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}`)
      await client.query('CREATE TABLE analysis_runs (obstacle INTEGER)')
      await expect(migrateAnalysisDatabase(client)).rejects.toThrow()
      const result = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM cat_analysis_schema_migrations',
      )
      // The bookkeeping row for the aborted v1 migration must not survive its rollback.
      expect(Number(result.rows[0]?.count)).toBe(0)
    } finally {
      client.release()
      await failPool.end()
      await rawPool!.query(`DROP SCHEMA ${schemaName} CASCADE`)
    }
  })
})

integration('PostgreSQL bounded Evidence and ambiguous transport recovery', () => {
  const groupingPolicy = { version: 'pg-grouping-v2', targetCharacters: 100, maxCharacters: 100,
    overlapCharacters: 0, minimumBoundaryRatio: 0.5 }

  const preparedInput = async (store: PostgresJobStore, testKey: string, text: string) => {
    const service = new RunService({ store, retentionSeconds: 3600 })
    const request = analysisRequestSchema.parse({ ...makeRequest(hash(testKey)), manifest: { version: 1, sources: [{
      version: 1, sourceId: 'source-postgres', kind: 'text', extractor: 'synthetic-grouping-v2',
      contentHash: hash(text), charCount: text.length, byteCount: Buffer.byteLength(text),
    }] } })
    const created = await service.createRun('tenant-bounded', request)
    await service.uploadSource('tenant-bounded', created.run.id, { ...sourcePart(), contentHash: hash(text), partHash: hash(text), end: text.length, totalChars: text.length, text })
    await service.startRun('tenant-bounded', created.run.id, created.run.revision)
    return { service, runId: created.run.id }
  }

  it('retains 51 concepts and 101 objective relations through adapters and database reopening', async () => {
    const store = await connectStore()
    const prepared = await preparedInput(store, 'pg-bounded-relations-v2', 'R'.repeat(200))
    const provider = new FakeAnalysisProvider()
    provider.override = (request) => {
      if (request.role !== 'evidence-map') return provider.output(request)
      const data = JSON.parse(request.userPrompt.slice(request.userPrompt.indexOf('\n') + 1)) as { ordinal: number; range: { start: number; end: number } }
      const citations = [{ start: data.range.start, end: data.range.start + 1 }]
      const terms = Array.from({ length: data.ordinal === 0 ? 25 : 26 }, (_unused, index) => ({
        id: `term-${index}`, term: `concept-${data.ordinal}-${index}`, citations,
      }))
      const uniqueClaims = Array.from({ length: data.ordinal === 0 ? 50 : 51 }, (_unused, index) => ({
        id: `claim-${index}`, kind: 'fact', statement: `Unique synthetic statement ${data.ordinal}-${index}`, conceptIds: [], citations,
      }))
      return JSON.stringify({ terms, claims: [{ id: 'shared-claim', kind: 'fact', statement: 'Shared synthetic statement', conceptIds: terms.map((term) => term.id), citations }, ...uniqueClaims],
        learningObjectives: [{ id: 'own-group', text: `Own concept group ${data.ordinal}`, evidenceIds: ['shared-claim'] },
          { id: 'shared-objective', text: 'Shared objective with complete evidence', evidenceIds: uniqueClaims.map((claim) => claim.id) }] })
    }
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 10_000, estimateCostMicros: () => 1 })
    const mapped = await new EvidencePipelineWorker({ store, generator: runtime.legacyEvidenceGenerator, broker: prepared.service.broker,
      leaseMs: 10_000, chunkPolicy: groupingPolicy }).runOnce('tenant-bounded', prepared.runId, 'bounded-map', new AbortController().signal)
    expect(mapped.outcome).toBe('completed')
    const graph = (await store.getEvidenceGraph('tenant-bounded', prepared.runId))!
    const sharedClaims = graph.claims.filter((claim) => claim.statement === 'Shared synthetic statement')
    expect(sharedClaims).toHaveLength(2)
    expect(new Set(sharedClaims.flatMap((claim) => claim.conceptIds))).toEqual(new Set(graph.terms.map((term) => term.id)))
    const sharedObjectives = graph.learningObjectives.filter((objective) => objective.text === 'Shared objective with complete evidence')
    expect(sharedObjectives).toHaveLength(2)
    expect(new Set(sharedObjectives.flatMap((objective) => objective.evidenceIds)).size).toBe(101)
    expect((await runtime.artifacts.runOnce('tenant-bounded', prepared.runId, 'bounded-artifact', new AbortController().signal)).run.status).toBe('succeeded')
    const ledger = await store.getRunLedgerUsage('tenant-bounded', prepared.runId)
    expect(ledger).toMatchObject({ invocationCount: 3, unresolvedCount: 0 })
    await closeStore(store)
    const reopened = await connectStore()
    expect(await reopened.getEvidenceGraph('tenant-bounded', prepared.runId)).toEqual(graph)
    expect(await reopened.getRunLedgerUsage('tenant-bounded', prepared.runId)).toEqual(ledger)
    expect((await new RunService({ store: reopened, retentionSeconds: 3600 }).getArtifact('tenant-bounded', prepared.runId, 'summary')).kind).toBe('summary')
    expect(provider.calls).toHaveLength(3)
  }, 30_000)

  it('stops a whole-graph overflow before any Artifact or repair invocation and retains mapped usage', async () => {
    const store = await connectStore()
    const prepared = await preparedInput(store, 'pg-capacity-failure-v2', 'R'.repeat(10_100))
    const provider = new FakeAnalysisProvider()
    provider.override = (request) => {
      if (request.role !== 'evidence-map') throw new Error('Artifact must not run after Evidence capacity failure')
      const data = JSON.parse(request.userPrompt.slice(request.userPrompt.indexOf('\n') + 1)) as { ordinal: number; range: { start: number } }
      return JSON.stringify({ claims: Array.from({ length: 200 }, (_unused, index) => ({
        id: `claim-${index}`, kind: 'fact', statement: `Unique capacity statement ${data.ordinal}-${index}`,
        conceptIds: [], citations: [{ start: data.range.start, end: data.range.start + 1 }],
      })), terms: [], learningObjectives: [] })
    }
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 30_000, estimateCostMicros: () => 1 })
    const result = await new EvidencePipelineWorker({ store, generator: runtime.legacyEvidenceGenerator, broker: prepared.service.broker,
      leaseMs: 30_000, chunkPolicy: groupingPolicy }).runOnce('tenant-bounded', prepared.runId, 'capacity-map', new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'failed', run: { status: 'failed', error: { code: 'budget_exceeded', retryable: false,
      details: { dimension: 'evidence_graph_claims', maximum: 20_000 } } } })
    await runtime.artifacts.runOnce('tenant-bounded', prepared.runId, 'capacity-artifact', new AbortController().signal)
    expect(provider.calls).toHaveLength(101)
    expect(provider.calls.every((request) => request.role === 'evidence-map')).toBe(true)
    expect(await store.getRunLedgerUsage('tenant-bounded', prepared.runId)).toMatchObject({ invocationCount: 101, unresolvedCount: 0,
      usage: { inputTokens: 2020, outputTokens: 1010 } })
    expect(await store.getEvidenceGraph('tenant-bounded', prepared.runId)).toBeUndefined()
    expect(await store.listArtifactDescriptors('tenant-bounded', prepared.runId)).toEqual([])
  }, 30_000)

  it('persists a mock accepted POST with a lost response as unknown across database reopening without redelivery', async () => {
    const store = await connectStore()
    const prepared = await prepareFixtureRun(store, 'pg-ambiguous-post-v2', Date.now, ['summary'])
    let transports = 0
    const provider = new OpenAICompatibleProvider({ id: 'synthetic-compatible', modelId: 'synthetic-model', profileVersion: 'synthetic-v2',
      apiStyle: 'responses', baseUrl: 'https://models.example.com/v1', allowedHosts: ['models.example.com'], apiKey: 'synthetic-never-live',
      requestTimeoutMs: 1000, maxInputCharacters: 1_000_000, maxOutputTokens: 32_000, maxResponseBytes: 1_000_000,
      fetchImplementation: async (_url, init) => { expect(init?.method).toBe('POST'); transports += 1; throw new TypeError('synthetic response lost after acceptance') } })
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 1000, estimateCostMicros: () => 7 })
    expect(await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'ambiguous-map', new AbortController().signal)).toMatchObject({ outcome: 'failed',
      run: { error: { retryable: false, details: { reason: 'invocation_outcome_unknown' } } } })
    const ledger = await store.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)
    expect(ledger).toMatchObject({ invocationCount: 1, unresolvedCount: 1, usage: { estimatedCostMicros: 7 } })
    await closeStore(store)
    const reopened = await connectStore()
    const service = new RunService({ store: reopened, retentionSeconds: 3600 })
    const recovered = createAnalysisProviderRuntime({ store: reopened, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 7 })
    await recovered.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'ambiguous-recovery', new AbortController().signal)
    await recovered.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'ambiguous-artifacts', new AbortController().signal)
    expect(await reopened.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)).toEqual(ledger)
    expect(transports).toBe(1)
  }, 30_000)
})
