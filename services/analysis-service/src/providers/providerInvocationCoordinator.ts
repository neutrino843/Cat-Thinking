import type { ProviderInvocationLedger, StoredProviderInvocation } from './invocationLedger.js'
import type { ModelRequest, ModelResponse } from './modelProvider.js'
import { ProviderGatewayError, type ProviderFailureKind } from './providerError.js'
import {
  ProviderRouter,
  type ModelRouteProfile,
  type ProviderRouteSelection,
} from './providerRouter.js'

const RETRYABLE_FAILURE_KINDS = ['rate_limited', 'unavailable'] as const

export interface ProviderInvocationPolicy {
  readonly maxAttempts: number
  readonly retryBaseDelayMs: number
  readonly retryMaxDelayMs: number
  readonly circuitFailureThreshold: number
  readonly circuitOpenMs: number
  readonly staleAfterMs: number
  readonly maxRunEstimatedTokens: number
  readonly maxRunEstimatedCostMicros: number
}

export const DEFAULT_PROVIDER_INVOCATION_POLICY: ProviderInvocationPolicy = Object.freeze({
  maxAttempts: 2,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 5_000,
  circuitFailureThreshold: 5,
  circuitOpenMs: 30_000,
  staleAfterMs: 10 * 60_000,
  maxRunEstimatedTokens: 4_000_000,
  maxRunEstimatedCostMicros: 50_000_000,
})

export interface ProviderCostEstimateInput {
  readonly providerId: string
  readonly modelId: string
  readonly profile: ModelRouteProfile
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
}

export interface ProviderInvocationInput {
  readonly tenantId: string
  readonly runId: string
  readonly nodeKey: string
  readonly runAttempt: number
  readonly request: ModelRequest
}

export interface ProviderInvocationResult {
  readonly response: ModelResponse
  readonly invocation: StoredProviderInvocation
  readonly route: Readonly<{
    providerId: string
    modelId: string
    profileVersion: string
    promptVersion: string
  }>
}

export type ProviderInvocationCoordinatorErrorKind =
  | 'budget_exceeded'
  | 'circuit_open'
  | 'in_progress'
  | 'outcome_unknown'
  | 'already_succeeded'
  | 'already_failed'
  | 'ledger_conflict'

export class ProviderInvocationCoordinatorError extends Error {
  constructor(
    readonly kind: ProviderInvocationCoordinatorErrorKind,
    readonly retryable: boolean,
    readonly safeCode: string,
    readonly details?: Readonly<{
      dimension?: 'tokens' | 'cost'
      actual?: number
      maximum?: number
      providerId?: string
    }>,
  ) {
    super(`provider invocation coordination failed: ${kind}`)
    this.name = 'ProviderInvocationCoordinatorError'
  }
}

interface CircuitState {
  consecutiveFailures: number
  openUntil: number
  probeInFlight: boolean
}

interface CircuitPermit {
  readonly providerId: string
  readonly probe: boolean
}

export interface ProviderInvocationCoordinatorOptions {
  readonly router: ProviderRouter
  readonly ledger: ProviderInvocationLedger
  readonly estimateCostMicros: (input: ProviderCostEstimateInput) => number
  readonly policy?: ProviderInvocationPolicy
  readonly now?: () => number
  readonly random?: () => number
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const positiveInteger = (value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer not greater than ${maximum}`)
  }
}

const nonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

const defaultDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new ProviderGatewayError({
      providerId: 'coordinator',
      kind: 'aborted',
      retryable: false,
      safeCode: 'caller_aborted',
    }))
    return
  }
  const abort = () => {
    clearTimeout(timer)
    reject(new ProviderGatewayError({
      providerId: 'coordinator',
      kind: 'aborted',
      retryable: false,
      safeCode: 'caller_aborted',
    }))
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort)
    resolve()
  }, milliseconds)
  timer.unref()
  signal.addEventListener('abort', abort, { once: true })
})

const requestInputTokenUpperBound = (request: ModelRequest): number => {
  let schema: string
  try {
    schema = JSON.stringify(request.output.schema)
  } catch {
    throw new TypeError('structured output schema must be JSON serializable')
  }
  return new TextEncoder().encode(`${request.systemPrompt}\n${request.userPrompt}\n${schema}`).byteLength
}

export class ProviderInvocationCoordinator {
  private readonly router: ProviderRouter
  private readonly ledger: ProviderInvocationLedger
  private readonly estimateCostMicros: (input: ProviderCostEstimateInput) => number
  private readonly policy: ProviderInvocationPolicy
  private readonly now: () => number
  private readonly random: () => number
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly circuits = new Map<string, CircuitState>()

  constructor(options: ProviderInvocationCoordinatorOptions) {
    const policy = options.policy ?? DEFAULT_PROVIDER_INVOCATION_POLICY
    positiveInteger(policy.maxAttempts, 'maxAttempts', 5)
    positiveInteger(policy.retryBaseDelayMs, 'retryBaseDelayMs', 60_000)
    positiveInteger(policy.retryMaxDelayMs, 'retryMaxDelayMs', 60_000)
    if (policy.retryBaseDelayMs > policy.retryMaxDelayMs) {
      throw new RangeError('retryBaseDelayMs must not exceed retryMaxDelayMs')
    }
    positiveInteger(policy.circuitFailureThreshold, 'circuitFailureThreshold', 100)
    positiveInteger(policy.circuitOpenMs, 'circuitOpenMs', 3_600_000)
    positiveInteger(policy.staleAfterMs, 'staleAfterMs', 86_400_000)
    positiveInteger(policy.maxRunEstimatedTokens, 'maxRunEstimatedTokens')
    nonNegativeInteger(policy.maxRunEstimatedCostMicros, 'maxRunEstimatedCostMicros')
    this.router = options.router
    this.ledger = options.ledger
    this.estimateCostMicros = options.estimateCostMicros
    this.policy = Object.freeze({ ...policy })
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.delay = options.delay ?? defaultDelay
  }

  async generate(input: ProviderInvocationInput, signal: AbortSignal): Promise<ProviderInvocationResult> {
    const selection = this.router.route(input.request.role, input.request.qualityProfile)
    this.validateRequestAgainstRoute(input.request, selection)
    if (signal.aborted) throw this.aborted(selection.provider.id)
    const permit = this.acquireCircuitPermit(selection.provider.id)
    let callStarted = false
    try {
      const estimatedInputTokens = requestInputTokenUpperBound(input.request)
      const estimatedCostMicros = this.estimateCostMicros({
        providerId: selection.provider.id,
        modelId: selection.provider.modelId,
        profile: selection.profile,
        estimatedInputTokens,
        reservedOutputTokens: input.request.maxOutputTokens,
      })
      nonNegativeInteger(estimatedCostMicros, 'estimatedCostMicros')
      const reserved = await this.ledger.reserveProviderInvocation({
        tenantId: input.tenantId,
        runId: input.runId,
        invocationId: input.request.invocationId,
        nodeKey: input.nodeKey,
        runAttempt: input.runAttempt,
        role: input.request.role,
        providerId: selection.provider.id,
        modelId: selection.provider.modelId,
        profileVersion: selection.provider.profileVersion,
        promptVersion: selection.profile.promptVersion,
        estimatedInputTokens,
        reservedOutputTokens: input.request.maxOutputTokens,
        estimatedCostMicros,
        maxRunEstimatedTokens: this.policy.maxRunEstimatedTokens,
        maxRunEstimatedCostMicros: this.policy.maxRunEstimatedCostMicros,
        staleAfterMs: this.policy.staleAfterMs,
        now: this.now(),
      })
      if (reserved.outcome === 'budget_exceeded') {
        throw new ProviderInvocationCoordinatorError(
          'budget_exceeded',
          false,
          `run_${reserved.dimension}_budget_exceeded`,
          {
            dimension: reserved.dimension,
            actual: reserved.actual,
            maximum: reserved.maximum,
            providerId: selection.provider.id,
          },
        )
      }
      if (reserved.outcome === 'existing') throw this.existingInvocationError(reserved.invocation)
      if (signal.aborted) {
        await this.completeFailure(input, 0, this.aborted(selection.provider.id))
        throw this.aborted(selection.provider.id)
      }
      callStarted = true
      return await this.invokeReserved(input, selection, permit, signal)
    } finally {
      if (!callStarted) this.releaseUnusedCircuitPermit(permit)
    }
  }

  private async invokeReserved(
    input: ProviderInvocationInput,
    selection: ProviderRouteSelection,
    permit: CircuitPermit,
    signal: AbortSignal,
  ): Promise<ProviderInvocationResult> {
    let attempts = 0
    while (attempts < this.policy.maxAttempts) {
      attempts += 1
      try {
        const response = await selection.provider.generate(input.request, signal)
        if (response.usage.outputTokens > input.request.maxOutputTokens) {
          const error = new ProviderGatewayError({
            providerId: selection.provider.id,
            kind: 'invalid_response',
            retryable: false,
            safeCode: 'reported_output_tokens_exceeded',
          })
          await this.completeFailure(input, attempts, error, response)
          this.recordCircuitSuccess(permit)
          throw error
        }
        this.recordCircuitSuccess(permit)
        const completed = await this.ledger.completeProviderInvocation({
          tenantId: input.tenantId,
          invocationId: input.request.invocationId,
          transportAttempts: attempts,
          now: this.now(),
          result: 'succeeded',
          actualInputTokens: response.usage.inputTokens,
          actualOutputTokens: response.usage.outputTokens,
          providerRequestId: response.providerRequestId,
        })
        if (completed.outcome !== 'updated') throw this.ledgerConflict(selection.provider.id)
        return {
          response,
          invocation: completed.invocation,
          route: Object.freeze({
            providerId: selection.provider.id,
            modelId: selection.provider.modelId,
            profileVersion: selection.provider.profileVersion,
            promptVersion: selection.profile.promptVersion,
          }),
        }
      } catch (error) {
        if (
          error instanceof ProviderGatewayError
          && error.kind === 'invalid_response'
          && error.safeCode === 'reported_output_tokens_exceeded'
        ) throw error
        const circuitOpened = this.recordCircuitFailure(permit, error)
        if (!this.shouldRetry(error, attempts) || circuitOpened) {
          await this.completeFailure(input, attempts, error)
          throw error
        }
        try {
          await this.delay(this.retryDelay(error, attempts), signal)
        } catch (delayError) {
          await this.completeFailure(input, attempts, delayError)
          throw delayError
        }
      }
    }
    throw new Error('provider invocation retry loop exhausted unexpectedly')
  }

  private async completeFailure(
    input: ProviderInvocationInput,
    attempts: number,
    error: unknown,
    response?: ModelResponse,
  ): Promise<void> {
    const providerError = error instanceof ProviderGatewayError ? error : undefined
    const completed = await this.ledger.completeProviderInvocation({
      tenantId: input.tenantId,
      invocationId: input.request.invocationId,
      transportAttempts: attempts,
      now: this.now(),
      result: 'failed',
      failureKind: providerError?.kind,
      safeCode: providerError?.safeCode ?? 'unexpected_error',
      actualInputTokens: response?.usage.inputTokens,
      actualOutputTokens: response?.usage.outputTokens,
      providerRequestId: response?.providerRequestId,
    })
    if (completed.outcome !== 'updated') {
      throw this.ledgerConflict(providerError?.providerId)
    }
  }

  private validateRequestAgainstRoute(request: ModelRequest, selection: ProviderRouteSelection): void {
    if (request.systemPrompt.trim().length === 0 || request.userPrompt.trim().length === 0) {
      throw new TypeError('provider prompts must not be empty')
    }
    if (request.systemPrompt.length + request.userPrompt.length > selection.provider.capabilities.maxInputCharacters) {
      throw new RangeError('provider input exceeds routed provider character limit')
    }
    positiveInteger(request.maxOutputTokens, 'maxOutputTokens', selection.provider.capabilities.maxOutputTokens)
  }

  private existingInvocationError(invocation: StoredProviderInvocation): ProviderInvocationCoordinatorError {
    switch (invocation.status) {
      case 'running':
        return new ProviderInvocationCoordinatorError('in_progress', true, 'invocation_in_progress')
      case 'outcome_unknown':
        return new ProviderInvocationCoordinatorError('outcome_unknown', false, 'invocation_outcome_unknown')
      case 'succeeded':
        return new ProviderInvocationCoordinatorError('already_succeeded', false, 'invocation_already_succeeded')
      case 'failed':
        return new ProviderInvocationCoordinatorError('already_failed', false, 'invocation_already_failed')
    }
  }

  private shouldRetry(error: unknown, attempts: number): error is ProviderGatewayError {
    return attempts < this.policy.maxAttempts
      && error instanceof ProviderGatewayError
      && error.retryable
      && RETRYABLE_FAILURE_KINDS.includes(error.kind as (typeof RETRYABLE_FAILURE_KINDS)[number])
  }

  private retryDelay(error: ProviderGatewayError, attempts: number): number {
    const exponential = Math.min(
      this.policy.retryMaxDelayMs,
      this.policy.retryBaseDelayMs * (2 ** Math.max(0, attempts - 1)),
    )
    const random = Math.min(1, Math.max(0, this.random()))
    const jittered = Math.ceil(exponential * (0.75 + random * 0.5))
    return Math.min(this.policy.retryMaxDelayMs, Math.max(jittered, error.retryAfterMs ?? 0))
  }

  private acquireCircuitPermit(providerId: string): CircuitPermit {
    const state = this.circuits.get(providerId)
    if (!state) return { providerId, probe: false }
    const now = this.now()
    if (state.openUntil > now) {
      throw new ProviderInvocationCoordinatorError(
        'circuit_open',
        true,
        'provider_circuit_open',
        { providerId },
      )
    }
    if (state.openUntil !== 0) {
      if (state.probeInFlight) {
        throw new ProviderInvocationCoordinatorError(
          'circuit_open',
          true,
          'provider_circuit_probe_in_progress',
          { providerId },
        )
      }
      state.probeInFlight = true
      return { providerId, probe: true }
    }
    return { providerId, probe: false }
  }

  private releaseUnusedCircuitPermit(permit: CircuitPermit): void {
    if (!permit.probe) return
    const state = this.circuits.get(permit.providerId)
    if (state) state.probeInFlight = false
  }

  private recordCircuitSuccess(permit: CircuitPermit): void {
    this.circuits.set(permit.providerId, {
      consecutiveFailures: 0,
      openUntil: 0,
      probeInFlight: false,
    })
  }

  private recordCircuitFailure(permit: CircuitPermit, error: unknown): boolean {
    if (!(error instanceof ProviderGatewayError) || !this.isCircuitFailure(error.kind)) {
      if (permit.probe) this.releaseUnusedCircuitPermit(permit)
      return false
    }
    const current = this.circuits.get(permit.providerId) ?? {
      consecutiveFailures: 0,
      openUntil: 0,
      probeInFlight: false,
    }
    current.consecutiveFailures += 1
    current.probeInFlight = false
    const shouldOpen = permit.probe || current.consecutiveFailures >= this.policy.circuitFailureThreshold
    if (shouldOpen) current.openUntil = this.now() + this.policy.circuitOpenMs
    this.circuits.set(permit.providerId, current)
    return shouldOpen
  }

  private isCircuitFailure(kind: ProviderFailureKind): boolean {
    return kind === 'timeout' || kind === 'rate_limited' || kind === 'unavailable'
  }

  private ledgerConflict(providerId?: string): ProviderInvocationCoordinatorError {
    return new ProviderInvocationCoordinatorError(
      'ledger_conflict',
      false,
      'invocation_ledger_conflict',
      providerId ? { providerId } : undefined,
    )
  }

  private aborted(providerId: string): ProviderGatewayError {
    return new ProviderGatewayError({
      providerId,
      kind: 'aborted',
      retryable: false,
      safeCode: 'caller_aborted',
    })
  }
}
