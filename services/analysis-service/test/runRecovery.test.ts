import { analysisEventSchema, analysisRunSchema, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createContractError } from '../src/errors.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, fixtureRequest, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'

const time = 20_000
const reservation = (runId: string) => ({ tenantId: FIXTURE_TENANT, runId, invocationId: 'lost-response',
  nodeKey: 'artifact:summary', runAttempt: 1, role: 'artifact-summary' as const, providerId: 'synthetic-provider',
  modelId: 'synthetic-model', profileVersion: 'synthetic-v1', promptVersion: 'summary-v1',
  estimatedInputTokens: 5, reservedOutputTokens: 20, estimatedCostMicros: 2,
  maxRunEstimatedTokens: 100_000, maxRunEstimatedCostMicros: 100_000, staleAfterMs: 1000, now: time })

async function markFailure(store: InMemoryJobStore, run: AnalysisRunV1, retryable = true) {
  const error = createContractError('internal_error', 'internal', retryable, 'analysis.artifact.synthetic_failed')
  const result = await store.transitionRun(FIXTURE_TENANT, run.id, run.revision, (current, sequence) => {
    const next = analysisRunSchema.parse({ ...current, revision: current.revision + 1, status: 'failed',
      stage: undefined, artifactStates: { summary: { status: 'failed', attempt: 1, error, updatedAt: time } }, completedAt: time })
    return { run: next, event: analysisEventSchema.parse({ version: 1, type: 'artifact.failed', eventId: `failed-${sequence}`,
      runId: run.id, runRevision: next.revision, sequence, createdAt: time, kind: 'summary', error }) }
  })
  if (result.outcome !== 'updated') throw new Error('fixture failed to checkpoint')
  return result.run
}

async function generating(key: string) {
  const store = new InMemoryJobStore()
  const prepared = await prepareFixtureRun(store, key, () => time, ['summary'])
  const provider = new FakeAnalysisProvider()
  const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 1000,
    now: () => time, estimateCostMicros: () => 1 })
  await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'fixture-worker', new AbortController().signal)
  return { store, ...prepared, provider, run: await prepared.service.getRun(FIXTURE_TENANT, prepared.runId) }
}

describe('request reconciliation and authoritative retries', () => {
  it('looks up immutable intent identity without creating or crossing tenants, even while admission is held', async () => {
    const store = new InMemoryJobStore()
    const service = new RunService({ store, retentionSeconds: 3600 })
    const request = fixtureRequest('lookup-only', ['summary'])
    const created = await service.createRun(FIXTURE_TENANT, request)
    service.setAdmissionGuard(async () => false)
    expect(await service.lookupRequest(FIXTURE_TENANT, request.requestKey)).toMatchObject({ status: 'found', run: { id: created.run.id } })
    expect(await service.lookupRequest('different-tenant', request.requestKey)).toMatchObject({ status: 'absent' })
    expect((await service.getUsage(FIXTURE_TENANT, created.run.id)).invocationCount).toBe(0)
    await expect(service.startRun(FIXTURE_TENANT, created.run.id, 1)).rejects.toMatchObject({ statusCode: 503 })
  })

  it.each(['create-first', 'abandon-first', 'concurrent'])('keeps the abandoned request barrier for %s', async (order) => {
    const store = new InMemoryJobStore()
    const service = new RunService({ store, retentionSeconds: 3600 })
    const request = fixtureRequest(order, ['summary'])
    if (order === 'create-first') await service.createRun(FIXTURE_TENANT, request)
    if (order === 'concurrent') await Promise.allSettled([service.createRun(FIXTURE_TENANT, request), service.abandonRequest(FIXTURE_TENANT, request.requestKey)])
    await service.abandonRequest(FIXTURE_TENANT, request.requestKey)
    service.setAdmissionGuard(async () => false)
    expect(await service.abandonRequest(FIXTURE_TENANT, request.requestKey)).toMatchObject({ abandoned: true })
    expect(await service.lookupRequest(FIXTURE_TENANT, request.requestKey)).toMatchObject({ status: 'abandoned' })
    service.setAdmissionGuard(async () => true)
    await expect(service.createRun(FIXTURE_TENANT, request)).rejects.toMatchObject({ statusCode: 409 })
    expect(await service.lookupRequest('other-tenant', request.requestKey)).toMatchObject({ status: 'absent' })
    expect(await store.listDispatchableRuns(Date.now(), 10)).toEqual([])
  })

  it('rejects unknown invocations without incrementing the attempt and retains late usage after abandon', async () => {
    const { store, service, run } = await generating('unknown-retry')
    await store.reserveProviderInvocation(reservation(run.id))
    await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'lost-response',
      result: 'outcome_unknown', failureKind: 'outcome_unknown', safeCode: 'response_lost', transportAttempts: 1, now: time + 1 })
    const failed = await markFailure(store, run)
    await expect(service.retryArtifact(FIXTURE_TENANT, run.id, 'summary', failed.revision)).rejects.toMatchObject({ statusCode: 409 })
    expect((await service.getRun(FIXTURE_TENANT, run.id)).revision).toBe(failed.revision)
    expect(await service.getUsage(FIXTURE_TENANT, run.id)).toMatchObject({ invocationCount: 2, unresolvedCount: 1, completeness: 'unresolved' })
    await service.abandonRequest(FIXTURE_TENANT, failed.requestKey)
    await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'lost-response', result: 'succeeded',
      actualInputTokens: 7, actualOutputTokens: 4, transportAttempts: 1, now: time + 2 })
    expect(await service.getUsage(FIXTURE_TENANT, run.id)).toMatchObject({ unresolvedCount: 0, completeness: 'complete', usage: { inputTokens: 27, outputTokens: 14 } })
    expect(await store.getProviderInvocation(FIXTURE_TENANT, 'lost-response')).toMatchObject({ status: 'succeeded', failureKind: undefined, safeCode: undefined })
    expect(await store.getEvidenceGraph(FIXTURE_TENANT, run.id)).toBeUndefined()
    expect(await store.acquireLease({ tenantId: FIXTURE_TENANT, runId: run.id, nodeKey: 'artifacts:dag', ownerId: 'late', now: time + 3, durationMs: 1000 })).toBeUndefined()
  })

  it.each(['deleted', 'expired', 'held', 'nonretryable'])('rejects %s retry without state migration', async (reason) => {
    const { store, service, run } = await generating(`reject-${reason}`)
    const failed = await markFailure(store, run, reason !== 'nonretryable')
    if (reason === 'deleted') await service.deleteContent(FIXTURE_TENANT, run.id)
    if (reason === 'held') service.setAdmissionGuard(async () => false)
    const retryService = reason === 'expired' ? new RunService({ store, retentionSeconds: 3600, now: () => failed.expiresAt! }) : service
    await expect(retryService.retryArtifact(FIXTURE_TENANT, run.id, 'summary', failed.revision)).rejects.toMatchObject({ statusCode: reason === 'held' ? 503 : reason === 'deleted' || reason === 'expired' ? 410 : 409 })
    expect((await service.getRun(FIXTURE_TENANT, run.id)).revision).toBe(failed.revision)
    expect((await service.getUsage(FIXTURE_TENANT, run.id)).invocationCount).toBe(1)
  })

  it('gives exactly one concurrent explicit retry the CAS transition', async () => {
    const { store, service, run } = await generating('retry-cas')
    const failed = await markFailure(store, run)
    const results = await Promise.allSettled([service.retryArtifact(FIXTURE_TENANT, run.id, 'summary', failed.revision), service.retryArtifact(FIXTURE_TENANT, run.id, 'summary', failed.revision)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await service.getRun(FIXTURE_TENANT, run.id)).artifactStates.summary).toMatchObject({ status: 'pending', attempt: 2 })
    expect((await service.getUsage(FIXTURE_TENANT, run.id)).invocationCount).toBe(1)
  })

  it.each(['tokens', 'cost'])('rejects a retry with exhausted %s reservations without another invocation', async (dimension) => {
    const { store, service, run } = await generating(`retry-budget-${dimension}`)
    const failed = await markFailure(store, run)
    const bounded = new RunService({ store, retentionSeconds: 3600, now: () => time,
      maxRunEstimatedTokens: dimension === 'tokens' ? 1 : Number.MAX_SAFE_INTEGER,
      maxRunEstimatedCostMicros: dimension === 'cost' ? 1 : Number.MAX_SAFE_INTEGER })
    await expect(bounded.retryArtifact(FIXTURE_TENANT, run.id, 'summary', failed.revision)).rejects.toMatchObject({ contractError: { code: 'budget_exceeded' } })
    expect((await service.getRun(FIXTURE_TENANT, run.id)).revision).toBe(failed.revision)
    expect((await service.getUsage(FIXTURE_TENANT, run.id)).invocationCount).toBe(1)
  })

  it('rejects unsupported external knowledge before persisting any run', async () => {
    const store = new InMemoryJobStore()
    const service = new RunService({ store, retentionSeconds: 3600 })
    const request = fixtureRequest('unsupported', ['summary'])
    await expect(service.createRun(FIXTURE_TENANT, { ...request, options: { ...request.options, externalKnowledge: true } })).rejects.toMatchObject({ statusCode: 400 })
    expect(await service.lookupRequest(FIXTURE_TENANT, request.requestKey)).toMatchObject({ status: 'absent' })
  })
})
