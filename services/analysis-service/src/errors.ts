import {
  ANALYSIS_CONTRACT_VERSION,
  analysisErrorResponseSchema,
  analysisErrorSchema,
  type AnalysisErrorResponseV1,
  type AnalysisErrorV1,
} from '@cat-thinking/analysis-contracts'

export class ServiceHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly contractError: AnalysisErrorV1,
  ) {
    super(contractError.messageKey)
    this.name = 'ServiceHttpError'
  }
}

export const createContractError = (
  code: AnalysisErrorV1['code'],
  category: AnalysisErrorV1['category'],
  retryable: boolean,
  messageKey: string,
  details?: AnalysisErrorV1['details'],
): AnalysisErrorV1 => analysisErrorSchema.parse({
  version: ANALYSIS_CONTRACT_VERSION,
  code,
  category,
  retryable,
  messageKey,
  details,
})

export const createErrorResponse = (
  traceId: string,
  error: AnalysisErrorV1,
): AnalysisErrorResponseV1 => analysisErrorResponseSchema.parse({
  version: ANALYSIS_CONTRACT_VERSION,
  traceId,
  error,
})

export const serviceUnavailableError = (): ServiceHttpError => new ServiceHttpError(
  503,
  createContractError(
    'service_unavailable',
    'availability',
    true,
    'analysis.service.not_ready',
  ),
)
