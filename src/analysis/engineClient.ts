import {
  analysisEventSchema,
  analysisRunSchema,
  artifactEnvelopeSchema,
  artifactKindSchema,
  cancelRunRequestSchema,
  cancelRunResultSchema,
  createAnalysisRunSchema,
  deleteRunContentResultSchema,
  engineCapabilitiesSchema,
  identifierSchema,
  retryArtifactAcceptedSchema,
  retryArtifactRequestSchema,
  runCreatedSchema,
  sourceReceiptSchema,
  startRunRequestSchema,
  startRunResultSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
  type AnalysisRequestV1,
  type AnalysisRunV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type CancelRunResultV1,
  type DeleteRunContentResultV1,
  type EngineCapabilitiesV1,
  type RetryArtifactAcceptedV1,
  type RunCreatedV1,
  type SourceReceiptV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'

export const ANALYSIS_API_PREFIX = '/api/analysis/v1' as const
export const MAX_ANALYSIS_JSON_BYTES = 2_100_000
export const MAX_ANALYSIS_EVENT_BYTES = 65_536

type FetchLike = typeof fetch

interface Decoder<T> {
  parse(input: unknown): T
}

export type ClientErrorCode =
  | 'invalid_response'
  | 'response_too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'rate_limited'
  | 'service_unavailable'
  | 'request_failed'

export class AnalysisClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AnalysisClientError'
  }
}

export interface AnalysisEngineClient {
  capabilities(signal: AbortSignal): Promise<EngineCapabilitiesV1>
  createRun(request: AnalysisRequestV1, signal: AbortSignal): Promise<RunCreatedV1>
  uploadSource(runId: string, source: UploadSourcePartV1, signal: AbortSignal): Promise<SourceReceiptV1>
  startRun(runId: string, expectedRevision: number, signal: AbortSignal): Promise<AnalysisRunV1>
  getRun(runId: string, signal: AbortSignal): Promise<AnalysisRunV1>
  events(runId: string, options: { lastEventId?: string; signal: AbortSignal }): AsyncIterable<AnalysisEventV1>
  cancel(runId: string, expectedRevision: number, signal: AbortSignal): Promise<CancelRunResultV1>
  retryArtifact(
    runId: string,
    kind: ArtifactKind,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<RetryArtifactAcceptedV1>
  getArtifact(runId: string, kind: ArtifactKind, signal: AbortSignal): Promise<ArtifactEnvelopeV1>
  deleteContent(runId: string, signal: AbortSignal): Promise<DeleteRunContentResultV1>
}

const apiPath = (path: string): string => `${ANALYSIS_API_PREFIX}${path}`
const runPath = (runId: string, suffix = ''): string =>
  `/runs/${encodeURIComponent(identifierSchema.parse(runId))}${suffix}`

const errorForStatus = (status: number): AnalysisClientError => {
  if (status === 401) return new AnalysisClientError('unauthorized', 'Analysis service authentication failed', false, status)
  if (status === 403) return new AnalysisClientError('forbidden', 'Analysis service access was denied', false, status)
  if (status === 409) return new AnalysisClientError('conflict', 'Analysis run revision conflict', false, status)
  if (status === 429) return new AnalysisClientError('rate_limited', 'Analysis service rate limit reached', true, status)
  if (status >= 500) return new AnalysisClientError('service_unavailable', 'Analysis service is unavailable', true, status)
  return new AnalysisClientError('request_failed', 'Analysis request was rejected', false, status)
}

const readLimitedText = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new AnalysisClientError('response_too_large', 'Analysis response exceeds the byte limit', false)
  }

  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new AnalysisClientError('response_too_large', 'Analysis response exceeds the byte limit', false)
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new AnalysisClientError('response_too_large', 'Analysis response exceeds the byte limit', false)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

const decodeJsonResponse = async <T>(response: Response, decoder: Decoder<T>): Promise<T> => {
  if (!response.ok) throw errorForStatus(response.status)
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    throw new AnalysisClientError('invalid_response', 'Analysis service returned a non-JSON response', false, response.status)
  }
  const text = await readLimitedText(response, MAX_ANALYSIS_JSON_BYTES)
  try {
    return decoder.parse(JSON.parse(text))
  } catch (error) {
    if (error instanceof AnalysisClientError) throw error
    throw new AnalysisClientError('invalid_response', 'Analysis service returned invalid contract JSON', false, response.status)
  }
}

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' } as const

const findFrameBoundary = (buffer: string): { index: number; length: number } | undefined => {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

const parseEventFrame = (frame: string): AnalysisEventV1 | undefined => {
  let sseId: string | undefined
  const data: string[] = []
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const rawValue = separator === -1 ? '' : line.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'id') sseId = value
    if (field === 'data') data.push(value)
  }
  if (data.length === 0) return undefined

  try {
    const event = analysisEventSchema.parse(JSON.parse(data.join('\n')))
    if (sseId !== undefined && event.eventId !== sseId) {
      throw new AnalysisClientError('invalid_response', 'SSE id differs from event contract id', false)
    }
    return event
  } catch (error) {
    if (error instanceof AnalysisClientError) throw error
    throw new AnalysisClientError('invalid_response', 'Analysis service returned an invalid SSE event', false)
  }
}

const encodeBody = (value: unknown): string => JSON.stringify(value)

export class HttpAnalysisEngineClient implements AnalysisEngineClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async capabilities(signal: AbortSignal): Promise<EngineCapabilitiesV1> {
    const response = await this.fetcher(apiPath('/capabilities'), {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    })
    return decodeJsonResponse(response, engineCapabilitiesSchema)
  }

  async createRun(request: AnalysisRequestV1, signal: AbortSignal): Promise<RunCreatedV1> {
    const body = createAnalysisRunSchema.parse({ version: 1, request })
    const response = await this.fetcher(apiPath('/runs'), {
      method: 'POST',
      headers: jsonHeaders,
      credentials: 'same-origin',
      body: encodeBody(body),
      signal,
    })
    return decodeJsonResponse(response, runCreatedSchema)
  }

  async uploadSource(
    runId: string,
    source: UploadSourcePartV1,
    signal: AbortSignal,
  ): Promise<SourceReceiptV1> {
    const body = uploadSourcePartSchema.parse(source)
    const response = await this.fetcher(
      apiPath(`${runPath(runId)}/sources/${encodeURIComponent(source.sourceId)}`),
      {
        method: 'PUT',
        headers: jsonHeaders,
        credentials: 'same-origin',
        body: encodeBody(body),
        signal,
      },
    )
    return decodeJsonResponse(response, sourceReceiptSchema)
  }

  async startRun(runId: string, expectedRevision: number, signal: AbortSignal): Promise<AnalysisRunV1> {
    const body = startRunRequestSchema.parse({ version: 1, expectedRevision })
    const response = await this.fetcher(apiPath(runPath(runId, '/start')), {
      method: 'POST',
      headers: jsonHeaders,
      credentials: 'same-origin',
      body: encodeBody(body),
      signal,
    })
    const result = await decodeJsonResponse(response, startRunResultSchema)
    return result.run
  }

  async getRun(runId: string, signal: AbortSignal): Promise<AnalysisRunV1> {
    const response = await this.fetcher(apiPath(runPath(runId)), {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    })
    return decodeJsonResponse(response, analysisRunSchema)
  }

  async *events(
    runId: string,
    options: { lastEventId?: string; signal: AbortSignal },
  ): AsyncIterable<AnalysisEventV1> {
    const headers = new Headers({ accept: 'text/event-stream' })
    if (options.lastEventId !== undefined) {
      headers.set('last-event-id', identifierSchema.parse(options.lastEventId))
    }
    const response = await this.fetcher(apiPath(runPath(runId, '/events')), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: options.signal,
    })
    if (!response.ok) throw errorForStatus(response.status)
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? ''
    if (!contentType.startsWith('text/event-stream') || !response.body) {
      throw new AnalysisClientError('invalid_response', 'Analysis service returned an invalid event stream', false)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })

        let boundary = findFrameBoundary(buffer)
        while (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          if (encoder.encode(frame).byteLength > MAX_ANALYSIS_EVENT_BYTES) {
            await reader.cancel()
            throw new AnalysisClientError('response_too_large', 'Analysis SSE event exceeds the byte limit', false)
          }
          const event = parseEventFrame(frame)
          if (event) yield event
          boundary = findFrameBoundary(buffer)
        }
        if (encoder.encode(buffer).byteLength > MAX_ANALYSIS_EVENT_BYTES) {
          await reader.cancel()
          throw new AnalysisClientError('response_too_large', 'Analysis SSE event exceeds the byte limit', false)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        if (encoder.encode(buffer).byteLength > MAX_ANALYSIS_EVENT_BYTES) {
          throw new AnalysisClientError('response_too_large', 'Analysis SSE event exceeds the byte limit', false)
        }
        const event = parseEventFrame(buffer)
        if (event) yield event
      }
    } finally {
      reader.releaseLock()
    }
  }

  async cancel(runId: string, expectedRevision: number, signal: AbortSignal): Promise<CancelRunResultV1> {
    const body = cancelRunRequestSchema.parse({ version: 1, expectedRevision })
    const response = await this.fetcher(apiPath(runPath(runId, '/cancel')), {
      method: 'POST',
      headers: jsonHeaders,
      credentials: 'same-origin',
      body: encodeBody(body),
      signal,
    })
    return decodeJsonResponse(response, cancelRunResultSchema)
  }

  async retryArtifact(
    runId: string,
    kind: ArtifactKind,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<RetryArtifactAcceptedV1> {
    const body = retryArtifactRequestSchema.parse({ version: 1, kind, expectedRevision })
    const response = await this.fetcher(
      apiPath(`${runPath(runId)}/artifacts/${encodeURIComponent(kind)}/retry`),
      {
        method: 'POST',
        headers: jsonHeaders,
        credentials: 'same-origin',
        body: encodeBody(body),
        signal,
      },
    )
    return decodeJsonResponse(response, retryArtifactAcceptedSchema)
  }

  async getArtifact(runId: string, kind: ArtifactKind, signal: AbortSignal): Promise<ArtifactEnvelopeV1> {
    const decodedKind = artifactKindSchema.parse(kind)
    const response = await this.fetcher(
      apiPath(`${runPath(runId)}/artifacts/${encodeURIComponent(decodedKind)}`),
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      },
    )
    const artifact = await decodeJsonResponse(response, artifactEnvelopeSchema)
    if (artifact.runId !== runId || artifact.kind !== decodedKind) {
      throw new AnalysisClientError('invalid_response', 'Analysis artifact identity differs from its route', false)
    }
    return artifact
  }

  async deleteContent(runId: string, signal: AbortSignal): Promise<DeleteRunContentResultV1> {
    const response = await this.fetcher(apiPath(runPath(runId, '/content')), {
      method: 'DELETE',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    })
    return decodeJsonResponse(response, deleteRunContentResultSchema)
  }
}
