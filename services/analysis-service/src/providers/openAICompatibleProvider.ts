import { z } from 'zod'
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelResponse,
  ProviderApiStyle,
} from './modelProvider.js'
import {
  ProviderGatewayError,
  classifyProviderHttpError,
} from './providerError.js'

const OUTPUT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u
const DEFAULT_ERROR_BODY_LIMIT = 65_536
const MAX_OUTPUT_SCHEMA_BYTES = 262_144

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OpenAICompatibleProviderOptions {
  readonly id: string
  readonly modelId: string
  readonly profileVersion: string
  readonly apiStyle: ProviderApiStyle
  readonly baseUrl: string
  readonly allowedHosts: readonly string[]
  readonly apiKey: string
  readonly requestTimeoutMs: number
  readonly maxInputCharacters: number
  readonly maxOutputTokens: number
  readonly maxResponseBytes: number
  readonly fetchImplementation?: FetchImplementation
}

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
}).passthrough()

const responsesEnvelopeSchema = z.object({
  id: z.string().max(256).optional(),
  status: z.string().max(40).optional(),
  output_text: z.string().optional(),
  output: z.array(z.object({
    type: z.string().max(80),
    content: z.array(z.object({
      type: z.string().max(80),
      text: z.string().optional(),
      refusal: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
  usage: usageSchema.optional(),
}).passthrough()

const chatEnvelopeSchema = z.object({
  id: z.string().max(256).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().max(80).nullable().optional(),
    message: z.object({
      content: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough()

const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.union([z.string(), z.number()]).optional() }).passthrough(),
}).passthrough()

const providerFailure = (
  providerId: string,
  kind: ConstructorParameters<typeof ProviderGatewayError>[0]['kind'],
  retryable: boolean,
  safeCode: string,
): ProviderGatewayError => new ProviderGatewayError({ providerId, kind, retryable, safeCode })

const validateBoundedInteger = (value: number, name: string, minimum: number, maximum: number): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
}

const normalizeBaseUrl = (baseUrl: string, allowedHosts: readonly string[]): URL => {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new TypeError('provider base URL is invalid')
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('provider base URL must use HTTP(S)')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('provider base URL must not contain credentials, query, or fragment')
  }
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()))
  if (hosts.size === 0 || !hosts.has(parsed.host.toLowerCase())) {
    throw new TypeError('provider base URL host is not allowlisted')
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/`
  return parsed
}

const requestIdentifier = (value: string | null | undefined): string | undefined => value
  && /^[\x21-\x7e]{1,256}$/u.test(value)
  ? value
  : undefined

const readResponseText = async (
  response: Response,
  maximumBytes: number,
  providerId: string,
): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw providerFailure(providerId, 'response_too_large', false, 'content_length_exceeded')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += result.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw providerFailure(providerId, 'response_too_large', false, 'stream_limit_exceeded')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined)
  } catch {
    throw providerFailure(providerId, 'invalid_response', false, 'invalid_utf8')
  }
}

const parseJson = (text: string, providerId: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw providerFailure(providerId, 'invalid_response', false, 'invalid_json')
  }
}

const extractErrorCode = async (response: Response, providerId: string): Promise<unknown> => {
  try {
    const text = await readResponseText(response, DEFAULT_ERROR_BODY_LIMIT, providerId)
    const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.error.code : undefined
  } catch {
    return undefined
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string
  readonly modelId: string
  readonly profileVersion: string
  readonly capabilities: ModelProviderCapabilities
  private readonly apiStyle: ProviderApiStyle
  private readonly endpoint: URL
  private readonly apiKey: string
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImplementation: FetchImplementation

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!SAFE_ID_PATTERN.test(options.id)) throw new TypeError('provider id is invalid')
    if (!MODEL_ID_PATTERN.test(options.modelId)) throw new TypeError('provider model id is invalid')
    if (!SAFE_ID_PATTERN.test(options.profileVersion)) throw new TypeError('provider profile version is invalid')
    if (options.apiKey.trim().length === 0 || options.apiKey.length > 4_096) {
      throw new TypeError('provider API key is invalid')
    }
    validateBoundedInteger(options.requestTimeoutMs, 'requestTimeoutMs', 1_000, 300_000)
    validateBoundedInteger(options.maxInputCharacters, 'maxInputCharacters', 1_000, 10_000_000)
    validateBoundedInteger(options.maxOutputTokens, 'maxOutputTokens', 1, 1_000_000)
    validateBoundedInteger(options.maxResponseBytes, 'maxResponseBytes', 1_024, 20_000_000)
    const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowedHosts)
    this.id = options.id
    this.modelId = options.modelId
    this.profileVersion = options.profileVersion
    this.apiStyle = options.apiStyle
    this.endpoint = new URL(options.apiStyle === 'responses' ? 'responses' : 'chat/completions', baseUrl)
    this.apiKey = options.apiKey
    this.requestTimeoutMs = options.requestTimeoutMs
    this.maxResponseBytes = options.maxResponseBytes
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.capabilities = Object.freeze({
      apiStyle: options.apiStyle,
      structuredOutputs: true as const,
      reportsUsage: true as const,
      supportsAbort: true as const,
      maxInputCharacters: options.maxInputCharacters,
      maxOutputTokens: options.maxOutputTokens,
    })
  }

  isReady(): boolean {
    return true
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    this.validateRequest(request)
    if (signal.aborted) throw providerFailure(this.id, 'aborted', false, 'caller_aborted')
    const body = JSON.stringify(this.requestBody(request))
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    timeout.unref()
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        const providerCode = await extractErrorCode(response, this.id)
        throw classifyProviderHttpError({
          providerId: this.id,
          statusCode: response.status,
          providerCode,
          retryAfter: response.headers.get('retry-after'),
        })
      }
      const responseText = await readResponseText(response, this.maxResponseBytes, this.id)
      const payload = parseJson(responseText, this.id)
      return this.apiStyle === 'responses'
        ? this.decodeResponsesPayload(payload, response)
        : this.decodeChatPayload(payload, response)
    } catch (error) {
      if (error instanceof ProviderGatewayError) throw error
      if (timedOut) throw providerFailure(this.id, 'timeout', true, 'request_timeout')
      if (signal.aborted) throw providerFailure(this.id, 'aborted', false, 'caller_aborted')
      throw providerFailure(this.id, 'unavailable', true, 'connection_failed')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abortFromCaller)
    }
  }

  private validateRequest(request: ModelRequest): void {
    if (!SAFE_ID_PATTERN.test(request.invocationId)) throw new TypeError('invocation id is invalid')
    if (!OUTPUT_NAME_PATTERN.test(request.output.name)) throw new TypeError('structured output name is invalid')
    if (request.systemPrompt.trim().length === 0 || request.userPrompt.trim().length === 0) {
      throw new TypeError('provider prompts must not be empty')
    }
    if (request.systemPrompt.length + request.userPrompt.length > this.capabilities.maxInputCharacters) {
      throw new RangeError('provider input exceeds configured character limit')
    }
    validateBoundedInteger(request.maxOutputTokens, 'maxOutputTokens', 1, this.capabilities.maxOutputTokens)
    if (request.temperature !== undefined && (
      !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2
    )) throw new RangeError('temperature must be between 0 and 2')
    let serializedSchema: string
    try {
      serializedSchema = JSON.stringify(request.output.schema)
    } catch {
      throw new TypeError('structured output schema must be JSON serializable')
    }
    if (new TextEncoder().encode(serializedSchema).byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
      throw new RangeError('structured output schema is too large')
    }
  }

  private requestBody(request: ModelRequest): Readonly<Record<string, unknown>> {
    const schema = {
      name: request.output.name,
      schema: request.output.schema,
      strict: true,
    }
    if (this.apiStyle === 'responses') {
      return {
        model: this.modelId,
        instructions: request.systemPrompt,
        input: request.userPrompt,
        max_output_tokens: request.maxOutputTokens,
        store: false,
        text: { format: { type: 'json_schema', ...schema } },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }
    }
    return {
      model: this.modelId,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      max_completion_tokens: request.maxOutputTokens,
      response_format: { type: 'json_schema', json_schema: schema },
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }
  }

  private decodeResponsesPayload(payload: unknown, response: Response): ModelResponse {
    const parsed = responsesEnvelopeSchema.safeParse(payload)
    if (!parsed.success || !parsed.data.usage) {
      throw providerFailure(this.id, 'invalid_response', false, 'response_schema_invalid')
    }
    if (parsed.data.status && parsed.data.status !== 'completed') {
      throw providerFailure(this.id, 'rejected', false, 'response_not_completed')
    }
    const outputParts: string[] = []
    if (!parsed.data.output_text) {
      for (const item of parsed.data.output ?? []) {
        for (const content of item.content ?? []) {
          if (content.refusal || content.type === 'refusal') {
            throw providerFailure(this.id, 'rejected', false, 'model_refusal')
          }
          if (content.type === 'output_text' && content.text) outputParts.push(content.text)
        }
      }
    }
    const outputText = parsed.data.output_text ?? outputParts.join('')
    if (outputText.length === 0) throw providerFailure(this.id, 'invalid_response', false, 'output_missing')
    return {
      outputText,
      usage: {
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
      },
      providerRequestId: requestIdentifier(parsed.data.id ?? response.headers.get('x-request-id')),
    }
  }

  private decodeChatPayload(payload: unknown, response: Response): ModelResponse {
    const parsed = chatEnvelopeSchema.safeParse(payload)
    if (!parsed.success) throw providerFailure(this.id, 'invalid_response', false, 'response_schema_invalid')
    const choice = parsed.data.choices[0]
    if (!choice) throw providerFailure(this.id, 'invalid_response', false, 'choice_missing')
    if (choice.message.refusal) throw providerFailure(this.id, 'rejected', false, 'model_refusal')
    if (choice.finish_reason && !['stop', 'completed'].includes(choice.finish_reason)) {
      throw providerFailure(this.id, 'rejected', false, 'finish_not_complete')
    }
    const outputText = choice.message.content
    if (!outputText) throw providerFailure(this.id, 'invalid_response', false, 'output_missing')
    return {
      outputText,
      usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
      },
      providerRequestId: requestIdentifier(parsed.data.id ?? response.headers.get('x-request-id')),
    }
  }
}
