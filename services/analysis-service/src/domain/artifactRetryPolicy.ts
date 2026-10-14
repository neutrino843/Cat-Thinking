import { canonicalizeJson, type AnalysisRunV1, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import { ServiceHttpError, createContractError } from '../errors.js'
import type { RetryTransitionContext } from './jobStore.js'
import { planArtifactBudget } from './artifactBudget.js'

function reject(reason: string, statusCode = 409): never {
  throw new ServiceHttpError(statusCode, createContractError('conflict', 'conflict', false, `analysis.artifact.${reason}`))
}

export function assertArtifactRetryAllowed(
  run: AnalysisRunV1,
  kind: ArtifactKind,
  context: RetryTransitionContext,
  now: number,
  limits: { maxRunEstimatedTokens: number; maxRunEstimatedCostMicros: number },
): void {
  if (context.contentDeleted || run.status === 'expired' || (run.expiresAt ?? Infinity) <= now) reject('content_unavailable', 410)
  if (run.status === 'cancelled') reject('run_cancelled')
  const state = run.artifactStates[kind]
  if (!state) reject('not_requested')
  if (state.status !== 'failed') reject('not_retryable')
  if (state.error?.details?.reason === 'invocation_outcome_unknown') reject('invocation_outcome_unknown')
  if (context.invocations.some((entry) => entry.nodeKey.startsWith(`artifact:${kind}`)
    && (entry.status === 'running' || entry.status === 'outcome_unknown'))) reject('invocation_outcome_unknown')
  if (!context.sourceSnapshotReady || !context.graph || context.graph.runId !== run.id) reject('source_unavailable')
  const expectedHashes = run.request.manifest.sources.map((source) => source.contentHash).sort()
  const graphHashes = context.graph.sourceContentHashes.slice().sort()
  if (canonicalizeJson(expectedHashes) !== canonicalizeJson(graphHashes)) reject('evidence_identity_changed')
  if (kind === 'mindmap') {
    const outline = context.outline
    if (run.artifactStates.outline?.status !== 'succeeded' || !outline || outline.artifact.kind !== 'outline'
      || outline.artifact.id !== run.artifactStates.outline.artifactId || outline.artifact.runId !== run.id
      || outline.artifact.docId !== run.docId
      || canonicalizeJson(outline.artifact.sourceContentHashes.slice().sort()) !== canonicalizeJson(expectedHashes)) {
      reject('dependency_failed')
    }
  }
  // Dependency recovery is the sole exception to the original nonretryable error.
  if (!state.error?.retryable && !(kind === 'mindmap' && state.error?.code === 'dependency_failed')) reject('not_retryable')
  const reservedTokens = context.invocations.reduce((sum, row) => sum + row.estimatedInputTokens + row.reservedOutputTokens, 0)
  const reservedCost = context.invocations.reduce((sum, row) => sum + row.estimatedCostMicros, 0)
  const minimumTokens = reservedTokens + planArtifactBudget(kind, run.request.options).maxOutputTokens
  // Personal mode does not invent prices: zero estimates and a zero cap are a
  // placeholder. Any priced history keeps the original cost admission rule;
  // every subsequent invocation still reserves its budget atomically in store.
  const zeroCostPlaceholder = limits.maxRunEstimatedCostMicros === 0
    && context.invocations.every((row) => row.estimatedCostMicros === 0)
  if (minimumTokens > limits.maxRunEstimatedTokens
    || !zeroCostPlaceholder && reservedCost >= limits.maxRunEstimatedCostMicros) {
    throw new ServiceHttpError(409, createContractError('budget_exceeded', 'budget', false,
      'analysis.artifact.budget_exhausted', { minimumTokens, maximumTokens: limits.maxRunEstimatedTokens,
        reservedCostMicros: reservedCost, maximumCostMicros: limits.maxRunEstimatedCostMicros }))
  }
}
