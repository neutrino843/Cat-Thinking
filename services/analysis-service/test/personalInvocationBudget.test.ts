import { describe, expect, it } from 'vitest'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { prepareFixtureRun, FIXTURE_TENANT } from './fixtures/fakeAnalysisProvider.js'

describe('invocation count reservation budget', () => {
  it.each([
    ['succeeded', 20, 10, 'reserved'],
    ['failed', 20, 10, 'reserved'],
    ['succeeded', 150, 100, 'budget_exceeded'],
    ['failed', 20, undefined, 'budget_exceeded'],
    ['outcome_unknown', 20, 10, 'budget_exceeded'],
    ['running', undefined, undefined, 'budget_exceeded'],
  ] as const)('accounts for %s outcome without releasing uncertain reservations', async (status, inputTokens, outputTokens, outcome) => {
    const store = new InMemoryJobStore()
    const { runId } = await prepareFixtureRun(store, 'settled-token-budget')
    const reservation = { tenantId: FIXTURE_TENANT, runId, invocationId: 'first', nodeKey: 'first', runAttempt: 1,
      role: 'evidence-map' as const, providerId: 'synthetic', modelId: 'synthetic', profileVersion: 'v1', promptVersion: 'v1',
      estimatedInputTokens: 100, reservedOutputTokens: 100, estimatedCostMicros: 0, maxRunEstimatedTokens: 250,
      maxRunEstimatedCostMicros: 0, maxRunInvocations: 2, staleAfterMs: 600000, now: 1000 }
    await store.reserveProviderInvocation(reservation)
    if (status === 'succeeded') await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'first',
      result: status, actualInputTokens: inputTokens!, actualOutputTokens: outputTokens!, transportAttempts: 1, now: 1001 })
    else if (status !== 'running') await store.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: 'first',
      result: status, actualInputTokens: inputTokens, actualOutputTokens: outputTokens, safeCode: 'test', transportAttempts: 1, now: 1001 })
    expect(await store.reserveProviderInvocation({ ...reservation, invocationId: 'second', nodeKey: 'second',
      estimatedInputTokens: 50, reservedOutputTokens: 50 })).toMatchObject({ outcome })
    // Forecast totals remain available for diagnostics regardless of admission accounting.
    expect((await store.getRunLedgerUsage(FIXTURE_TENANT, runId))?.invocationCount).toBe(outcome === 'reserved' ? 2 : 1)
  })
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
