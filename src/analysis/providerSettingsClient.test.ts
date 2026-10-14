import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersonalProviderSettingsInput, PersonalProviderStatus } from '@cat-thinking/analysis-contracts'
import {
  HttpProviderSettingsClient,
  canReuseSavedProviderKey,
  isTextModelSuggestion,
  MAX_PROVIDER_SETTINGS_RESPONSE_BYTES,
  ProviderSettingsClientError,
  providerSettingsErrorText,
} from './providerSettingsClient'

const status: PersonalProviderStatus = {
  version: 1, revision: 2, available: true, enabled: false, configured: true, hasApiKey: true,
  providerId: 'custom', baseUrl: 'https://example.com/v1', modelId: 'public-test-model',
  protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
  checkState: 'ready', acceptsRuns: false, pricingKnown: false,
  limits: { maxInputCharacters: 80_000, maxOutputTokens: 4_000, maxRunTokens: 80_000, maxInvocations: 24 },
}
const input: PersonalProviderSettingsInput = {
  version: 1, expectedRevision: 1, providerId: 'custom', baseUrl: 'https://example.com/v1',
  modelId: 'public-test-model', apiKey: 'synthetic-not-a-credential',
  protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public',
}
const response = (value: unknown, statusCode = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status: statusCode, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
})
const signal = () => new AbortController().signal

afterEach(() => vi.useRealTimers())

describe('Provider settings client', () => {
  it('recognizes the same canonical service when a complete endpoint is pasted', () => {
    expect(canReuseSavedProviderKey(status, { providerId: 'custom', baseUrl: 'https://EXAMPLE.com:443/v1/chat/completions/', networkMode: 'public' })).toBe(true)
    expect(canReuseSavedProviderKey(status, { providerId: 'custom', baseUrl: 'https://example.com/v1/responses', networkMode: 'public' })).toBe(true)
  })

  it.each([
    'https://another.example/v1', 'https://example.com/other/v1', 'https://example.com/v1?api_key=public',
    'https://example.com/v1#fragment', 'https://public@example.com/v1', 'ftp://example.com/v1', 'not-a-url',
  ])('never suggests credential reuse across a changed or unsafe endpoint %s', (baseUrl) => {
    expect(canReuseSavedProviderKey(status, { providerId: 'custom', baseUrl, networkMode: 'public' })).toBe(false)
  })

  it('never suggests credential reuse without a matching saved provider and network mode', () => {
    expect(canReuseSavedProviderKey(undefined, input)).toBe(false)
    expect(canReuseSavedProviderKey({ ...status, hasApiKey: false }, input)).toBe(false)
    expect(canReuseSavedProviderKey({ ...status, providerId: 'other' }, input)).toBe(false)
    expect(canReuseSavedProviderKey({ ...status, networkMode: 'local-loopback' }, input)).toBe(false)
    expect(canReuseSavedProviderKey({ ...status, baseUrl: undefined }, input)).toBe(false)
    expect(canReuseSavedProviderKey({ ...status, baseUrl: 'invalid-url' }, input)).toBe(false)
  })
  it.each(['text-embedding-3-large', 'nomic-embed-text', 'BAAI/bge-m3', 'whisper-1', 'gpt-image-1', 'gpt-4o-audio-preview', 'dall-e-3', 'vendor/flux-1', 'speech-1', 'video-gen'])('hides the obvious non-text list suggestion %s', (id) => {
    expect(isTextModelSuggestion(id)).toBe(false)
  })

  it.each(['public-chat-model', 'qwen-vl-plus', 'gpt-6.1-sol', 'vendor/unknown-model'])('retains a text or unclassified list suggestion %s', (id) => {
    expect(isTextModelSuggestion(id)).toBe(true)
  })
  it('uses only same-origin metadata endpoints and disallows redirects and caching', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(status))
    const client = new HttpProviderSettingsClient(fetcher)
    expect(await client.status(signal())).toEqual(status)
    expect(fetcher).toHaveBeenCalledWith('/api/analysis/v1/personal/settings', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: undefined,
      headers: { accept: 'application/json' },
    }))
    expect(JSON.stringify(await client.status(signal()))).not.toContain(input.apiKey)
  })

  it('sends a credential only in the validated save body, never headers or query', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(status))
    await new HttpProviderSettingsClient(fetcher).save(input, signal())
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('/api/analysis/v1/personal/settings')
    expect(options?.method).toBe('PUT')
    expect(JSON.parse(String(options?.body))).toEqual(input)
    expect(JSON.stringify(options?.headers)).not.toContain(input.apiKey)
  })

  it('uses server model discovery with an explicit preview input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ version: 1, models: [{ id: 'public-test-model', label: 'Public model' }], source: 'provider' }))
    const { expectedRevision, ...preview } = input
    expect(expectedRevision).toBe(1)
    const result = await new HttpProviderSettingsClient(fetcher).models(preview, signal())
    expect(result.source).toBe('provider')
    expect(fetcher.mock.calls[0][0]).toBe('/api/analysis/v1/personal/models')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty('expectedRevision')
  })

  it('preserves revision checks for check, enable, pause and credential deletion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(status))
    const client = new HttpProviderSettingsClient(fetcher)
    const action = { version: 1 as const, expectedRevision: 2 }
    await client.check(action, signal()); await client.enable(action, signal())
    await client.pause(action, signal()); await client.forget(action, signal())
    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method, JSON.parse(String(options?.body))])).toEqual([
      ['/api/analysis/v1/personal/check', 'POST', action],
      ['/api/analysis/v1/personal/enable', 'POST', action],
      ['/api/analysis/v1/personal/pause', 'POST', action],
      ['/api/analysis/v1/personal/settings', 'DELETE', action],
    ])
  })

  it('rejects invalid inputs before any network operation without disclosing the input', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new HttpProviderSettingsClient(fetcher)
    await expect(client.save({ ...input, modelId: 'bad model' }, signal())).rejects.toMatchObject({ code: 'invalid_input' })
    const { expectedRevision, ...preview } = input
    expect(expectedRevision).toBe(1)
    await expect(client.models({ ...preview, apiKey: 'contains space' }, signal())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(client.enable({ version: 1, expectedRevision: -1 }, signal())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(client.forget({ version: 1, expectedRevision: -1 }, signal())).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'], [403, 'forbidden'], [409, 'conflict'], [429, 'rate_limited'],
    [404, 'unavailable'], [503, 'unavailable'], [400, 'invalid_input'], [422, 'invalid_input'], [418, 'rejected'],
  ])('maps HTTP %i to a fixed safe error', async (httpStatus, code) => {
    const client = new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockImplementation(async () => response({ apiKey: input.apiKey }, httpStatus)))
    await expect(client.status(signal())).rejects.toMatchObject({ code, message: code })
    try { await client.status(signal()) } catch (error) {
      expect(providerSettingsErrorText(error)).not.toContain(input.apiKey)
    }
  })

  it.each([
    response({ ...status, apiKey: input.apiKey }),
    response({ ...status, apiKeyHint: 'abc…' }),
    response({ ...status, revision: -1 }),
    response(status, 200, { 'content-type': 'text/html' }),
    new Response('invalid-json', { headers: { 'content-type': 'application/json' } }),
  ])('refuses malformed or secret-shaped public responses', async (invalid) => {
    await expect(new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockResolvedValue(invalid)).status(signal())).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('refuses declared oversized responses before reading the body', async () => {
    const oversized = response(status, 200, { 'content-length': String(MAX_PROVIDER_SETTINGS_RESPONSE_BYTES + 1) })
    await expect(new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockResolvedValue(oversized)).status(signal())).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('cancels a streamed oversized response', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PROVIDER_SETTINGS_RESPONSE_BYTES + 1)) }, cancel,
    })
    const oversized = new Response(stream, { headers: { 'content-type': 'application/json' } })
    await expect(new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockResolvedValue(oversized)).status(signal())).rejects.toMatchObject({ code: 'response_too_large' })
    expect(cancel).toHaveBeenCalled()
  })

  it('supports a response implementation without a stream and keeps its byte cap', async () => {
    const bodyless = { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: null,
      text: async () => JSON.stringify(status) } as Response
    expect(await new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockResolvedValue(bodyless)).status(signal())).toEqual(status)
    const tooLarge = { ...bodyless, text: async () => '中'.repeat(MAX_PROVIDER_SETTINGS_RESPONSE_BYTES) } as Response
    await expect(new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockResolvedValue(tooLarge)).status(signal())).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('does not expose a raw network error or unknown error message', async () => {
    const client = new HttpProviderSettingsClient(vi.fn<typeof fetch>().mockRejectedValue(new Error(`upstream ${input.apiKey}`)))
    await expect(client.status(signal())).rejects.toMatchObject({ code: 'network', message: 'network' })
    expect(providerSettingsErrorText(new Error(input.apiKey))).not.toContain(input.apiKey)
    expect(providerSettingsErrorText(new ProviderSettingsClientError('timeout'))).toContain('超时')
  })

  it('does not fetch for an already aborted request', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher = vi.fn<typeof fetch>()
    await expect(new HttpProviderSettingsClient(fetcher).status(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('forwards cancellation and ends an in-flight request without reporting credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(input.apiKey)), { once: true })
    }))
    const controller = new AbortController()
    const pending = new HttpProviderSettingsClient(fetcher).status(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds waiting and cleans its timeout', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(input.apiKey)), { once: true })
    }))
    const pending = new HttpProviderSettingsClient(fetcher, 25).status(signal())
    const result = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'timeout' })
    await vi.advanceTimersByTimeAsync(25)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})
