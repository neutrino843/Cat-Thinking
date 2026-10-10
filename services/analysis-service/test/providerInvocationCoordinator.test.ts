import { createHash } from 'node:crypto'
import { analysisRequestSchema, type AnalysisRequestV1 } from '@cat-thinking/analysis-contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import {
  assertProviderInvocationCompletion,
  assertProviderInvocationReservation,
  type ReserveProviderInvocationInput,
} from '../src/providers/invocationLedger.js'
import { createStableInvocationId } from '../src/providers/invocationId.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/providers/modelProvider.js'
import { providerContractError } from '../src/providers/providerContractError.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import {
  ProviderInvocationCoordinator,
  ProviderInvocationCoordinatorError,
  type ProviderInvocationPolicy,
} from '../src/providers/providerInvocationCoordinator.js'
import { ProviderRouter } from '../src/providers/providerRouter.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const makeAnalysisRequest = (requestKey: string): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey,
  docId: 'doc-provider-invocation',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-provider-invocation',
      kind: 'text',
      extractor: 'provider-invocation-test@1',
      contentHash: hash('provider invocation content'),
      charCount: 27,
      byteCount: 27,
    }],
  },
  artifacts: ['summary'],
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount: 1,
    externalKnowledge: false,
  },
})

const makeModelRequest = (invocationId: string): ModelRequest => ({
  invocationId,
  role: 'evidence-map',
  qualityProfile: 'standard',
  systemPrompt: 'Return a compact evidence card.',
  userPrompt: 'Document excerpt without secrets.',
  output: {
    name: 'evidence_card',
    schema: { type: 'object', additionalProperties: false },
  },
  maxOutputTokens: 200,
})

class FakeProvider implements ModelProvider {
  readonly id = 'approved-provider'
  readonly modelId = 'approved/model-v1'
  readonly profileVersion = 'profile-v1'
  readonly capabilities = Object.freeze({
    apiStyle: 'responses' as const,
    structuredOutputs: true as const,
    reportsUsage: true as const,
    supportsAbort: true as const,
    maxInputCharacters: 100_000,
    maxOutputTokens: 10_000,
  })
  readonly generate = vi.fn<(request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse>>()

  isReady(): boolean {
    return true
  }
}

const policy = (overrides: Partial<ProviderInvocationPolicy> = {}): ProviderInvocationPolicy => ({
  maxAttempts: 2,
  retryBaseDelayMs: 10,
  retryMaxDelayMs: 100,
  circuitFailureThreshold: 5,
  circuitOpenMs: 1_000,
  staleAfterMs: 1_000,
  maxRunEstimatedTokens: 100_000,
  maxRunEstimatedCostMicros: 1_000_000,
  ...overrides,
})

describe('provider invocation coordinator', () => {
  let store: InMemoryJobStore
  let provider: FakeProvider
  let runId: string
  let now: number

  beforeEach(async () => {
    store = new InMemoryJobStore()
    provider = new FakeProvider()
    now = 10_000
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => now,
      createId: (() => { let id = 0; return () => `provider-run-${++id}` })(),
    })
    const created = await service.createRun('tenant-provider', makeAnalysisRequest(hash(`request-${now}`)))
    runId = created.run.id
  })

  const coordinator = (
    overrides: Partial<ProviderInvocationPolicy> = {},
    delay: (milliseconds: number, signal: AbortSignal) => Promise<void> = async () => undefined,
  ): ProviderInvocationCoordinator => new ProviderInvocationCoordinator({
    router: new ProviderRouter([provider], [{
      id: 'evidence-standard',
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptId: 'evidence-map',
      promptVersion: 'prompt-v1',
      roles: ['evidence-map'],
      qualityProfiles: ['standard'],
      priority: 0,
    }]),
    ledger: store,
    estimateCostMicros: ({ estimatedInputTokens, reservedOutputTokens }) =>
      estimatedInputTokens * 2 + reservedOutputTokens * 4,
    policy: policy(overrides),
    now: () => now,
    random: () => 0.5,
    delay,
  })

  const input = (invocationId: string, nodeKey = invocationId) => ({
    tenantId: 'tenant-provider',
    runId,
    nodeKey,
    runAttempt: 1,
    request: makeModelRequest(invocationId),
  })

  it('reserves budget before the call and persists only bounded invocation metadata on success', async () => {
    provider.generate.mockResolvedValue({
      outputText: '{"claims":[]}',
      usage: { inputTokens: 31, outputTokens: 12 },
      providerRequestId: 'provider-request-1',
    })

    const result = await coordinator().generate(input('invoke-success'), new AbortController().signal)

    expect(result.route).toEqual({
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptVersion: 'prompt-v1',
    })
    expect(result.invocation).toMatchObject({
      status: 'succeeded',
      transportAttempts: 1,
      actualInputTokens: 31,
      actualOutputTokens: 12,
      providerRequestId: 'provider-request-1',
    })
    expect(JSON.stringify(result.invocation)).not.toContain('Document excerpt')
    expect(provider.generate).toHaveBeenCalledTimes(1)
  })

  it('retries rate limiting once with bounded Retry-After and records the final attempt count', async () => {
    provider.generate
      .mockRejectedValueOnce(new ProviderGatewayError({
        providerId: provider.id,
        kind: 'rate_limited',
        retryable: true,
        safeCode: 'rate_limit',
        retryAfterMs: 5_000,
      }))
      .mockResolvedValueOnce({
        outputText: '{}',
        usage: { inputTokens: 20, outputTokens: 10 },
      })
    const delays: number[] = []

    const result = await coordinator({}, async (milliseconds) => { delays.push(milliseconds) })
      .generate(input('invoke-retry'), new AbortController().signal)

    expect(delays).toEqual([100])
    expect(provider.generate).toHaveBeenCalledTimes(2)
    expect(result.invocation.transportAttempts).toBe(2)
  })

  it('does not automatically retry a timeout because its billing outcome may be unknown', async () => {
    provider.generate.mockRejectedValue(new ProviderGatewayError({
      providerId: provider.id,
      kind: 'timeout',
      retryable: true,
      safeCode: 'request_timeout',
    }))

    await expect(coordinator().generate(input('invoke-timeout'), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'timeout' })
    expect(provider.generate).toHaveBeenCalledTimes(1)
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-timeout')).toMatchObject({
      status: 'failed',
      transportAttempts: 1,
      failureKind: 'timeout',
      safeCode: 'request_timeout',
    })
  })

  it('fails a run budget before any network call', async () => {
    await expect(coordinator({ maxRunEstimatedTokens: 1 }).generate(
      input('invoke-budget'),
      new AbortController().signal,
    )).rejects.toMatchObject({
      kind: 'budget_exceeded',
      retryable: false,
    })
    expect(provider.generate).not.toHaveBeenCalled()
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-budget')).toBeUndefined()
  })

  it('never re-sends an existing or stale invocation', async () => {
    await store.reserveProviderInvocation({
      tenantId: 'tenant-provider',
      runId,
      invocationId: 'invoke-stale',
      nodeKey: 'invoke-stale',
      runAttempt: 1,
      role: 'evidence-map',
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 100,
      reservedOutputTokens: 200,
      estimatedCostMicros: 1_000,
      maxRunEstimatedTokens: 100_000,
      maxRunEstimatedCostMicros: 1_000_000,
      staleAfterMs: 1_000,
      now,
    })

    await expect(coordinator().generate(input('invoke-stale'), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'in_progress' })
    now += 1_000
    await expect(coordinator().generate(input('invoke-stale'), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'outcome_unknown', retryable: false })
    expect(provider.generate).not.toHaveBeenCalled()
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-stale')).toMatchObject({
      status: 'outcome_unknown',
    })
  })

  it('opens the circuit after consecutive failures and permits one recovery probe', async () => {
    provider.generate.mockRejectedValue(new ProviderGatewayError({
      providerId: provider.id,
      kind: 'unavailable',
      retryable: true,
      safeCode: 'connection_failed',
    }))
    const guarded = coordinator({ maxAttempts: 1, circuitFailureThreshold: 2 })

    await expect(guarded.generate(input('invoke-circuit-1'), new AbortController().signal)).rejects.toThrow()
    await expect(guarded.generate(input('invoke-circuit-2'), new AbortController().signal)).rejects.toThrow()
    await expect(guarded.generate(input('invoke-circuit-3'), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'circuit_open' })
    expect(provider.generate).toHaveBeenCalledTimes(2)
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-circuit-3')).toBeUndefined()

    now += 1_000
    provider.generate.mockResolvedValueOnce({
      outputText: '{}',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    await expect(guarded.generate(input('invoke-circuit-probe'), new AbortController().signal))
      .resolves.toMatchObject({ invocation: { status: 'succeeded' } })
  })

  it('aborts retry waiting and records a bounded failure without a second provider call', async () => {
    provider.generate.mockRejectedValue(new ProviderGatewayError({
      providerId: provider.id,
      kind: 'rate_limited',
      retryable: true,
      safeCode: 'rate_limit',
    }))
    const controller = new AbortController()
    const guarded = coordinator({}, async (_milliseconds, signal) => {
      controller.abort()
      if (signal.aborted) throw new ProviderGatewayError({
        providerId: provider.id,
        kind: 'aborted',
        retryable: false,
        safeCode: 'caller_aborted',
      })
    })

    await expect(guarded.generate(input('invoke-abort-delay'), controller.signal))
      .rejects.toMatchObject({ kind: 'aborted' })
    expect(provider.generate).toHaveBeenCalledTimes(1)
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-abort-delay')).toMatchObject({
      status: 'failed',
      transportAttempts: 1,
      failureKind: 'aborted',
    })
  })

  it('rejects reported usage above the requested output cap and preserves usage metadata', async () => {
    provider.generate.mockResolvedValue({
      outputText: '{}',
      usage: { inputTokens: 20, outputTokens: 201 },
      providerRequestId: 'provider-request-over-cap',
    })

    await expect(coordinator().generate(input('invoke-over-cap'), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid_response', safeCode: 'reported_output_tokens_exceeded' })
    expect(await store.getProviderInvocation('tenant-provider', 'invoke-over-cap')).toMatchObject({
      status: 'failed',
      actualInputTokens: 20,
      actualOutputTokens: 201,
      providerRequestId: 'provider-request-over-cap',
    })
  })

  it('maps provider and coordinator failures to stable public contract errors', () => {
    expect(providerContractError(new ProviderGatewayError({
      providerId: provider.id,
      kind: 'timeout',
      retryable: true,
      safeCode: 'request_timeout',
    }), 'mapping')).toMatchObject({
      code: 'provider_timeout',
      category: 'provider',
      retryable: true,
      stage: 'mapping',
    })
    expect(providerContractError(new ProviderInvocationCoordinatorError(
      'budget_exceeded',
      false,
      'run_tokens_budget_exceeded',
      { dimension: 'tokens', actual: 101, maximum: 100 },
    ))).toMatchObject({
      code: 'budget_exceeded',
      category: 'budget',
      retryable: false,
    })
  })

  it.each([
    ['aborted', 'cancelled', 'cancellation', false],
    ['rate_limited', 'rate_limited', 'rate-limit', true],
    ['unavailable', 'provider_unavailable', 'availability', true],
    ['rejected', 'provider_rejected', 'provider', false],
    ['invalid_response', 'provider_rejected', 'provider', false],
    ['response_too_large', 'provider_rejected', 'provider', false],
  ] as const)('maps %s gateway failures without exposing raw messages', (kind, code, category, retryable) => {
    const mapped = providerContractError(new ProviderGatewayError({
      providerId: provider.id,
      kind,
      retryable,
      safeCode: 'safe_code',
    }))
    expect(mapped).toMatchObject({ code, category, retryable })
    expect(JSON.stringify(mapped)).not.toContain('provider request failed')
  })

  it.each([
    ['circuit_open', true],
    ['in_progress', true],
    ['outcome_unknown', false],
    ['already_succeeded', false],
    ['already_failed', false],
    ['ledger_conflict', false],
  ] as const)('maps %s coordinator failures with explicit retryability', (kind, retryable) => {
    expect(providerContractError(new ProviderInvocationCoordinatorError(
      kind,
      retryable,
      `safe_${kind}`,
      { providerId: provider.id },
    ))).toMatchObject({
      code: 'provider_unavailable',
      category: 'availability',
      retryable,
    })
    expect(providerContractError(new ProviderInvocationCoordinatorError(
      kind,
      retryable,
      `safe_${kind}`,
    ))).toMatchObject({ code: 'provider_unavailable' })
  })

  it('returns no provider contract error for unrelated failures', () => {
    expect(providerContractError(new Error('ordinary failure'))).toBeUndefined()
  })

  it('validates reliability policy and request bounds before reserving budget', async () => {
    expect(() => coordinator({ maxAttempts: 0 })).toThrow(/maxAttempts/)
    expect(() => coordinator({ maxAttempts: 6 })).toThrow(/maxAttempts/)
    expect(() => coordinator({ retryBaseDelayMs: 0 })).toThrow(/retryBaseDelayMs/)
    expect(() => coordinator({ retryBaseDelayMs: 101, retryMaxDelayMs: 100 })).toThrow(/must not exceed/)
    expect(() => coordinator({ circuitFailureThreshold: 0 })).toThrow(/circuitFailureThreshold/)
    expect(() => coordinator({ circuitOpenMs: 0 })).toThrow(/circuitOpenMs/)
    expect(() => coordinator({ staleAfterMs: 0 })).toThrow(/staleAfterMs/)
    expect(() => coordinator({ maxRunEstimatedTokens: 0 })).toThrow(/maxRunEstimatedTokens/)
    expect(() => coordinator({ maxRunEstimatedCostMicros: -1 })).toThrow(/maxRunEstimatedCostMicros/)

    const emptyPrompt = { ...makeModelRequest('invoke-empty'), systemPrompt: ' ' }
    await expect(coordinator().generate({ ...input('invoke-empty'), request: emptyPrompt }, new AbortController().signal))
      .rejects.toThrow(/must not be empty/)
    const oversizedInput = { ...makeModelRequest('invoke-input-large'), userPrompt: 'x'.repeat(100_001) }
    await expect(coordinator().generate(
      { ...input('invoke-input-large'), request: oversizedInput },
      new AbortController().signal,
    )).rejects.toThrow(/character limit/)
    const oversizedOutput = { ...makeModelRequest('invoke-output-large'), maxOutputTokens: 10_001 }
    await expect(coordinator().generate(
      { ...input('invoke-output-large'), request: oversizedOutput },
      new AbortController().signal,
    )).rejects.toThrow(/maxOutputTokens/)
    const cyclicSchema: Record<string, unknown> = {}
    cyclicSchema.self = cyclicSchema
    const cyclic = {
      ...makeModelRequest('invoke-cyclic'),
      output: { name: 'cyclic', schema: cyclicSchema },
    }
    await expect(coordinator().generate(
      { ...input('invoke-cyclic'), request: cyclic },
      new AbortController().signal,
    )).rejects.toThrow(/JSON serializable/)
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it('rejects invalid cost estimates and immutable invocation identity collisions', async () => {
    const invalidCost = new ProviderInvocationCoordinator({
      router: new ProviderRouter([provider], [{
        id: 'invalid-cost-route',
        providerId: provider.id,
        modelId: provider.modelId,
        profileVersion: provider.profileVersion,
        promptId: 'evidence-map',
        promptVersion: 'prompt-v1',
        roles: ['evidence-map'],
        qualityProfiles: ['standard'],
        priority: 0,
      }]),
      ledger: store,
      estimateCostMicros: () => -1,
      policy: policy(),
      now: () => now,
    })
    await expect(invalidCost.generate(input('invoke-invalid-cost'), new AbortController().signal))
      .rejects.toThrow(/estimatedCostMicros/)

    const reserved = await store.reserveProviderInvocation({
      tenantId: 'tenant-provider',
      runId,
      invocationId: 'invoke-collision',
      nodeKey: 'collision-node',
      runAttempt: 1,
      role: 'evidence-map',
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 1,
      reservedOutputTokens: 1,
      estimatedCostMicros: 1,
      maxRunEstimatedTokens: 100,
      maxRunEstimatedCostMicros: 100,
      staleAfterMs: 1_000,
      now,
    })
    expect(reserved.outcome).toBe('reserved')
    await expect(store.reserveProviderInvocation({
      tenantId: 'tenant-provider',
      runId,
      invocationId: 'invoke-collision',
      nodeKey: 'different-node',
      runAttempt: 1,
      role: 'evidence-map',
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 1,
      reservedOutputTokens: 1,
      estimatedCostMicros: 1,
      maxRunEstimatedTokens: 100,
      maxRunEstimatedCostMicros: 100,
      staleAfterMs: 1_000,
      now,
    })).rejects.toThrow(/identity changed/)
  })

  it('validates ledger metadata before it can reach a storage implementation', () => {
    const valid: ReserveProviderInvocationInput = {
      tenantId: 'tenant-provider',
      runId,
      invocationId: 'invoke-validation',
      nodeKey: 'node-validation',
      runAttempt: 0,
      role: 'evidence-map',
      providerId: provider.id,
      modelId: provider.modelId,
      profileVersion: provider.profileVersion,
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 0,
      reservedOutputTokens: 1,
      estimatedCostMicros: 0,
      maxRunEstimatedTokens: 1,
      maxRunEstimatedCostMicros: 0,
      staleAfterMs: 1,
      now: 0,
    }
    expect(() => assertProviderInvocationReservation(valid)).not.toThrow()
    expect(() => assertProviderInvocationReservation({ ...valid, invocationId: 'bad id' })).toThrow(/invocationId/)
    expect(() => assertProviderInvocationReservation({ ...valid, modelId: 'bad model!' })).toThrow(/modelId/)
    expect(() => assertProviderInvocationReservation({ ...valid, runAttempt: -1 })).toThrow(/runAttempt/)
    expect(() => assertProviderInvocationReservation({ ...valid, reservedOutputTokens: 0 })).toThrow(/reservedOutputTokens/)
    expect(() => assertProviderInvocationReservation({ ...valid, staleAfterMs: 0 })).toThrow(/staleAfterMs/)
    expect(() => assertProviderInvocationCompletion({
      tenantId: valid.tenantId,
      invocationId: valid.invocationId,
      transportAttempts: 0,
      now: 1,
      result: 'succeeded',
      actualInputTokens: 1,
      actualOutputTokens: 1,
      providerRequestId: 'safe-request-id',
    })).not.toThrow()
    expect(() => assertProviderInvocationCompletion({
      tenantId: valid.tenantId,
      invocationId: valid.invocationId,
      transportAttempts: 1,
      now: 1,
      result: 'failed',
      safeCode: 'bad code with spaces',
    })).toThrow(/safeCode/)
    expect(() => assertProviderInvocationCompletion({
      tenantId: valid.tenantId,
      invocationId: valid.invocationId,
      transportAttempts: 1,
      now: 1,
      result: 'failed',
      safeCode: 'safe',
      providerRequestId: 'line\nbreak',
    })).toThrow(/providerRequestId/)
  })

  it('derives stable collision-resistant invocation IDs from run node and attempt identity', () => {
    const identity = {
      runId,
      nodeKey: 'evidence:chunk-1',
      runAttempt: 1,
      role: 'evidence-map' as const,
    }
    const first = createStableInvocationId(identity)
    expect(createStableInvocationId(identity)).toBe(first)
    expect(first).toMatch(/^inv-[a-f0-9]{64}$/u)
    expect(createStableInvocationId({ ...identity, runAttempt: 2 })).not.toBe(first)
    expect(createStableInvocationId({ ...identity, nodeKey: 'evidence:chunk-2' })).not.toBe(first)
    expect(() => createStableInvocationId({ ...identity, runAttempt: -1 })).toThrow(/runAttempt/)
  })
})
