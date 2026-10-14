export const PROVIDER_FAILURE_KINDS = [
  'aborted',
  'timeout',
  'rate_limited',
  'unavailable',
  'rejected',
  'invalid_response',
  'response_too_large',
  'outcome_unknown',
] as const

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]
export type ProviderAcceptance = 'not_accepted' | 'accepted' | 'unknown'

export interface ProviderFailureOptions {
  readonly providerId: string
  readonly kind: ProviderFailureKind
  readonly retryable: boolean
  readonly safeCode: string
  readonly statusCode?: number
  readonly retryAfterMs?: number
  /** Retry is safe only when the adapter can prove that no generation was accepted. */
  readonly acceptance?: ProviderAcceptance
  readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>
  readonly providerRequestId?: string
}

export class ProviderGatewayError extends Error {
  readonly providerId: string
  readonly kind: ProviderFailureKind
  readonly retryable: boolean
  readonly safeCode: string
  readonly statusCode?: number
  readonly retryAfterMs?: number
  readonly acceptance: ProviderAcceptance
  readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>
  readonly providerRequestId?: string

  constructor(options: ProviderFailureOptions) {
    super(`provider request failed: ${options.kind}`)
    this.name = 'ProviderGatewayError'
    this.providerId = options.providerId
    this.kind = options.kind
    this.retryable = options.retryable
    this.safeCode = options.safeCode
    this.statusCode = options.statusCode
    this.retryAfterMs = options.retryAfterMs
    this.acceptance = options.acceptance ?? (
      ['invalid_response', 'response_too_large'].includes(options.kind) ? 'accepted' : 'unknown'
    )
    this.usage = options.usage
    this.providerRequestId = options.providerRequestId
  }
}

const NON_RETRYABLE_QUOTA_CODES = new Set([
  'billing_hard_limit_reached',
  'credit_balance_exhausted',
  'insufficient_quota',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
])

const safeProviderCode = (value: unknown): string => typeof value === 'string'
  && /^[a-zA-Z0-9_.-]{1,80}$/u.test(value)
  ? value
  : 'unknown'

export const retryAfterMilliseconds = (
  value: string | null,
  now: number = Date.now(),
): number | undefined => {
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1_000)
    : Date.parse(value) - now
  if (!Number.isFinite(delay) || delay < 0) return undefined
  return Math.min(delay, 3_600_000)
}

export const classifyProviderHttpError = (input: Readonly<{
  providerId: string
  statusCode: number
  providerCode?: unknown
  retryAfter?: string | null
  now?: number
}>): ProviderGatewayError => {
  const safeCode = safeProviderCode(input.providerCode)
  const common = {
    providerId: input.providerId,
    safeCode,
    statusCode: input.statusCode,
    retryAfterMs: retryAfterMilliseconds(input.retryAfter ?? null, input.now),
  }
  if (input.statusCode === 429 && NON_RETRYABLE_QUOTA_CODES.has(safeCode)) {
    return new ProviderGatewayError({ ...common, kind: 'rejected', retryable: false, acceptance: 'not_accepted' })
  }
  if (input.statusCode === 429) {
    return new ProviderGatewayError({ ...common, kind: 'rate_limited', retryable: true, acceptance: 'not_accepted' })
  }
  if (input.statusCode === 408 || input.statusCode === 504) {
    return new ProviderGatewayError({ ...common, kind: 'outcome_unknown', retryable: false })
  }
  if (input.statusCode >= 500) {
    return new ProviderGatewayError({ ...common, kind: 'outcome_unknown', retryable: false })
  }
  return new ProviderGatewayError({ ...common, kind: 'rejected', retryable: false, acceptance: 'not_accepted' })
}
