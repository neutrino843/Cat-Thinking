import { analysisRunSchema } from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { assertArtifactRetryAllowed } from '../src/domain/artifactRetryPolicy.js'
import type { RetryTransitionContext } from '../src/domain/jobStore.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createContractError } from '../src/errors.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import type { StoredProviderInvocation } from '../src/providers/invocationLedger.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'

const prepare = async (costs: readonly number[], status: StoredProviderInvocation['status'] = 'failed') => {
  const store = new InMemoryJobStore()
  const prepared = await prepareFixtureRun(store, `retry-policy-${costs.join('-')}-${status}`, Date.now, ['summary'])
  const provider = new FakeAnalysisProvider()
  const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker,
    leaseMs: 1000, estimateCostMicros: () => 0 })
  await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'policy-fixture', new AbortController().signal)
  const current = (await store.getRun(FIXTURE_TENANT, prepared.runId))!
  const invocation = (await store.getProviderInvocation(FIXTURE_TENANT, provider.calls[0]!.invocationId))!
  const run = analysisRunSchema.parse({ ...current, status: 'failed', stage: undefined, completedAt: Date.now(), artifactStates: {
    summary: { status: 'failed', attempt: 1, updatedAt: Date.now(),
      error: createContractError('rate_limited', 'rate-limit', true, 'analysis.artifact.synthetic_refused') },
  } })
  const context: RetryTransitionContext = { contentDeleted: false, sourceSnapshotReady: true,
    graph: (await store.getEvidenceGraph(FIXTURE_TENANT, prepared.runId))!,
    invocations: costs.map((estimatedCostMicros, index) => ({ ...invocation,
      invocationId: `summary-refusal-${index}`, nodeKey: index === 0 ? 'artifact:summary' : 'artifact:summary:repair',
      role: index === 0 ? 'artifact-summary' : 'repair', runAttempt: 1, status, estimatedCostMicros,
    })),
  }
  return { run, context }
}

describe('Artifact retry budget admission', () => {
  it.each([[], [0], [0, 0]])('admits safe retries when the zero-price placeholder has only zero history %j', async (...costs) => {
    const { run, context } = await prepare(costs)
    expect(() => assertArtifactRetryAllowed(run, 'summary', context, Date.now(), {
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 0,
    })).not.toThrow()
  })

  it.each([
    { cap: 0, costs: [0, 1] },
    { cap: 1, costs: [1] },
    { cap: 2, costs: [1, 1] },
    { cap: 1, costs: [2] },
  ])('retains cost rejection for cap=$cap and nonzero or exhausted history $costs', async ({ cap, costs }) => {
    const { run, context } = await prepare(costs)
    expect(() => assertArtifactRetryAllowed(run, 'summary', context, Date.now(), {
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: cap,
    })).toThrow(expect.objectContaining({ contractError: expect.objectContaining({ code: 'budget_exceeded' }) }))
  })

  it('continues to admit a priced retry below its positive cost cap', async () => {
    const { run, context } = await prepare([1])
    expect(() => assertArtifactRetryAllowed(run, 'summary', context, Date.now(), {
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 2,
    })).not.toThrow()
  })

  it('keeps token reservations authoritative under zero-price estimates', async () => {
    const { run, context } = await prepare([0])
    expect(() => assertArtifactRetryAllowed(run, 'summary', context, Date.now(), {
      maxRunEstimatedTokens: 1200, maxRunEstimatedCostMicros: 0,
    })).toThrow(expect.objectContaining({ contractError: expect.objectContaining({ code: 'budget_exceeded' }) }))
  })

  it.each([
    { status: 'running' as const, nodeKey: 'artifact:summary' },
    { status: 'outcome_unknown' as const, nodeKey: 'artifact:summary' },
    { status: 'running' as const, nodeKey: 'artifact:summary:repair' },
    { status: 'outcome_unknown' as const, nodeKey: 'artifact:summary:repair' },
  ])('keeps a $status $nodeKey call nonretryable even with zero prices', async ({ status, nodeKey }) => {
    const { run, context } = await prepare([0], status)
    const guardedContext = { ...context, invocations: context.invocations.map((invocation) => ({ ...invocation, nodeKey })) }
    expect(() => assertArtifactRetryAllowed(run, 'summary', guardedContext, Date.now(), {
      maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 0,
    })).toThrow(expect.objectContaining({ contractError: expect.objectContaining({ messageKey: 'analysis.artifact.invocation_outcome_unknown' }) }))
  })
})
