// @vitest-environment node
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserGateway, validateBrowserGatewayConfig, type BrowserGatewayConfig } from '../src/api/browserGateway.js'

const config: BrowserGatewayConfig = { upstream: 'http://127.0.0.1:8787', token: 'x'.repeat(40), tenantId: 'trusted-local', origins: ['http://localhost:5173'] }
function exchange(options: { method?: string; url?: string; headers?: IncomingMessage['headers']; body?: string; remote?: string; backpressure?: boolean } = {}) {
  const request = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as IncomingMessage
  Object.assign(request, { url: options.url ?? '/api/analysis/v1/capabilities', method: options.method ?? 'GET', headers: { host: 'localhost:5173', ...options.headers }, socket: { remoteAddress: options.remote ?? '127.0.0.1' } })
  const chunks: Buffer[] = []
  let status = 0
  let headers: Record<string, unknown> = {}
  const response = new Writable({ highWaterMark: options.backpressure ? 1 : 16384, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }) as unknown as ServerResponse
  response.writeHead = ((code: number, values: Record<string, unknown>) => { status = code; headers = values; Object.assign(response, { headersSent: true }); return response }) as ServerResponse['writeHead']
  response.flushHeaders = () => {}
  return { request, response, get status() { return status }, get headers() { return headers }, text: () => Buffer.concat(chunks).toString() }
}
const json = (value: unknown = { acceptsRuns: false }, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'set-cookie': 'private-token=never-forward' } })
describe('trusted loopback browser gateway', () => {
  it('forwards personal setup only through fixed authenticated routes, including credential deletion CAS', async () => {
    const fetcher = vi.fn(async () => json({ version: 1, hasApiKey: true }))
    for (const [method, path] of [['GET', '/personal/settings'], ['PUT', '/personal/settings'],
      ['POST', '/personal/models'], ['POST', '/personal/check'], ['POST', '/personal/enable'],
      ['POST', '/personal/pause'], ['POST', '/personal/chat'], ['DELETE', '/personal/settings']] as const) {
      const body = method === 'GET' ? undefined : JSON.stringify({ version: 1, expectedRevision: 7 })
      const e = exchange({ method, url: `/api/analysis/v1${path}`, body,
        headers: { authorization: 'Bearer browser-forged', 'x-cat-tenant-id': 'other', ...(body ? { 'content-type': 'application/json' } : {}) } })
      await createBrowserGateway(config, fetcher)(e.request, e.response)
      expect(e.status).toBe(200)
      const [target, init] = fetcher.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect(target).toBe(`http://127.0.0.1:8787/api/analysis/v1${path}`)
      expect(new Headers(init.headers).get('x-cat-tenant-id')).toBe('trusted-local')
      if (method === 'DELETE') expect(Buffer.from(init.body as Buffer).toString()).toBe(body)
      expect(e.text()).not.toContain(config.token)
    }
    const before = fetcher.mock.calls.length
    for (const url of ['/api/analysis/v1/personal/settings?target=https://evil.test', '/api/analysis/v1/personal/../../private',
      '/api/analysis/v1/personal/import', '/api/analysis/v1/personal/models?apiKey=secret']) {
      const e = exchange({ url })
      await createBrowserGateway(config, fetcher)(e.request, e.response)
      expect(e.status).toBe(404)
    }
    expect(fetcher).toHaveBeenCalledTimes(before)
  })
  it('forwards version-bound chat through real loopback HTTP with trusted identity', async () => {
    const payload = JSON.stringify({ question: '公开测试', context: '', expectedRevision: 14 })
    let received: { url?: string; authorization?: string; tenant?: string | string[]; body: string } | undefined
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received = { url: request.url, authorization: request.headers.authorization, tenant: request.headers['x-cat-tenant-id'], body: Buffer.concat(chunks).toString() }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ answer: '合成连接成功', local: false }))
    })
    const gatewayServer = createServer()
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`
      const gateway = createBrowserGateway({ ...config, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, origins: [origin] })
      gatewayServer.on('request', (request, response) => { void gateway(request, response) })
      const result = await fetch(`${origin}/api/analysis/v1/personal/chat`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json', authorization: 'Bearer forged', 'x-cat-tenant-id': 'forged' }, body: payload })
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ answer: '合成连接成功', local: false })
      expect(received).toEqual({ url: '/api/analysis/v1/personal/chat', authorization: `Bearer ${config.token}`, tenant: config.tenantId, body: payload })
      for (const [method, suffix] of [['GET', '/personal/chat'], ['POST', '/personal/chat?target=other'], ['POST', '/personal/chat/extra']]) {
        const rejected = await fetch(`${origin}/api/analysis/v1${suffix}`, { method, headers: { origin, 'content-type': 'application/json' } })
        expect(rejected.status).toBe(404)
        await rejected.text()
      }
    } finally {
      gatewayServer.closeAllConnections(); upstream.closeAllConnections()
      await Promise.all([new Promise<void>((resolve) => gatewayServer.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))])
    }
  })
  it('lets chat inference exceed 30 seconds but bounds it at 125 seconds after upload', async () => {
    vi.useFakeTimers()
    try {
      const e = exchange({ method: 'POST', url: '/api/analysis/v1/personal/chat', body: '{}', headers: { 'content-type': 'application/json' } })
      const pending = createBrowserGateway(config, async () => {
        await new Promise((resolve) => setTimeout(resolve, 45000))
        return json({ answer: 'done' })
      })(e.request, e.response)
      await vi.advanceTimersByTimeAsync(45000)
      await pending
      expect(e.status).toBe(200)
      const slow = exchange({ method: 'POST', url: '/api/analysis/v1/personal/chat', body: '{}', headers: { 'content-type': 'application/json' } })
      const timeout = createBrowserGateway(config, async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
      }))(slow.request, slow.response)
      await vi.advanceTimersByTimeAsync(125000)
      await timeout
      expect(slow.status).toBe(504)
      expect(slow.response.writableEnded).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('allows only one contract-valid requestKey query and readonly usage plus abandon routes', async () => {
    const fetcher = vi.fn(async () => json({ status: 'absent' }))
    const key = 'a'.repeat(64)
    for (const route of [`/runs/by-request-key?requestKey=${key}`, '/runs/run-1/usage']) {
      const e = exchange({ url: `/api/analysis/v1${route}` })
      await createBrowserGateway(config, fetcher)(e.request, e.response)
      expect(e.status).toBe(200)
    }
    for (const query of [`requestKey=${key}&requestKey=${key}`, `requestKey=${key}&upstream=private`, 'requestKey=short']) {
      const e = exchange({ url: `/api/analysis/v1/runs/by-request-key?${query}` })
      await createBrowserGateway(config, fetcher)(e.request, e.response)
      expect(e.status).toBe(400)
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
    const abandon = exchange({ method: 'POST', url: '/api/analysis/v1/runs/abandon', body: JSON.stringify({ version: 1, requestKey: key }), headers: { 'content-type': 'application/json' } })
    await createBrowserGateway(config, fetcher)(abandon.request, abandon.response)
    expect(abandon.status).toBe(200)
  })
  it('overwrites browser identity and strips cookies, proxy and arbitrary headers', async () => {
    const fetcher = vi.fn(async () => json())
    const e = exchange({ headers: { authorization: 'Bearer forged', 'x-cat-tenant-id': 'other', cookie: 'session=forged', 'x-forwarded-host': 'evil.test', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' } })
    await createBrowserGateway(config, fetcher)(e.request, e.response)
    expect(e.status).toBe(200)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/api/analysis/v1/capabilities')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${config.token}`)
    expect(headers.get('x-cat-tenant-id')).toBe('trusted-local')
    for (const name of ['cookie', 'x-forwarded-host', 'origin']) expect(headers.has(name)).toBe(false)
    expect(e.headers).not.toHaveProperty('set-cookie')
    expect(e.text()).not.toContain(config.token)
  })
  it.each([
    { headers: { host: 'attacker.test' } }, { headers: { origin: 'http://attacker.test' } },
    { headers: { 'sec-fetch-site': 'cross-site' } }, { remote: '10.0.0.1' }, { headers: { host: '' } },
  ])('rejects untrusted origins, hosts and remote clients before forwarding: %j', async (options) => {
    const fetcher = vi.fn(async () => json()); const e = exchange(options)
    await createBrowserGateway(config, fetcher)(e.request, e.response)
    expect(e.status).toBe(403); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['/api/analysis/v1/../../private', '/api/analysis/v1/runs/id?upstream=evil', '/other', '/api/analysis/v1/runs/id/%2e%2e', '/api/analysis/v1/__synthetic/gate'])('keeps a fixed target and route allowlist: %s', async (url) => {
    const e = exchange({ url }); await createBrowserGateway(config)(e.request, e.response); expect(e.status).toBe(404)
  })
  it('streams JSON uploads with a byte limit and does not follow upstream redirects', async () => {
    const fetcher = vi.fn(async () => json({}, 409))
    const e = exchange({ method: 'PUT', url: '/api/analysis/v1/runs/run-1/sources/source-1', body: '{"text":"🌱"}', headers: { 'content-type': 'application/json' } })
    await createBrowserGateway(config, fetcher)(e.request, e.response)
    expect(e.status).toBe(409)
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(Buffer.from(init.body as Buffer).toString()).toBe('{"text":"🌱"}')
    expect(init.redirect).toBe('manual')
    for (const options of [
      { headers: { 'content-type': 'text/plain' }, expected: 415 },
      { headers: { 'content-type': 'application/json', 'content-length': '2100001' }, expected: 413 },
      { headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_100_001), expected: 413 },
    ]) {
      const limited = exchange({ method: 'POST', url: '/api/analysis/v1/runs', ...options })
      await createBrowserGateway(config, fetcher)(limited.request, limited.response)
      expect(limited.status).toBe(options.expected)
    }
    const redirect = exchange()
    await createBrowserGateway(config, async () => new Response('', { status: 302, headers: { 'content-type': 'application/json', location: 'https://evil.test' } }))(redirect.request, redirect.response)
    expect(redirect.status).toBe(502)
  })
  it('forwards SSE cursor with backpressure and closes upstream readers on disconnect', async () => {
    let upstreamSignal: AbortSignal | undefined
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('id: event-1\ndata: {}\n\n')); controller.close() } })
    const e = exchange({ url: '/api/analysis/v1/runs/run-1/events', headers: { 'last-event-id': 'event-0' }, backpressure: true })
    await createBrowserGateway(config, async (_url, init) => {
      expect(new Headers(init?.headers).get('last-event-id')).toBe('event-0')
      upstreamSignal = init?.signal ?? undefined
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })(e.request, e.response)
    expect(e.text()).toContain('id: event-1'); expect(upstreamSignal?.aborted).toBe(true)
    const invalid = exchange({ headers: { 'last-event-id': ['one', 'two'] } })
    await createBrowserGateway(config)(invalid.request, invalid.response); expect(invalid.status).toBe(400)
    const disconnect = exchange()
    const fetcher = vi.fn(async (_url, init) => {
      disconnect.response.destroy()
      await new Promise<void>((resolve) => { if (init?.signal?.aborted) resolve(); else init?.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      throw new Error('disconnected')
    }) as typeof fetch
    await createBrowserGateway(config, fetcher)(disconnect.request, disconnect.response)
    expect(disconnect.response.destroyed).toBe(true)
  })
  it('fails closed with bounded response, unavailable upstream, missing configuration or invalid configuration', async () => {
    const off = exchange(); await createBrowserGateway(undefined)(off.request, off.response); expect(off.status).toBe(503)
    const failed = exchange(); await createBrowserGateway(config, async () => { throw new Error('secret') })(failed.request, failed.response); expect(failed.status).toBe(502); expect(failed.text()).not.toContain('secret')
    const html = exchange(); await createBrowserGateway(config, async () => new Response('html'))(html.request, html.response); expect(html.status).toBe(502)
    const huge = exchange(); await createBrowserGateway(config, async () => new Response('x'.repeat(2_100_001), { headers: { 'content-type': 'application/json' } }))(huge.request, huge.response); expect(huge.response.destroyed).toBe(true)
    const empty = exchange(); await createBrowserGateway(config, async () => new Response(null, { headers: { 'content-type': 'application/json' } }))(empty.request, empty.response); expect(empty.status).toBe(200)
    for (const candidate of [ { ...config, token: 'short' }, { ...config, upstream: 'https://example.test' }, { ...config, upstream: 'http://localhost:8787/private' }, { ...config, tenantId: '../other' }, { ...config, origins: [] }, { ...config, origins: ['http://evil.test'] } ]) expect(() => validateBrowserGatewayConfig(candidate)).toThrow()
  })
  it('ends a timed-out request rather than leaving a hanging browser response', async () => {
    vi.useFakeTimers()
    try {
      const e = exchange()
      const pending = createBrowserGateway(config, async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
      }))(e.request, e.response)
      await vi.advanceTimersByTimeAsync(30000)
      await pending
      expect(e.status).toBe(504)
      expect(e.response.writableEnded).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it.each(['/runs', '/personal/chat'])('bounds an unfinished upload and never forwards a partial body: %s', async (path) => {
    vi.useFakeTimers()
    try {
      const e = exchange({ method: 'POST', url: `/api/analysis/v1${path}`, headers: { 'content-type': 'application/json' } })
      const unfinished = new Readable({ read() { /* Simulate a client that never finishes its body. */ } }) as IncomingMessage
      Object.assign(unfinished, { url: e.request.url, method: e.request.method, headers: e.request.headers, socket: e.request.socket })
      const fetcher = vi.fn(async () => json())
      const pending = createBrowserGateway(config, fetcher)(unfinished, e.response)
      await vi.advanceTimersByTimeAsync(30000)
      await pending
      expect(unfinished.destroyed).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
      expect(e.status).toBe(504)
    } finally { vi.useRealTimers() }
  })
})
