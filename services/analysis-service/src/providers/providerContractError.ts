import type { AnalysisErrorV1, AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { createContractError } from '../errors.js'
import { ProviderGatewayError } from './providerError.js'
import { ProviderInvocationCoordinatorError } from './providerInvocationCoordinator.js'

const withStage = (
  error: AnalysisErrorV1,
  stage: AnalysisRunV1['stage'],
): AnalysisErrorV1 => stage === undefined ? error : { ...error, stage }

export const providerContractError = (
  error: unknown,
  stage?: AnalysisRunV1['stage'],
): AnalysisErrorV1 | undefined => {
  if (error instanceof ProviderGatewayError) {
    const details = {
      providerId: error.providerId,
      providerCode: error.safeCode,
    }
    switch (error.kind) {
      case 'aborted':
        return withStage(createContractError(
          'cancelled',
          'cancellation',
          false,
          'analysis.provider.cancelled',
          details,
        ), stage)
      case 'timeout':
        return withStage(createContractError(
          'provider_timeout',
          'provider',
          true,
          'analysis.provider.timeout',
          details,
        ), stage)
      case 'rate_limited':
        return withStage(createContractError(
          'rate_limited',
          'rate-limit',
          true,
          'analysis.provider.rate_limited',
          details,
        ), stage)
      case 'unavailable':
        return withStage(createContractError(
          'provider_unavailable',
          'availability',
          true,
          'analysis.provider.unavailable',
          details,
        ), stage)
      case 'rejected':
      case 'invalid_response':
      case 'response_too_large':
        return withStage(createContractError(
          'provider_rejected',
          'provider',
          false,
          'analysis.provider.rejected',
          details,
        ), stage)
    }
  }
  if (!(error instanceof ProviderInvocationCoordinatorError)) return undefined
  if (error.kind === 'budget_exceeded') {
    return withStage(createContractError(
      'budget_exceeded',
      'budget',
      false,
      'analysis.provider.budget_exceeded',
      {
        dimension: error.details?.dimension ?? 'unknown',
        actual: error.details?.actual ?? 0,
        maximum: error.details?.maximum ?? 0,
      },
    ), stage)
  }
  const retryable = error.kind === 'circuit_open' || error.kind === 'in_progress'
  return withStage(createContractError(
    'provider_unavailable',
    'availability',
    retryable,
    'analysis.provider.invocation_unavailable',
    {
      reason: error.safeCode,
      ...(error.details?.providerId ? { providerId: error.details.providerId } : {}),
    },
  ), stage)
}
