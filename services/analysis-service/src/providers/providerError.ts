export const PROVIDER_FAILURE_KINDS = [
  'aborted',
  'timeout',
  'rate_limited',
  'unavailable',
  'rejected',
  'invalid_response',
  'response_too_large',
] as const

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]

export interface ProviderFailureOptions {
  readonly providerId: string
  readonly kind: ProviderFailureKind
  readonly retryable: boolean
  readonly safeCode: string
  readonly statusCode?: number
  readonly retryAfterMs?: number
}

export class ProviderGatewayError extends Error {
  readonly providerId: string
  readonly kind: ProviderFailureKind
  readonly retryable: boolean
  readonly safeCode: string
  readonly statusCode?: number
  readonly retryAfterMs?: number

  constructor(options: ProviderFailureOptions) {
    super(`provider request failed: ${options.kind}`)
    this.name = 'ProviderGatewayError'
    this.providerId = options.providerId
    this.kind = options.kind
    this.retryable = options.retryable
    this.safeCode = options.safeCode
    this.statusCode = options.statusCode
    this.retryAfterMs = options.retryAfterMs
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
    return new ProviderGatewayError({ ...common, kind: 'rejected', retryable: false })
  }
  if (input.statusCode === 429) {
    return new ProviderGatewayError({ ...common, kind: 'rate_limited', retryable: true })
  }
  if (input.statusCode === 408 || input.statusCode === 504) {
    return new ProviderGatewayError({ ...common, kind: 'timeout', retryable: true })
  }
  if (input.statusCode >= 500) {
    return new ProviderGatewayError({ ...common, kind: 'unavailable', retryable: true })
  }
  return new ProviderGatewayError({ ...common, kind: 'rejected', retryable: false })
}
