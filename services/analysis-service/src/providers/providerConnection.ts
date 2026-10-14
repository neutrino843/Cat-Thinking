import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import type { PersonalProviderModel, ProviderNetworkMode } from '@cat-thinking/analysis-contracts'
import { personalProviderModelSchema } from '@cat-thinking/analysis-contracts'
import type { FetchImplementation } from './openAICompatibleProvider.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const FORBIDDEN_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.test', '.invalid']
const FORBIDDEN_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.internal'])

export class ProviderConnectionError extends Error {
  constructor(readonly safeCode: string, readonly acceptance: 'not_accepted' | 'accepted' | 'unknown' = 'not_accepted') {
    const messages: Readonly<Record<string, string>> = {
      endpoint_invalid: 'provider base URL is invalid',
      endpoint_requires_https: 'provider base URL must use HTTPS',
      endpoint_private_fields: 'provider base URL must not contain credentials, query, or fragment',
      endpoint_host_not_allowed: 'provider base URL host is not allowlisted',
    }
    super(messages[safeCode] ?? 'provider connection could not be validated')
    this.name = 'ProviderConnectionError'
  }
}

export const isPublicProviderAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (family === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
    // Accept global unicast only; translated/mapped IPv4 and special networks
    // cannot use an IPv6 spelling to cross the private-network boundary.
    return /^[23][0-9a-f]{3}:/u.test(normalized)
      && !/^2001:(?::|0:|db8:|10:|20:)/u.test(normalized)
      && !/^2002:/u.test(normalized)
      && !/^3fff:/u.test(normalized)
  }
  return false
}

export const normalizeProviderBaseUrl = (
  value: string,
  options: Readonly<{ networkMode?: ProviderNetworkMode; allowedHosts?: readonly string[] }> = {},
): string => {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new ProviderConnectionError('endpoint_invalid') }
  if (url.username || url.password || url.search || url.hash) throw new ProviderConnectionError('endpoint_private_fields')
  const networkMode = options.networkMode ?? 'public'
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  url.hostname = hostname
  if (networkMode === 'local-loopback') {
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(hostname)) {
      throw new ProviderConnectionError('endpoint_requires_loopback')
    }
  } else {
    if (url.protocol !== 'https:') throw new ProviderConnectionError('endpoint_requires_https')
    const address = hostname.replace(/^\[|\]$/gu, '')
    if (LOOPBACK_HOSTS.has(hostname) || FORBIDDEN_HOSTS.has(hostname)
      || FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
      || (!hostname.includes('.') && !isIP(address))
      || (isIP(address) && !isPublicProviderAddress(address))) {
      throw new ProviderConnectionError('endpoint_private_network')
    }
  }
  if (options.allowedHosts && !options.allowedHosts.some((host) => host.toLowerCase() === url.host.toLowerCase())) {
    throw new ProviderConnectionError('endpoint_host_not_allowed')
  }
  let pathname = url.pathname.replace(/\/+$/u, '')
  pathname = pathname.replace(/\/(?:chat\/completions|responses|models)$/u, '')
  pathname = pathname.replace(/(?:\/v1){2,}$/u, '/v1')
  if (!pathname) {
    const knownPaths: Readonly<Record<string, string>> = {
      'api.openai.com': '/v1',
      'api.moonshot.cn': '/v1',
      'api.moonshot.ai': '/v1',
      'api.siliconflow.cn': '/v1',
      'dashscope.aliyuncs.com': '/compatible-mode/v1',
      'open.bigmodel.cn': '/api/paas/v4',
      'generativelanguage.googleapis.com': '/v1beta/openai',
    }
    pathname = knownPaths[hostname] ?? ''
  }
  url.pathname = `${pathname}/`
  return url.toString()
}

export interface ProviderResolvedAddress { readonly address: string; readonly family: 4 | 6 }
export type ProviderAddressResolver = (hostname: string) => Promise<readonly ProviderResolvedAddress[]>
const defaultResolver: ProviderAddressResolver = async (hostname) => (await lookup(hostname, { all: true }))
  .map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 as const : 4 as const }))

export const resolveProviderAddresses = async (
  url: URL,
  networkMode: ProviderNetworkMode,
  resolver: ProviderAddressResolver = defaultResolver,
): Promise<readonly ProviderResolvedAddress[]> => {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(hostname)
  let addresses: readonly ProviderResolvedAddress[]
  try { addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await resolver(hostname) }
  catch { throw new ProviderConnectionError('endpoint_dns_failed') }
  if (addresses.length === 0 || addresses.length > 64 || addresses.some((entry) => (
    isIP(entry.address) !== entry.family || (networkMode === 'local-loopback'
      ? !['127.0.0.1', '::1'].includes(entry.address) : !isPublicProviderAddress(entry.address))
  ))) throw new ProviderConnectionError('endpoint_dns_private_network')
  return addresses
}

const awaitProviderResolution = async (
  resolution: Promise<readonly ProviderResolvedAddress[]>,
  signal?: AbortSignal | null,
): Promise<readonly ProviderResolvedAddress[]> => {
  if (!signal) return resolution
  let abort: (() => void) | undefined
  try {
    return await Promise.race([resolution, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ProviderConnectionError('request_aborted'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

/** A separate resolution is performed for each request, then the TLS socket is
 * pinned to that checked address. The original hostname remains the SNI and
 * certificate identity; neither redirects nor proxy environment variables run. */
export const createPinnedProviderFetch = (options: Readonly<{
  baseUrl: string
  networkMode?: ProviderNetworkMode
  maxResponseBytes: number
  resolver?: ProviderAddressResolver
}>): FetchImplementation => {
  const networkMode = options.networkMode ?? 'public'
  const baseUrl = new URL(normalizeProviderBaseUrl(options.baseUrl, { networkMode }))
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname) || url.search || url.hash) {
      throw new ProviderConnectionError('request_endpoint_changed')
    }
    if (init.signal?.aborted) throw new ProviderConnectionError('request_aborted')
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new ProviderConnectionError('request_body_invalid')
    const addresses = await awaitProviderResolution(resolveProviderAddresses(url, networkMode, options.resolver), init.signal)
    if (init.signal?.aborted) throw new ProviderConnectionError('request_aborted')
    const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0]
    if (!pinned) throw new ProviderConnectionError('endpoint_dns_empty')
    return new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest
      const connectionOptions: RequestOptions & { autoSelectFamily: boolean } = {
        method: init.method ?? 'GET', headers, signal: init.signal ?? undefined, agent: false, autoSelectFamily: false,
        lookup: (_hostname, _lookupOptions, callback) => callback(null, pinned.address, pinned.family),
      }
      const connection = send(url, connectionOptions, (incoming) => {
        const status = incoming.statusCode ?? 502
        if (status >= 300 && status < 400) {
          incoming.destroy()
          reject(new ProviderConnectionError('redirect_not_allowed', 'unknown'))
          return
        }
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const declaredLength = Number(responseHeaders.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > options.maxResponseBytes) {
          incoming.destroy()
          reject(new ProviderConnectionError('response_too_large', status >= 200 && status < 300 ? 'accepted' : 'unknown'))
          return
        }
        const chunks: Uint8Array[] = []
        let received = 0
        incoming.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > options.maxResponseBytes) {
            incoming.destroy(new ProviderConnectionError('response_too_large', status >= 200 && status < 300 ? 'accepted' : 'unknown'))
          } else chunks.push(chunk)
        })
        incoming.on('error', reject)
        incoming.on('aborted', () => reject(new ProviderConnectionError('response_lost')))
        incoming.on('end', () => {
          const bytes = new Uint8Array(received)
          let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
          resolve(new Response([204, 205, 304].includes(status) ? null : bytes, { status, headers: responseHeaders }))
        })
      })
      connection.on('error', reject)
      connection.end(init.body ?? undefined)
    })
  }
}

const modelEnvelopeSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()).max(500),
}).passthrough()

const readModelResponse = async (response: Response): Promise<string> => {
  const maximumBytes = 512_000
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new ProviderConnectionError('models_response_too_large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      received += part.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ProviderConnectionError('models_response_too_large')
      }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new ProviderConnectionError('models_response_invalid') }
}

export const fetchProviderModels = async (options: Readonly<{
  baseUrl: string
  apiKey?: string
  networkMode: ProviderNetworkMode
  requestTimeoutMs?: number
  fetchImplementation?: FetchImplementation
}>, signal?: AbortSignal): Promise<PersonalProviderModel[]> => {
  const baseUrl = normalizeProviderBaseUrl(options.baseUrl, { networkMode: options.networkMode })
  const fetchImplementation = options.fetchImplementation ?? createPinnedProviderFetch({
    baseUrl, networkMode: options.networkMode, maxResponseBytes: 512_000,
  })
  const timeoutMs = options.requestTimeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new ProviderConnectionError('timeout_invalid')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const response = await fetchImplementation(new URL('models', baseUrl), {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
    })
    if (!response.ok || response.redirected) throw new ProviderConnectionError(
      response.redirected ? 'redirect_not_allowed'
        : [401, 403].includes(response.status) ? 'credentials_rejected'
          : [404, 405].includes(response.status) ? 'models_unsupported'
            : response.status === 429 ? 'models_rate_limited' : 'models_unavailable',
    )
    const text = await readModelResponse(response)
    let payload: unknown
    try { payload = JSON.parse(text) } catch { throw new ProviderConnectionError('models_response_invalid') }
    const parsed = modelEnvelopeSchema.safeParse(payload)
    if (!parsed.success) throw new ProviderConnectionError('models_response_invalid')
    const unique = new Map<string, PersonalProviderModel>()
    for (const entry of parsed.data.data) {
      // A provider response is untrusted metadata. It must not turn the secret
      // sent in the Authorization header into a browser-visible model label.
      if (options.apiKey && (entry.id.includes(options.apiKey) || entry.name?.includes(options.apiKey))) continue
      const model = personalProviderModelSchema.safeParse({ id: entry.id, ...(entry.name ? { label: entry.name } : {}) })
      if (model.success) unique.set(model.data.id, model.data)
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
  } catch (error) {
    if (error instanceof ProviderConnectionError) throw error
    throw new ProviderConnectionError(controller.signal.aborted ? 'connection_timeout' : 'connection_failed')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
