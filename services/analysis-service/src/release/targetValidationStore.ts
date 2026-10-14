import { canonicalizeJson, type AnalysisRequestV1, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import type { JobStore } from '../domain/jobStore.js'
import type { CompleteProviderInvocationInput, ReserveProviderInvocationInput } from '../providers/invocationLedger.js'

export interface TargetValidationScope {
  readonly tenantId: string; readonly runId: string; readonly request: AnalysisRequestV1
}
export interface TargetValidationBudget {
  readonly maxEstimatedTokens: number; readonly maxEstimatedCostMicros: number; readonly timeoutMs: number
}

/** A capability wrapper, not a discovery filter: every operation is fenced. */
export const createTargetValidationStore = (store: JobStore, scope: TargetValidationScope, budget: TargetValidationBudget): JobStore => {
  const fail = (): never => { throw new Error('target_validation_scope_violation') }
  const tenant = (value: unknown): void => { if (value !== scope.tenantId) fail() }
  const run = (tenantId: unknown, runId: unknown): void => { tenant(tenantId); if (runId !== scope.runId) fail() }
  const input = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) fail()
    const candidate = value as { tenantId?: unknown; runId?: unknown }
    run(candidate.tenantId, candidate.runId)
  }
  const tenantRunMethods = new Set(['getRun', 'transitionRun', 'markSourceComplete', 'getSourceReceipt', 'getSourceContent',
    'listEvidenceCards', 'getEvidenceGraph', 'getArtifact', 'listArtifactDescriptors', 'deleteContent', 'listEvents', 'getRunLedgerUsage'])
  const inputMethods = new Set(['storeSourcePart', 'storeEvidenceCard', 'commitEvidenceGraph', 'commitArtifact', 'acquireLease', 'renewLease', 'releaseLease'])
  return new Proxy(store, { get(target, property) {
    if (property === 'then') return undefined
    if (property === 'checkHealth') return target.checkHealth.bind(target)
    if (property === 'listDispatchableRuns') return async (now: number, limit: number) => {
      const current = await target.getRun(scope.tenantId, scope.runId)
      return limit > 0 && current && (current.expiresAt ?? Infinity) > now
        && ['queued', 'planning', 'mapping', 'merging', 'generating'].includes(current.status)
        ? [{ tenantId: scope.tenantId, runId: scope.runId }] : []
    }
    if (property === 'listExpiredRuns') return async () => []
    if (property === 'createRun') return (tenantId: string, value: AnalysisRunV1, event: { runId: string }) => {
      run(tenantId, value.id)
      if (event.runId !== scope.runId || canonicalizeJson(value.request) !== canonicalizeJson(scope.request)) fail()
      return target.createRun(tenantId, value, event as Parameters<JobStore['createRun']>[2])
    }
    if (property === 'lookupRunByRequestKey' || property === 'abandonRequest') return (...args: unknown[]) => {
      tenant(args[0]); if (args[1] !== scope.request.requestKey) fail()
      return Reflect.apply(Reflect.get(target, property) as (...values: unknown[]) => unknown, target, args)
    }
    if (property === 'getCachedEvidenceCard') return (...args: unknown[]) => {
      tenant(args[0]); return Reflect.apply(target.getCachedEvidenceCard, target, args)
    }
    if (property === 'reserveProviderInvocation') return (value: ReserveProviderInvocationInput) => {
      input(value)
      return target.reserveProviderInvocation({ ...value,
        maxRunEstimatedTokens: Math.min(value.maxRunEstimatedTokens, budget.maxEstimatedTokens),
        maxRunEstimatedCostMicros: Math.min(value.maxRunEstimatedCostMicros, budget.maxEstimatedCostMicros) })
    }
    if (property === 'getProviderInvocation') return async (tenantId: string, invocationId: string) => {
      tenant(tenantId)
      const invocation = await target.getProviderInvocation(tenantId, invocationId)
      if (invocation && invocation.runId !== scope.runId) fail()
      return invocation
    }
    if (property === 'completeProviderInvocation') return async (value: CompleteProviderInvocationInput) => {
      tenant(value.tenantId)
      const invocation = await target.getProviderInvocation(value.tenantId, value.invocationId)
      if (invocation && invocation.runId !== scope.runId) fail()
      return target.completeProviderInvocation(value)
    }
    if (typeof property === 'string' && (tenantRunMethods.has(property) || inputMethods.has(property))) return (...args: unknown[]) => {
      if (tenantRunMethods.has(property)) run(args[0], args[1]); else input(args[0])
      return Reflect.apply(Reflect.get(target, property) as (...values: unknown[]) => unknown, target, args)
    }
    // In particular: no close(), global expiry cleanup, or future mutation may escape.
    return fail()
  } })
}
