import { describe, expect, it } from 'vitest'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { prepareFixtureRun, FIXTURE_TENANT } from './fixtures/fakeAnalysisProvider.js'

describe('invocation count reservation budget', () => {
  it('counts every reserved call atomically while keeping same-id replay idempotent', async () => {
    const store = new InMemoryJobStore()
    const { runId } = await prepareFixtureRun(store, 'personal-memory-call-quota')
    const input = (index: number) => ({ tenantId: FIXTURE_TENANT, runId, invocationId: `quota-${index}`, nodeKey: `quota:${index}`,
      runAttempt: 1, role: 'evidence-map' as const, providerId: 'synthetic-provider', modelId: 'synthetic-model', profileVersion: 'synthetic-v1',
      promptVersion: 'synthetic-v1', estimatedInputTokens: 1, reservedOutputTokens: 1, estimatedCostMicros: 0,
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 0, maxRunInvocations: 2, staleAfterMs: 600000, now: 1000 })
    const results = await Promise.all([1, 2, 3].map((index) => store.reserveProviderInvocation(input(index))))
    expect(results.filter((result) => result.outcome === 'reserved')).toHaveLength(2)
    expect(results[2]).toMatchObject({ outcome: 'budget_exceeded', dimension: 'invocations', maximum: 2, actual: 3 })
    expect((await store.reserveProviderInvocation(input(1))).outcome).toBe('existing')
    expect((await store.getRunLedgerUsage(FIXTURE_TENANT, runId))?.invocationCount).toBe(2)
  })
  it('keeps unknown outcomes inside the invocation cap and rejects invalid cap values', async () => {
    const store = new InMemoryJobStore()
    const { runId } = await prepareFixtureRun(store, 'personal-memory-unknown-quota')
    const input = { tenantId: FIXTURE_TENANT, runId, invocationId: 'unknown-quota', nodeKey: 'quota:unknown', runAttempt: 1,
      role: 'evidence-map' as const, providerId: 'synthetic-provider', modelId: 'synthetic-model', profileVersion: 'synthetic-v1',
      promptVersion: 'synthetic-v1', estimatedInputTokens: 1, reservedOutputTokens: 1, estimatedCostMicros: 0,
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 0, maxRunInvocations: 1, staleAfterMs: 600000, now: 1000 }
    await expect(store.reserveProviderInvocation({ ...input, maxRunInvocations: 0 })).rejects.toThrow('maxRunInvocations')
    await store.reserveProviderInvocation(input)
    await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: input.invocationId, result: 'outcome_unknown',
      transportAttempts: 1, safeCode: 'synthetic_unknown', now: 1001 })
    const next = await store.reserveProviderInvocation({ ...input, invocationId: 'next-quota', nodeKey: 'quota:next' })
    expect(next).toMatchObject({ outcome: 'budget_exceeded', dimension: 'invocations', actual: 2, maximum: 1 })
  })
})
