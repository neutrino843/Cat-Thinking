import type { QualityProfile } from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAnalysisServiceConfig } from '../src/config.js'
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTaskRole,
} from '../src/providers/modelProvider.js'
import { createConfiguredModelProvider } from '../src/providers/configuredProvider.js'
import {
  OpenAICompatibleProvider,
  type FetchImplementation,
} from '../src/providers/openAICompatibleProvider.js'
import { PromptRegistry, PromptRegistryError } from '../src/providers/promptRegistry.js'
import {
  ProviderGatewayError,
  classifyProviderHttpError,
  retryAfterMilliseconds,
} from '../src/providers/providerError.js'
import {
  ProviderRouter,
  ProviderRoutingError,
  type ModelRouteProfile,
} from '../src/providers/providerRouter.js'
import {
  StructuredOutputDecodeError,
  decodeStructuredOutput,
} from '../src/providers/structuredOutputDecoder.js'

const baseOptions = {
  id: 'approved-provider',
  modelId: 'approved/model-v1',
  profileVersion: 'profile-v1',
  apiStyle: 'responses' as const,
  baseUrl: 'https://models.example.com/v1',
  allowedHosts: ['models.example.com'],
  apiKey: 'unit-test-key-that-is-never-live',
  requestTimeoutMs: 1_000,
  maxInputCharacters: 10_000,
  maxOutputTokens: 4_096,
  maxResponseBytes: 10_000,
}

const request: ModelRequest = {
  invocationId: 'invocation-1',
  role: 'evidence-map',
  qualityProfile: 'standard',
  systemPrompt: 'Return grounded structured data.',
  userPrompt: 'Analyze this fixture.',
  output: {
    name: 'evidence_card',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
  maxOutputTokens: 500,
  temperature: 0,
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200, headers })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('OpenAI-compatible provider adapter', () => {
  it('sends a bounded Responses request and aggregates output safely', async () => {
    let capturedInput: Parameters<FetchImplementation>[0] | undefined
    let capturedInit: Parameters<FetchImplementation>[1]
    const fetchImplementation: FetchImplementation = vi.fn(async (input, init) => {
      capturedInput = input
      capturedInit = init
      return jsonResponse({
      id: 'response-1',
      status: 'completed',
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] },
      ],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      })
    })
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })

    const result = await provider.generate(request, new AbortController().signal)

    expect(result).toEqual({
      outputText: '{"answer":"ok"}',
      usage: { inputTokens: 12, outputTokens: 5 },
      providerRequestId: 'response-1',
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(String(capturedInput)).toBe('https://models.example.com/v1/responses')
    expect(capturedInit?.redirect).toBe('error')
    const body = JSON.parse(String(capturedInit?.body))
    expect(body).toMatchObject({
      model: 'approved/model-v1',
      store: false,
      text: { format: { type: 'json_schema', name: 'evidence_card', strict: true } },
    })
    expect(JSON.stringify(body)).not.toContain(baseOptions.apiKey)
  })

  it('supports the Chat Completions compatibility shape without changing the domain request', async () => {
    let capturedInput: Parameters<FetchImplementation>[0] | undefined
    let capturedInit: Parameters<FetchImplementation>[1]
    const fetchImplementation: FetchImplementation = vi.fn(async (input, init) => {
      capturedInput = input
      capturedInit = init
      return jsonResponse({
        id: 'chat-1',
        choices: [{ finish_reason: 'stop', message: { content: '{"answer":"chat"}' } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      })
    })
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      apiStyle: 'chat-completions',
      fetchImplementation,
    })

    await expect(provider.generate(request, new AbortController().signal)).resolves.toMatchObject({
      outputText: '{"answer":"chat"}',
      usage: { inputTokens: 9, outputTokens: 4 },
    })
    expect(String(capturedInput)).toBe('https://models.example.com/v1/chat/completions')
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { name: 'evidence_card', strict: true } },
    })
  })

  it('classifies rate limits without leaking provider messages or credentials', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({
      error: { code: 'slow_down', message: `private ${baseOptions.apiKey}` },
    }, { status: 429, headers: { 'retry-after': '2' } }))
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })

    const error = await provider.generate(request, new AbortController().signal).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(ProviderGatewayError)
    expect(error).toMatchObject({ kind: 'rate_limited', retryable: true, safeCode: 'slow_down', retryAfterMs: 2_000 })
    expect(String(error)).not.toContain(baseOptions.apiKey)
    expect(String(error)).not.toContain('private')
  })

  it('treats quota exhaustion as a non-retryable rejection', () => {
    expect(classifyProviderHttpError({
      providerId: 'approved-provider',
      statusCode: 429,
      providerCode: 'credit_balance_exhausted',
    })).toMatchObject({ kind: 'rejected', retryable: false })
  })

  it('maps timeout, service failure, and client rejection into stable categories', () => {
    expect(classifyProviderHttpError({
      providerId: 'approved-provider',
      statusCode: 408,
      providerCode: 'request_timeout',
    })).toMatchObject({ kind: 'timeout', retryable: true })
    expect(classifyProviderHttpError({
      providerId: 'approved-provider',
      statusCode: 503,
      providerCode: 'server_is_overloaded',
    })).toMatchObject({ kind: 'unavailable', retryable: true })
    expect(classifyProviderHttpError({
      providerId: 'approved-provider',
      statusCode: 401,
      providerCode: 'unsafe code with spaces',
    })).toMatchObject({ kind: 'rejected', retryable: false, safeCode: 'unknown' })
  })

  it('stops a hung request at the configured timeout', async () => {
    vi.useFakeTimers()
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })
    const pending = provider.generate(request, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    await vi.advanceTimersByTimeAsync(1_000)

    await assertion
  })

  it('honors caller cancellation and never reports it as retryable', async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })
    const controller = new AbortController()
    const pending = provider.generate(request, controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('rejects oversized, refused, and usage-free responses', async () => {
    const oversized = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': '10001' },
      }),
    })
    await expect(oversized.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'response_too_large',
    })

    const refused = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => jsonResponse({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'not allowed' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    })
    await expect(refused.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rejected',
      safeCode: 'model_refusal',
    })

    const missingUsage = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => jsonResponse({ status: 'completed', output_text: '{}' }),
    })
    await expect(missingUsage.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })

  it('accepts top-level Responses output and rejects incomplete or malformed payloads', async () => {
    const topLevel = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => jsonResponse({
        id: 'response-top-level',
        status: 'completed',
        output_text: '{"answer":"top"}',
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    })
    await expect(topLevel.generate({ ...request, temperature: undefined }, new AbortController().signal))
      .resolves.toMatchObject({ outputText: '{"answer":"top"}' })

    const incomplete = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => jsonResponse({
        status: 'incomplete',
        output_text: '{}',
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    })
    await expect(incomplete.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rejected',
      safeCode: 'response_not_completed',
    })

    const malformed = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => new Response('not-json', { status: 200 }),
    })
    await expect(malformed.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid_response',
      safeCode: 'invalid_json',
    })

    const empty = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => jsonResponse({
        status: 'completed',
        output: [],
        usage: { input_tokens: 2, output_tokens: 0 },
      }),
    })
    await expect(empty.generate(request, new AbortController().signal)).rejects.toMatchObject({
      safeCode: 'output_missing',
    })
  })

  it('rejects abnormal Chat completions and network failures deterministically', async () => {
    const refused = new OpenAICompatibleProvider({
      ...baseOptions,
      apiStyle: 'chat-completions',
      fetchImplementation: async () => jsonResponse({
        choices: [{ finish_reason: 'stop', message: { refusal: 'blocked', content: null } }],
        usage: { prompt_tokens: 2, completion_tokens: 0 },
      }),
    })
    await expect(refused.generate(request, new AbortController().signal)).rejects.toMatchObject({
      safeCode: 'model_refusal',
    })

    const truncated = new OpenAICompatibleProvider({
      ...baseOptions,
      apiStyle: 'chat-completions',
      fetchImplementation: async () => jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    })
    await expect(truncated.generate(request, new AbortController().signal)).rejects.toMatchObject({
      safeCode: 'finish_not_complete',
    })

    const disconnected = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => { throw new TypeError('private network detail') },
    })
    await expect(disconnected.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'unavailable',
      safeCode: 'connection_failed',
    })
  })

  it('checks cancellation and response byte limits before accepting output', async () => {
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      fetchImplementation: async () => new Response('x'.repeat(10_001), { status: 200 }),
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(provider.generate(request, aborted.signal)).rejects.toMatchObject({ kind: 'aborted' })
    await expect(provider.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'response_too_large',
      safeCode: 'stream_limit_exceeded',
    })
  })

  it('rejects unapproved endpoints and over-budget requests before network I/O', async () => {
    expect(() => new OpenAICompatibleProvider({
      ...baseOptions,
      baseUrl: 'https://unapproved.example.com/v1',
    })).toThrow(/allowlisted/)

    const fetchImplementation = vi.fn()
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })
    await expect(provider.generate({
      ...request,
      maxOutputTokens: baseOptions.maxOutputTokens + 1,
    }, new AbortController().signal)).rejects.toThrow(/maxOutputTokens/)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('rejects malformed endpoint and request configuration before network I/O', async () => {
    expect(() => new OpenAICompatibleProvider({ ...baseOptions, baseUrl: 'not-a-url' })).toThrow(/invalid/)
    expect(() => new OpenAICompatibleProvider({ ...baseOptions, baseUrl: 'file:///models' })).toThrow(/HTTP/)
    expect(() => new OpenAICompatibleProvider({
      ...baseOptions,
      baseUrl: 'https://user:secret@models.example.com/v1?unsafe=true',
    })).toThrow(/credentials/)
    expect(() => new OpenAICompatibleProvider({ ...baseOptions, allowedHosts: [] })).toThrow(/allowlisted/)

    const fetchImplementation = vi.fn()
    const provider = new OpenAICompatibleProvider({ ...baseOptions, fetchImplementation })
    await expect(provider.generate({ ...request, invocationId: 'bad id' }, new AbortController().signal))
      .rejects.toThrow(/invocation/)
    await expect(provider.generate({ ...request, systemPrompt: ' ' }, new AbortController().signal))
      .rejects.toThrow(/empty/)
    await expect(provider.generate({ ...request, temperature: 3 }, new AbortController().signal))
      .rejects.toThrow(/temperature/)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(provider.generate({
      ...request,
      output: { ...request.output, schema: circular },
    }, new AbortController().signal)).rejects.toThrow(/JSON serializable/)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })
})

describe('provider gateway support components', () => {
  it('decodes only strict schema-valid JSON and never echoes invalid output', () => {
    const schema = z.object({ answer: z.string() }).strict()
    expect(decodeStructuredOutput('{"answer":"ok"}', schema, 1_000)).toEqual({ answer: 'ok' })
    expect(() => decodeStructuredOutput('```json\n{}\n```', schema, 1_000)).toThrowError(
      expect.objectContaining({ code: 'invalid_json' }),
    )
    expect(() => decodeStructuredOutput('{"answer":1}', schema, 1_000)).toThrowError(
      expect.objectContaining({ code: 'schema_invalid', issueCount: 1 }),
    )
    expect(() => decodeStructuredOutput('{"answer":"too large"}', schema, 4)).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    )
    expect(() => decodeStructuredOutput('{"__proto__":{"polluted":true}}', z.record(z.string(), z.unknown()), 1_000))
      .toThrowError(expect.objectContaining({ code: 'schema_invalid' }))
    try {
      decodeStructuredOutput('private provider output', schema, 1_000)
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputDecodeError)
      expect(String(error)).not.toContain('private provider output')
    }
  })

  it('keeps prompts versioned and requires an exact task role', () => {
    const definition = {
      id: 'evidence.map',
      version: 'v1',
      role: 'evidence-map' as const,
      system: 'Use only supplied evidence.',
      render: ({ text }: { text: string }) => `TEXT:\n${text}`,
    }
    const registry = new PromptRegistry([definition])

    expect(registry.resolve<{ text: string }>('evidence.map', 'v1', 'evidence-map').render({ text: 'fixture' }))
      .toBe('TEXT:\nfixture')
    expect(registry.list()).toEqual([{ id: 'evidence.map', version: 'v1', role: 'evidence-map' }])
    expect(() => registry.resolve('evidence.map', 'v1', 'repair')).toThrowError(PromptRegistryError)
    expect(() => registry.register(definition)).toThrow(/duplicate/)
    expect(() => registry.resolve('evidence.map', 'v2', 'evidence-map')).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('routes by task and quality while skipping providers that are not ready', () => {
    const makeProvider = (id: string, ready: boolean): ModelProvider => ({
      id,
      modelId: 'model-v1',
      profileVersion: 'profile-v1',
      capabilities: {
        apiStyle: 'responses',
        structuredOutputs: true,
        reportsUsage: true,
        supportsAbort: true,
        maxInputCharacters: 10_000,
        maxOutputTokens: 2_000,
      },
      isReady: () => ready,
      generate: async (): Promise<ModelResponse> => ({ outputText: '{}', usage: { inputTokens: 0, outputTokens: 0 } }),
    })
    const profile = (
      id: string,
      providerId: string,
      priority: number,
      roles: readonly ModelTaskRole[] = ['evidence-map'],
      qualities: readonly QualityProfile[] = ['standard'],
    ): ModelRouteProfile => ({
      id,
      providerId,
      modelId: 'model-v1',
      profileVersion: 'profile-v1',
      promptId: 'evidence.map',
      promptVersion: 'v1',
      roles,
      qualityProfiles: qualities,
      priority,
    })
    const router = new ProviderRouter(
      [makeProvider('primary', false), makeProvider('fallback', true)],
      [profile('primary-profile', 'primary', 1), profile('fallback-profile', 'fallback', 2)],
    )

    expect(router.route('evidence-map', 'standard').provider.id).toBe('fallback')
    expect(() => router.route('artifact-quiz', 'standard')).toThrowError(
      expect.objectContaining({ code: 'route_unavailable' }),
    )
    expect(() => new ProviderRouter(
      [makeProvider('duplicate', true), makeProvider('duplicate', true)],
      [],
    )).toThrowError(ProviderRoutingError)
    expect(() => new ProviderRouter(
      [makeProvider('primary', true)],
      [profile('invalid-priority', 'primary', -1)],
    )).toThrowError(ProviderRoutingError)
  })

  it('parses Retry-After defensively and creates a configured adapter only when enabled', () => {
    expect(retryAfterMilliseconds('1.25', 0)).toBe(1_250)
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 01:30:00 GMT', 0)).toBe(3_600_000)
    expect(retryAfterMilliseconds('invalid', 0)).toBeUndefined()
    expect(createConfiguredModelProvider(loadAnalysisServiceConfig({ NODE_ENV: 'test' }).provider)).toBeUndefined()

    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_PROVIDER_MODE: 'openai-compatible',
      ANALYSIS_PROVIDER_ID: 'approved-provider',
      ANALYSIS_PROVIDER_BASE_URL: 'https://models.example.com/v1',
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.example.com',
      ANALYSIS_PROVIDER_API_KEY: 'provider-test-key-with-safe-length',
      ANALYSIS_PROVIDER_MODEL_ID: 'approved-model',
      ANALYSIS_PROVIDER_PROFILE_VERSION: 'profile-v1',
    })
    const provider = createConfiguredModelProvider(config.provider, async () => jsonResponse({}))
    expect(provider).toMatchObject({ id: 'approved-provider', modelId: 'approved-model' })
  })
})
