import {
  personalProviderActionSchema,
  personalProviderModelsInputSchema,
  personalProviderModelsResultSchema,
  personalProviderSettingsInputSchema,
  personalProviderStatusSchema,
  type PersonalProviderAction,
  type PersonalProviderModelsInput,
  type PersonalProviderModelsResult,
  type PersonalProviderSettingsInput,
  type PersonalProviderStatus,
} from '@cat-thinking/analysis-contracts'

const SETTINGS_PREFIX = '/api/analysis/v1/personal'
export const MAX_PROVIDER_SETTINGS_RESPONSE_BYTES = 262_144
const DEFAULT_TIMEOUT_MS = 20_000

/** A list hint, never an entitlement check; unknown models remain manually selectable. */
export function isTextModelSuggestion(modelId: string): boolean {
  return !/(?:^|[/:._-])(?:embeddings?|embed|bge|rerank|tts|stt|speech|transcribe|audio|image|imagen|video|whisper|dall[._-]e|flux|stable[._-]diffusion)(?:$|[/:._-]|\d)/iu.test(modelId)
}

function endpointIdentity(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    const path = url.pathname.replace(/\/(?:responses|chat\/completions)\/?$/u, '').replace(/\/+$/u, '')
    return `${url.origin}${path}`
  } catch { return undefined }
}

/** Metadata hint only. The service independently checks endpoint and network binding. */
export function canReuseSavedProviderKey(status: PersonalProviderStatus | undefined, input: Pick<PersonalProviderModelsInput, 'providerId' | 'baseUrl' | 'networkMode'>): boolean {
  if (!status?.hasApiKey || status.providerId !== input.providerId || status.networkMode !== input.networkMode || !status.baseUrl) return false
  const previous = endpointIdentity(status.baseUrl)
  return previous !== undefined && previous === endpointIdentity(input.baseUrl)
}

export type ProviderSettingsErrorCode =
  | 'unavailable' | 'unauthorized' | 'forbidden' | 'conflict' | 'rate_limited'
  | 'invalid_input' | 'invalid_response' | 'response_too_large' | 'network' | 'timeout' | 'rejected'

/** Only fixed, local messages reach the UI. Upstream bodies may contain credentials. */
export class ProviderSettingsClientError extends Error {
  constructor(readonly code: ProviderSettingsErrorCode) {
    super(code)
    this.name = 'ProviderSettingsClientError'
  }
}

const ERROR_TEXT: Record<ProviderSettingsErrorCode, string> = {
  unavailable: 'AI 服务还未连接。请双击「启动猫思之」启动文件，再点「重新连接」。',
  unauthorized: '当前应用与本地 AI 服务的连接已失效，请重新启动应用。',
  forbidden: '当前服务不允许修改这个 AI 连接，请确认正在使用自己的本地服务。',
  conflict: '连接配置已在另一处更新，请重新读取后再保存。',
  rate_limited: '请求过于频繁，请稍后再试。',
  invalid_input: '请检查服务地址、模型名称和 API 密钥。',
  invalid_response: 'AI 服务返回了无法读取的配置，请重新连接或更新本地服务。',
  response_too_large: 'AI 服务返回的数据过大，请稍后重新连接。',
  network: '暂时无法连接 AI 服务，请确认本地服务已经启动。',
  timeout: '连接等待超时，请稍后重试；已保存的配置可以重新读取。',
  rejected: '这次操作未完成。请重新读取配置，确认密钥、模型和服务地址后再试。',
}

export function providerSettingsErrorText(error: unknown): string {
  return error instanceof ProviderSettingsClientError ? ERROR_TEXT[error.code] : ERROR_TEXT.rejected
}

const statusError = (status: number): ProviderSettingsClientError => {
  if (status === 401) return new ProviderSettingsClientError('unauthorized')
  if (status === 403) return new ProviderSettingsClientError('forbidden')
  if (status === 409) return new ProviderSettingsClientError('conflict')
  if (status === 429) return new ProviderSettingsClientError('rate_limited')
  if (status === 404 || status >= 500) return new ProviderSettingsClientError('unavailable')
  if (status === 400 || status === 422) return new ProviderSettingsClientError('invalid_input')
  return new ProviderSettingsClientError('rejected')
}

interface Decoder<T> { parse(input: unknown): T }

async function limitedJson<T>(response: Response, decoder: Decoder<T>): Promise<T> {
  if (!response.ok) throw statusError(response.status)
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ProviderSettingsClientError('invalid_response')
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_PROVIDER_SETTINGS_RESPONSE_BYTES) {
    throw new ProviderSettingsClientError('response_too_large')
  }
  let text = ''
  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_PROVIDER_SETTINGS_RESPONSE_BYTES) {
          await reader.cancel()
          throw new ProviderSettingsClientError('response_too_large')
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  } else {
    text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_SETTINGS_RESPONSE_BYTES) {
      throw new ProviderSettingsClientError('response_too_large')
    }
  }
  try { return decoder.parse(JSON.parse(text)) } catch {
    throw new ProviderSettingsClientError('invalid_response')
  }
}

/** Same-origin gateway only: API keys never go directly from the browser to a Provider. */
export class HttpProviderSettingsClient {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  private async request<T>(path: string, method: string, decoder: Decoder<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetcher(`${SETTINGS_PREFIX}${path}`, {
        method, signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return await limitedJson(response, decoder)
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (timedOut) throw new ProviderSettingsClientError('timeout')
      if (error instanceof ProviderSettingsClientError) throw error
      throw new ProviderSettingsClientError('network')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }

  status(signal: AbortSignal): Promise<PersonalProviderStatus> {
    return this.request('/settings', 'GET', personalProviderStatusSchema, signal)
  }

  save(input: PersonalProviderSettingsInput, signal: AbortSignal): Promise<PersonalProviderStatus> {
    const parsed = personalProviderSettingsInputSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new ProviderSettingsClientError('invalid_input'))
    return this.request('/settings', 'PUT', personalProviderStatusSchema, signal, parsed.data)
  }

  models(input: PersonalProviderModelsInput, signal: AbortSignal): Promise<PersonalProviderModelsResult> {
    const parsed = personalProviderModelsInputSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new ProviderSettingsClientError('invalid_input'))
    return this.request('/models', 'POST', personalProviderModelsResultSchema, signal, parsed.data)
  }

  private action(action: 'check' | 'enable' | 'pause', input: PersonalProviderAction, signal: AbortSignal): Promise<PersonalProviderStatus> {
    const parsed = personalProviderActionSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new ProviderSettingsClientError('invalid_input'))
    return this.request(`/${action}`, 'POST', personalProviderStatusSchema, signal, parsed.data)
  }

  check(input: PersonalProviderAction, signal: AbortSignal): Promise<PersonalProviderStatus> { return this.action('check', input, signal) }
  enable(input: PersonalProviderAction, signal: AbortSignal): Promise<PersonalProviderStatus> { return this.action('enable', input, signal) }
  pause(input: PersonalProviderAction, signal: AbortSignal): Promise<PersonalProviderStatus> { return this.action('pause', input, signal) }

  forget(input: PersonalProviderAction, signal: AbortSignal): Promise<PersonalProviderStatus> {
    const parsed = personalProviderActionSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new ProviderSettingsClientError('invalid_input'))
    return this.request('/settings', 'DELETE', personalProviderStatusSchema, signal, parsed.data)
  }
}
