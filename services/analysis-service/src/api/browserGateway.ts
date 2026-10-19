import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { identifierSchema, lookupRunByRequestKeyQuerySchema } from '@cat-thinking/analysis-contracts'

const PREFIX = '/api/analysis/v1'
const MAX_BODY = 2_100_000
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const ROUTES: readonly [string, RegExp][] = [
  ['GET', /^\/personal\/settings$/u], ['PUT', /^\/personal\/settings$/u], ['DELETE', /^\/personal\/settings$/u],
  ['POST', /^\/personal\/(?:models|check|enable|pause|chat)$/u],
  ['GET', /^\/capabilities$/u], ['POST', /^\/runs$/u],
  ['POST', /^\/runs\/abandon$/u],
  ['GET', /^\/runs\/[A-Za-z0-9._:-]+(?:\/(?:events|usage))?$/u],
  ['POST', /^\/runs\/[A-Za-z0-9._:-]+\/(?:start|cancel)$/u],
  ['PUT', /^\/runs\/[A-Za-z0-9._:-]+\/sources\/[A-Za-z0-9._:-]+$/u],
  ['GET', /^\/runs\/[A-Za-z0-9._:-]+\/artifacts\/(?:summary|outline|mindmap|quiz|knowledge)$/u],
  ['POST', /^\/runs\/[A-Za-z0-9._:-]+\/artifacts\/(?:summary|outline|mindmap|quiz|knowledge)\/retry$/u],
  ['DELETE', /^\/runs\/[A-Za-z0-9._:-]+\/content$/u],
]

/** Single-user local gateway only. Public deployment requires a trusted session identity resolver. */
export interface BrowserGatewayConfig {
  upstream: string
  token: string
  tenantId: string
  origins: readonly string[]
}

export function validateBrowserGatewayConfig(config: BrowserGatewayConfig): BrowserGatewayConfig {
  const upstream = new URL(config.upstream)
  const localUrl = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  if (!localUrl(upstream) || !/^[A-Za-z0-9_-]{32,256}$/u.test(config.token)
    || !identifierSchema.safeParse(config.tenantId).success || !config.origins.length
    || config.origins.some((origin) => !localUrl(new URL(origin)) || new URL(origin).origin !== origin)) {
    throw new Error('Invalid local analysis gateway configuration')
  }
  return { ...config, upstream: upstream.origin, origins: [...config.origins] }
}

function reject(response: ServerResponse, status: number): void {
  if (response.destroyed) return
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: 'Analysis gateway request unavailable' }))
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  // Abort the stream itself: cancelling only fetch cannot stop an unfinished upload.
  const stopReading = () => request.destroy()
  signal.throwIfAborted()
  signal.addEventListener('abort', stopReading, { once: true })
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      bytes += buffer.length
      if (bytes > MAX_BODY) throw new RangeError('Request exceeds gateway limit')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  } finally { signal.removeEventListener('abort', stopReading) }
}

/** All forwarded headers are constructed here; browser bearer/tenant/proxy headers are discarded. */
export function createBrowserGateway(input: BrowserGatewayConfig | undefined, fetcher: typeof fetch = fetch) {
  const config = input && validateBrowserGatewayConfig(input)
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!config) { reject(response, 503); return }
    const host = request.headers.host
    const origin = request.headers.origin
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '') || !host || !config.origins.includes(`http://${host}`)
      || (origin !== undefined && (typeof origin !== 'string' || origin !== `http://${host}`))
      || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
      reject(response, 403); return
    }
    let suffix = (request.url ?? '').slice(PREFIX.length)
    if (request.method === 'GET' && suffix.startsWith('/runs/by-request-key?')) {
      const query = new URLSearchParams(suffix.slice('/runs/by-request-key?'.length))
      const decoded = lookupRunByRequestKeyQuerySchema.safeParse(Object.fromEntries(query.entries()))
      if ([...query.keys()].length !== 1 || !decoded.success) { reject(response, 400); return }
      suffix = `/runs/by-request-key?requestKey=${decoded.data.requestKey}`
    }
    const allowedLookup = request.method === 'GET' && /^\/runs\/by-request-key\?requestKey=[a-f0-9]{64}$/u.test(suffix)
    if (!(request.url ?? '').startsWith(PREFIX) || !(allowedLookup || ROUTES.some(([method, route]) => request.method === method && route.test(suffix)))) {
      reject(response, 404); return
    }
    const hasBody = request.method === 'PUT' || request.method === 'POST'
      || request.method === 'DELETE' && suffix === '/personal/settings'
    if (hasBody && request.headers['content-type'] !== 'application/json') { reject(response, 415); return }
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) { reject(response, 413); return }
    const abort = new AbortController()
    const disconnected = () => abort.abort()
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    const streaming = suffix.endsWith('/events')
    let timedOut = false
    const expire = () => { timedOut = true; disconnected() }
    let timer = setTimeout(expire, streaming ? 30 * 60_000 : 30_000)
    timer.unref()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const body = hasBody ? await readBody(request, abort.signal) : undefined
      // Bound uploads independently; model inference can legitimately take
      // longer than other JSON operations (the provider itself has 120s).
      if (suffix === '/personal/chat') {
        clearTimeout(timer)
        timer = setTimeout(expire, 125_000)
        timer.unref()
      }
      const headers = new Headers({ authorization: `Bearer ${config.token}`, 'x-cat-tenant-id': config.tenantId,
        accept: streaming ? 'text/event-stream' : 'application/json' })
      if (hasBody) headers.set('content-type', 'application/json')
      const cursor = request.headers['last-event-id']
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !identifierSchema.safeParse(cursor).success) { reject(response, 400); return }
        headers.set('last-event-id', cursor)
      }
      const upstream = await fetcher(`${config.upstream}${PREFIX}${suffix}`, {
        method: request.method, headers, body, signal: abort.signal, redirect: 'manual',
      })
      const type = upstream.headers.get('content-type') ?? ''
      if (upstream.status >= 300 && upstream.status < 400
        || !(type.startsWith('application/json') || streaming && upstream.ok && type.startsWith('text/event-stream'))) {
        reject(response, 502); return
      }
      response.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
      response.flushHeaders()
      if (upstream.body) {
        reader = upstream.body.getReader()
        let total = 0
        while (!abort.signal.aborted) {
          const chunk = await reader.read()
          if (chunk.done) break
          total += chunk.value.byteLength
          if (!streaming && total > MAX_BODY) throw new RangeError('Response exceeds gateway limit')
          if (!response.write(chunk.value)) await once(response, 'drain', { signal: abort.signal })
        }
      }
      response.end()
    } catch (error) {
      if (timedOut) reject(response, 504)
      else if (!abort.signal.aborted) reject(response, error instanceof RangeError ? 413 : 502)
    } finally {
      abort.abort()
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
      clearTimeout(timer)
      request.removeListener('aborted', disconnected)
      response.removeListener('close', disconnected)
    }
  }
}
