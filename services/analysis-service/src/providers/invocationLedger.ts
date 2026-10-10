import { MODEL_TASK_ROLES, type ModelTaskRole } from './modelProvider.js'
import { PROVIDER_FAILURE_KINDS, type ProviderFailureKind } from './providerError.js'

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const SAFE_MODEL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u
const SAFE_CODE = /^[a-zA-Z0-9_.-]{1,80}$/u

export const PROVIDER_INVOCATION_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'outcome_unknown',
] as const

export type ProviderInvocationStatus = (typeof PROVIDER_INVOCATION_STATUSES)[number]

export interface ProviderInvocationIdentity {
  readonly tenantId: string
  readonly runId: string
  readonly invocationId: string
  readonly nodeKey: string
  readonly runAttempt: number
  readonly role: ModelTaskRole
  readonly providerId: string
  readonly modelId: string
  readonly profileVersion: string
  readonly promptVersion: string
}

export interface StoredProviderInvocation extends ProviderInvocationIdentity {
  readonly status: ProviderInvocationStatus
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly estimatedCostMicros: number
  readonly transportAttempts: number
  readonly actualInputTokens?: number
  readonly actualOutputTokens?: number
  readonly providerRequestId?: string
  readonly failureKind?: ProviderFailureKind
  readonly safeCode?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

export interface ReserveProviderInvocationInput extends ProviderInvocationIdentity {
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly estimatedCostMicros: number
  readonly maxRunEstimatedTokens: number
  readonly maxRunEstimatedCostMicros: number
  readonly staleAfterMs: number
  readonly now: number
}

export type ReserveProviderInvocationResult =
  | Readonly<{ outcome: 'reserved'; invocation: StoredProviderInvocation }>
  | Readonly<{ outcome: 'existing'; invocation: StoredProviderInvocation }>
  | Readonly<{
      outcome: 'budget_exceeded'
      dimension: 'tokens' | 'cost'
      actual: number
      maximum: number
    }>

interface CompleteProviderInvocationInputBase {
  readonly tenantId: string
  readonly invocationId: string
  readonly transportAttempts: number
  readonly now: number
}

export type CompleteProviderInvocationInput = CompleteProviderInvocationInputBase & (
  | Readonly<{
      result: 'succeeded'
      actualInputTokens: number
      actualOutputTokens: number
      providerRequestId?: string
    }>
  | Readonly<{
      result: 'failed'
      failureKind?: ProviderFailureKind
      safeCode: string
      actualInputTokens?: number
      actualOutputTokens?: number
      providerRequestId?: string
    }>
)

export type CompleteProviderInvocationResult =
  | Readonly<{ outcome: 'updated'; invocation: StoredProviderInvocation }>
  | Readonly<{ outcome: 'missing' }>
  | Readonly<{ outcome: 'state_conflict'; invocation: StoredProviderInvocation }>

export interface ProviderInvocationLedger {
  reserveProviderInvocation(input: ReserveProviderInvocationInput): Promise<ReserveProviderInvocationResult>
  completeProviderInvocation(input: CompleteProviderInvocationInput): Promise<CompleteProviderInvocationResult>
  getProviderInvocation(tenantId: string, invocationId: string): Promise<StoredProviderInvocation | undefined>
}

export const providerInvocationIdentityMatches = (
  invocation: ProviderInvocationIdentity,
  identity: ProviderInvocationIdentity,
): boolean => invocation.tenantId === identity.tenantId
  && invocation.runId === identity.runId
  && invocation.invocationId === identity.invocationId
  && invocation.nodeKey === identity.nodeKey
  && invocation.runAttempt === identity.runAttempt
  && invocation.role === identity.role
  && invocation.providerId === identity.providerId
  && invocation.modelId === identity.modelId
  && invocation.profileVersion === identity.profileVersion
  && invocation.promptVersion === identity.promptVersion

export const cloneProviderInvocation = (
  invocation: StoredProviderInvocation,
): StoredProviderInvocation => Object.freeze({ ...invocation })

const assertNonNegativeSafeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

const assertPositiveSafeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

const assertIdentity = (identity: ProviderInvocationIdentity): void => {
  for (const [label, value] of [
    ['tenantId', identity.tenantId],
    ['runId', identity.runId],
    ['invocationId', identity.invocationId],
    ['nodeKey', identity.nodeKey],
    ['providerId', identity.providerId],
    ['profileVersion', identity.profileVersion],
    ['promptVersion', identity.promptVersion],
  ] as const) {
    if (!SAFE_IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`)
  }
  if (!SAFE_MODEL_IDENTIFIER.test(identity.modelId)) throw new TypeError('modelId is invalid')
  assertNonNegativeSafeInteger(identity.runAttempt, 'runAttempt')
  if (!MODEL_TASK_ROLES.includes(identity.role)) throw new TypeError('role is invalid')
}

export const assertProviderInvocationReservation = (input: ReserveProviderInvocationInput): void => {
  assertIdentity(input)
  assertNonNegativeSafeInteger(input.estimatedInputTokens, 'estimatedInputTokens')
  assertPositiveSafeInteger(input.reservedOutputTokens, 'reservedOutputTokens')
  assertNonNegativeSafeInteger(input.estimatedCostMicros, 'estimatedCostMicros')
  assertPositiveSafeInteger(input.maxRunEstimatedTokens, 'maxRunEstimatedTokens')
  assertNonNegativeSafeInteger(input.maxRunEstimatedCostMicros, 'maxRunEstimatedCostMicros')
  assertPositiveSafeInteger(input.staleAfterMs, 'staleAfterMs')
  assertNonNegativeSafeInteger(input.now, 'now')
}

export const assertProviderInvocationCompletion = (input: CompleteProviderInvocationInput): void => {
  if (!SAFE_IDENTIFIER.test(input.tenantId)) throw new TypeError('tenantId is invalid')
  if (!SAFE_IDENTIFIER.test(input.invocationId)) throw new TypeError('invocationId is invalid')
  assertNonNegativeSafeInteger(input.transportAttempts, 'transportAttempts')
  assertNonNegativeSafeInteger(input.now, 'now')
  if (input.result === 'succeeded') {
    assertNonNegativeSafeInteger(input.actualInputTokens, 'actualInputTokens')
    assertNonNegativeSafeInteger(input.actualOutputTokens, 'actualOutputTokens')
    if (input.providerRequestId !== undefined && (
      input.providerRequestId.length > 256
      || !/^[\x21-\x7e]+$/u.test(input.providerRequestId)
    )) throw new TypeError('providerRequestId is invalid')
    return
  }
  if (!SAFE_CODE.test(input.safeCode)) throw new TypeError('safeCode is invalid')
  if (input.failureKind !== undefined && !PROVIDER_FAILURE_KINDS.includes(input.failureKind)) {
    throw new TypeError('failureKind is invalid')
  }
  if (input.actualInputTokens !== undefined) {
    assertNonNegativeSafeInteger(input.actualInputTokens, 'actualInputTokens')
  }
  if (input.actualOutputTokens !== undefined) {
    assertNonNegativeSafeInteger(input.actualOutputTokens, 'actualOutputTokens')
  }
  if (input.providerRequestId !== undefined && (
    input.providerRequestId.length > 256
    || !/^[\x21-\x7e]+$/u.test(input.providerRequestId)
  )) throw new TypeError('providerRequestId is invalid')
}
