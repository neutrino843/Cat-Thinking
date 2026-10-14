// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProviderPreset, personalProviderStatusSchema, PROVIDER_CATALOG, type PersonalProviderModelsInput } from '@cat-thinking/analysis-contracts'
import { OpenAICompatibleProvider } from '../src/providers/openAICompatibleProvider.js'
import { createPersonalModelProvider, PERSONAL_PROVIDER_LIMITS } from '../src/providers/personalModelProvider.js'
import { createPinnedProviderFetch, fetchProviderModels, isPublicProviderAddress, normalizeProviderBaseUrl, ProviderConnectionError, resolveProviderAddresses } from '../src/providers/providerConnection.js'
import type { ModelRequest } from '../src/providers/modelProvider.js'

const request: ModelRequest = {
  invocationId: 'compat-1', role: 'artifact-summary', qualityProfile: 'standard',
  systemPrompt: 'Summarize grounded facts.', userPrompt: 'A public synthetic example.',
  output: { name: 'summary', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  maxOutputTokens: 300, temperature: 0,
}
const settings: PersonalProviderModelsInput = {
  version: 1, providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/chat/completions',
  modelId: 'deepseek-flash', apiKey: 'synthetic-key', protocol: 'chat-completions',
  structuredOutput: 'json_object', networkMode: 'public',
}
const chatResult = () => new Response(JSON.stringify({
  id: 'compat-response', choices: [{ finish_reason: 'stop', message: { content: '{"text":"grounded"}' } }],
  usage: { prompt_tokens: 20, completion_tokens: 8 },
}), { headers: { 'content-type': 'application/json' } })
const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())) })

describe('friendly provider compatibility', () => {
  it('uses dated official presets without fabricated account availability or prices', () => {
    expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual(['openai', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'siliconflow', 'gemini', 'ollama', 'custom'])
    expect(getProviderPreset('deepseek')?.models[0]?.id).toBe('deepseek-flash')
    expect(getProviderPreset('openai')?.protocol).toBe('responses')
    expect(getProviderPreset('missing')).toBeUndefined()
    expect(getProviderPreset('ollama')?.requiresApiKey).toBe(false)
    expect(PROVIDER_CATALOG.every((entry) => entry.verifiedAt === '2026-10-12' && Object.isFrozen(entry.models))).toBe(true)
    expect(JSON.stringify(PROVIDER_CATALOG)).not.toContain('price')
  })

  it('makes the public status contract reject accidental secret fields', () => {
    const status = { version: 1, revision: 0, available: true, enabled: false, configured: false, hasApiKey: false,
      checkState: 'unchecked', acceptsRuns: false, pricingKnown: false, limits: PERSONAL_PROVIDER_LIMITS }
    expect(personalProviderStatusSchema.safeParse(status).success).toBe(true)
    expect(personalProviderStatusSchema.safeParse({ ...status, apiKey: 'hidden' }).success).toBe(false)
    expect(personalProviderStatusSchema.safeParse({ ...status, pricingKnown: true }).success).toBe(false)
  })

  it.each([
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/'],
    ['https://api.example.com/v1/responses/', 'https://api.example.com/v1/'],
    ['https://api.example.com/v1/v1', 'https://api.example.com/v1/'],
    ['https://api.example.com/v1/models', 'https://api.example.com/v1/'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/'],
    ['https://api.openai.com', 'https://api.openai.com/v1/'],
    ['https://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com/compatible-mode/v1/'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'https://generativelanguage.googleapis.com/v1beta/openai/'],
  ])('normalizes full endpoint %s without appending another v1', (input, expected) => {
    expect(normalizeProviderBaseUrl(input)).toBe(expected)
  })

  it.each([
    'https://user:secret@api.example.com/v1', 'https://api.example.com/v1?key=secret',
    'https://api.example.com/v1#secret', 'http://api.example.com/v1',
    'https://127.0.0.1/v1', 'https://2130706433/v1', 'https://0x7f000001/v1',
    'https://[::ffff:127.0.0.1]/v1', 'https://169.254.169.254/v1',
    'https://metadata.google.internal/v1', 'https://secret.local/v1', 'https://host/v1',
    'file:///v1', 'not-a-url',
  ])('rejects credentials, ambiguous hosts and private endpoints %s', (input) => {
    expect(() => normalizeProviderBaseUrl(input)).toThrow()
  })

  it('requires an explicit local mode with exactly the supported loopback hosts', () => {
    expect(normalizeProviderBaseUrl('http://localhost:11434/v1', { networkMode: 'local-loopback' })).toBe('http://localhost:11434/v1/')
    expect(normalizeProviderBaseUrl('http://[::1]:11434/v1', { networkMode: 'local-loopback' })).toBe('http://[::1]:11434/v1/')
    expect(() => normalizeProviderBaseUrl('http://192.168.1.1/v1', { networkMode: 'local-loopback' })).toThrow()
    expect(() => normalizeProviderBaseUrl('https://api.example.com/v1', { allowedHosts: ['different.example.com'] })).toThrow()
  })

  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.2', '169.254.170.2', '172.16.0.1', '192.168.1.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:0db8::1', '2002:0808:0808::1', '3fff::1', 'invalid'])('excludes non-public address %s', (address) => {
    expect(isPublicProviderAddress(address)).toBe(false)
  })

  it('validates every DNS answer and refuses rebinding to private or mapped addresses', async () => {
    expect(isPublicProviderAddress('8.8.8.8')).toBe(true)
    expect(isPublicProviderAddress('2606:4700:4700::1111')).toBe(true)
    const url = new URL('https://api.example.com/v1/')
    await expect(resolveProviderAddresses(url, 'public', async () => [{ address: '8.8.8.8', family: 4 }])).resolves.toHaveLength(1)
    await expect(resolveProviderAddresses(url, 'public', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toMatchObject({ safeCode: 'endpoint_dns_private_network' })
    await expect(resolveProviderAddresses(url, 'public', async () => [])).rejects.toMatchObject({ safeCode: 'endpoint_dns_private_network' })
    await expect(resolveProviderAddresses(new URL('http://localhost/v1'), 'local-loopback', async () => [{ address: '127.0.0.2', family: 4 }])).rejects.toMatchObject({ safeCode: 'endpoint_dns_private_network' })
  })

  it('uses JSON object with schema instructions and max_tokens, without a paid compatibility replay', async () => {
    const fetchImplementation = vi.fn(async () => chatResult())
    const provider = createPersonalModelProvider(settings, 'personal-v1', fetchImplementation)
    await expect(provider.generate(request, new AbortController().signal)).resolves.toMatchObject({ usage: { inputTokens: 20, outputTokens: 8 } })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    const [input, init] = fetchImplementation.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(input)).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(300)
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages[0].content).toContain('JSON Schema:')
    expect(body.messages[0].content).toContain('"required":["text"]')
  })

  it('preserves strict Responses and custom model choices with unchanged domain contracts', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output_text: '{"text":"ok"}', usage: { input_tokens: 1, output_tokens: 1 } })))
    const provider = createPersonalModelProvider({ ...settings, providerId: 'openai', modelId: 'my-model-alias', protocol: 'responses', structuredOutput: 'json_schema' }, 'personal-v2', fetchImplementation)
    await provider.generate(request, new AbortController().signal)
    const [, init] = fetchImplementation.mock.calls[0] as unknown as [URL, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'my-model-alias', max_output_tokens: 300, store: false, text: { format: { type: 'json_schema', strict: true } } })
    expect(() => createPersonalModelProvider({ ...settings, apiKey: undefined }, 'v1')).toThrow()
  })

  it('recognizes a manual OpenAI endpoint token field without raising limits or sending a paid probe', async () => {
    const fetchImplementation = vi.fn(async () => chatResult())
    const provider = createPersonalModelProvider({ ...settings, providerId: 'custom', baseUrl: 'https://api.openai.com', modelId: 'gpt-6.1-sol' }, 'personal-v4', fetchImplementation)
    await provider.generate(request, new AbortController().signal)
    const [input, init] = fetchImplementation.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(input)).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({ max_completion_tokens: 300 })
    expect(provider.capabilities.maxOutputTokens).toBe(4_096)
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('does not invent usage or repeat when a compatible endpoint omits billing facts', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"ok"}' }, finish_reason: 'stop' }] })))
    const provider = createPersonalModelProvider(settings, 'personal-v3', fetchImplementation)
    await expect(provider.generate(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid_response', acceptance: 'accepted', usage: undefined, retryable: false })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('does not count rounded unsafe usage as a reliable billing fact', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"text":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1 },
    })))
    await expect(createPersonalModelProvider(settings, 'unsafe-usage', fetchImplementation).generate(request, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid_response', acceptance: 'accepted', usage: undefined })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('keeps accepted oversized replies distinct from a DNS rejection and never replays either', async () => {
    for (const [safeCode, acceptance, kind] of [['response_too_large', 'accepted', 'response_too_large'], ['endpoint_dns_private_network', 'not_accepted', 'rejected']] as const) {
      const fetchImplementation = vi.fn(async () => { throw new ProviderConnectionError(safeCode, acceptance) })
      const provider = createPersonalModelProvider(settings, 'safe-failure', fetchImplementation)
      await expect(provider.generate(request, new AbortController().signal)).rejects.toMatchObject({ acceptance, kind, retryable: false })
      expect(fetchImplementation).toHaveBeenCalledOnce()
    }
  })

  it.each([
    ['qwen', 'qwen3.7-plus', { enable_thinking: false }],
    ['qwen', 'qwen3.8-max', { enable_thinking: false }],
    ['moonshot', 'kimi-k2.6', { thinking: { type: 'disabled' } }],
    ['moonshot', 'kimi-k3', {}],
    ['qwen', 'unknown-qwen-model', {}],
    ['zhipu', 'glm-5.3', {}],
  ])('uses only documented thinking switches for %s / %s', async (providerId, modelId, expected) => {
    const fetchImplementation = vi.fn(async () => chatResult())
    const provider = createPersonalModelProvider({ ...settings, providerId, modelId }, 'personal-thinking', fetchImplementation)
    await provider.generate(request, new AbortController().signal)
    const [, init] = fetchImplementation.mock.calls[0] as unknown as [URL, RequestInit]
    const body = JSON.parse(String(init.body))
    if (Object.keys(expected).length) expect(body).toMatchObject(expected)
    else { expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('enable_thinking') }
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('discovers bounded account model names using GET only, deduplicates and omits unsafe labels', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'custom/model', name: 'Custom model' }, { id: 'custom/model', name: 'Custom model' },
      { id: 'bad model' }, { id: 'another-model' },
    ] })))
    await expect(fetchProviderModels({ ...settings, fetchImplementation })).resolves.toEqual([{ id: 'another-model' }, { id: 'custom/model', label: 'Custom model' }])
    expect(fetchImplementation).toHaveBeenCalledOnce()
    const [input, init] = fetchImplementation.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(input)).toBe('https://api.deepseek.com/models')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.body).toBeUndefined()
  })

  it('discards provider metadata that echoes the credential sent in its request', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'synthetic-key', name: 'A credential in model identity' },
      { id: 'safe-id', name: 'Model containing synthetic-key' },
      { id: 'clean-id', name: 'Clean model', extra: 'synthetic-key' },
    ] })))
    const result = await fetchProviderModels({ ...settings, fetchImplementation })
    expect(result).toEqual([{ id: 'clean-id', label: 'Clean model' }])
    expect(JSON.stringify(result)).not.toContain(settings.apiKey)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    const localResult = await fetchProviderModels({ baseUrl: 'http://127.0.0.1:11434/v1', networkMode: 'local-loopback',
      fetchImplementation: async () => new Response(JSON.stringify({ data: [{ id: 'ollama-model', name: 'Ollama installed model' }] })) })
    expect(localResult).toEqual([{ id: 'ollama-model', label: 'Ollama installed model' }])
  })

  it.each([[401, 'credentials_rejected'], [403, 'credentials_rejected'], [404, 'models_unsupported'], [405, 'models_unsupported'], [429, 'models_rate_limited'], [503, 'models_unavailable']])('classifies model discovery HTTP %i without provider content leakage', async (status, safeCode) => {
    const fetchImplementation = vi.fn(async () => new Response('secret synthetic-key', { status: Number(status) }))
    const error = await fetchProviderModels({ ...settings, fetchImplementation }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ safeCode })
    expect(String(error)).not.toContain('synthetic-key')
  })

  it('rejects malformed and oversized model discovery without unbounded reads', async () => {
    await expect(fetchProviderModels({ ...settings, fetchImplementation: async () => new Response('not-json') })).rejects.toMatchObject({ safeCode: 'models_response_invalid' })
    await expect(fetchProviderModels({ ...settings, fetchImplementation: async () => new Response(JSON.stringify({ data: 'invalid' })) })).rejects.toMatchObject({ safeCode: 'models_response_invalid' })
    await expect(fetchProviderModels({ ...settings, fetchImplementation: async () => new Response('x', { headers: { 'content-length': '512001' } }) })).rejects.toMatchObject({ safeCode: 'models_response_too_large' })
    await expect(fetchProviderModels({ ...settings, fetchImplementation: async () => new Response('x'.repeat(512_001)) })).rejects.toMatchObject({ safeCode: 'models_response_too_large' })
  })

  it('does not send while DNS remains pending and handles resolver failure without exposing its error', async () => {
    const resolveFailure = new Error('private DNS infrastructure detail synthetic-key')
    await expect(resolveProviderAddresses(new URL('https://api.example.com/v1/'), 'public', async () => { throw resolveFailure })).rejects.toMatchObject({ safeCode: 'endpoint_dns_failed' })
    const controller = new AbortController()
    const pinnedFetch = createPinnedProviderFetch({ baseUrl: 'https://api.example.com/v1/', maxResponseBytes: 1_024,
      resolver: async () => new Promise<never>(() => undefined) })
    const result = pinnedFetch('https://api.example.com/v1/models', { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ safeCode: 'request_aborted' })
    await expect(pinnedFetch('https://api.example.com/v1/models', { body: new Uint8Array(1) })).rejects.toMatchObject({ safeCode: 'request_body_invalid' })
  })

  it('bounds the actual pinned HTTP response instead of buffering an untrusted stream', async () => {
    const server = createServer((_incoming, response) => { response.writeHead(200, { 'content-length': '2048' }); response.end('x'.repeat(2_048)) })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address missing')
    const baseUrl = `http://127.0.0.1:${address.port}/v1/`
    await expect(createPinnedProviderFetch({ baseUrl, networkMode: 'local-loopback', maxResponseBytes: 1_024 })(`${baseUrl}models`)).rejects.toMatchObject({ safeCode: 'response_too_large' })
  })

  it('pins localhost resolution to the checked socket, supports local no-key models and rejects redirects', async () => {
    const received: Array<{ path: string; authorization?: string }> = []
    const server = createServer((incoming, response) => {
      received.push({ path: incoming.url ?? '', authorization: incoming.headers.authorization })
      if (incoming.url === '/v1/responses') { response.writeHead(302, { location: 'http://169.254.169.254/' }); response.end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'installed-model' }] }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address missing')
    const baseUrl = `http://localhost:${address.port}/v1/`
    const resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const pinnedFetch = createPinnedProviderFetch({ baseUrl, networkMode: 'local-loopback', maxResponseBytes: 1_024, resolver })
    await expect(fetchProviderModels({ baseUrl, networkMode: 'local-loopback', fetchImplementation: pinnedFetch })).resolves.toEqual([{ id: 'installed-model' }])
    expect(received).toEqual([{ path: '/v1/models', authorization: undefined }])
    expect(resolver).toHaveBeenCalledOnce()
    await expect(pinnedFetch(new URL('responses', baseUrl))).rejects.toMatchObject({ safeCode: 'redirect_not_allowed' })
    expect(received).toHaveLength(2)
    await expect(pinnedFetch('http://127.0.0.1:1/v1/models')).rejects.toMatchObject({ safeCode: 'request_endpoint_changed' })
    await expect(pinnedFetch(new URL('models', baseUrl), { signal: AbortSignal.abort() })).rejects.toMatchObject({ safeCode: 'request_aborted' })
  })

  it('keeps directly configured strict adapters bounded when passed a full endpoint', async () => {
    const provider = new OpenAICompatibleProvider({ id: 'direct', modelId: 'model', profileVersion: 'v1', apiStyle: 'chat-completions',
      baseUrl: 'https://api.example.com/v1/chat/completions', allowedHosts: ['api.example.com'], apiKey: 'fixture',
      requestTimeoutMs: 1_000, maxInputCharacters: 1_000, maxOutputTokens: 500, maxResponseBytes: 1_024, fetchImplementation: async () => chatResult() })
    await expect(provider.generate(request, new AbortController().signal)).resolves.toMatchObject({ outputText: '{"text":"grounded"}' })
  })
})
