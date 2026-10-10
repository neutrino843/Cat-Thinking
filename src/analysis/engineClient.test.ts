import { describe, expect, it, vi } from 'vitest'
import {
  analysisRequestSchema,
  analysisRunSchema,
  type AnalysisEventV1,
  type AnalysisRunV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
} from '@cat-thinking/analysis-contracts'
import requestFixture from '../../packages/analysis-contracts/fixtures/analysis-request.valid.json'
import {
  ANALYSIS_API_PREFIX,
  AnalysisClientError,
  HttpAnalysisEngineClient,
  MAX_ANALYSIS_EVENT_BYTES,
  MAX_ANALYSIS_JSON_BYTES,
} from './engineClient'

const capabilities = {
  service: 'cat-analysis-engine',
  serviceVersion: '1.0.0',
  acceptsRuns: true,
  degradedReasons: [],
  contractVersions: [1],
  qualityProfiles: ['standard'],
  artifactKinds: ['summary', 'outline', 'mindmap', 'quiz', 'knowledge'],
  maxSourcesPerRun: 20,
  maxSourceCharacters: 2_000_000,
  maxUploadPartBytes: 512_000,
  supportsSse: true,
  supportsCancellation: true,
  supportsExternalKnowledge: false,
  retentionSeconds: 3_600,
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

const fetcher = (implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
  vi.fn(implementation) as unknown as typeof fetch

const acceptedEvent: AnalysisEventV1 = {
  version: 1,
  type: 'run.accepted',
  eventId: 'event-0',
  runId: 'run-1',
  runRevision: 1,
  sequence: 0,
  createdAt: 1791500000000,
  requestKey: 'a'.repeat(64),
}

const progressEvent: AnalysisEventV1 = {
  version: 1,
  type: 'progress.updated',
  eventId: 'event-1',
  runId: 'run-1',
  runRevision: 1,
  sequence: 1,
  createdAt: 1791500000100,
  stage: 'mapping',
  progress: 0.5,
}

const summaryArtifact: ArtifactEnvelopeV1 = {
  version: 1,
  schemaVersion: 1,
  id: 'artifact-summary',
  runId: 'run-1',
  docId: 'doc-photosynthesis',
  kind: 'summary',
  sourceContentHashes: ['a'.repeat(64)],
  payload: {
    overview: {
      id: 'overview-1',
      text: 'Overview',
      evidenceIds: ['claim-1'],
      citations: [{ version: 1, provenance: 'source', sourceId: 'source-photosynthesis', start: 0, end: 10 }],
    },
    keyPoints: [{
      id: 'point-1',
      text: 'Key point',
      evidenceIds: ['claim-1'],
      citations: [{ version: 1, provenance: 'source', sourceId: 'source-photosynthesis', start: 0, end: 10 }],
    }],
    confusions: [],
  },
  createdAt: 1791500000000,
  updatedAt: 1791500000000,
}

const sseResponse = (frames: readonly string[]): Response => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

const createRun = (): AnalysisRunV1 => {
  const request = analysisRequestSchema.parse(requestFixture)
  const artifactState = { status: 'pending' as const, attempt: 0, updatedAt: 1791500000000 }
  return analysisRunSchema.parse({
    version: 1,
    id: 'run-1',
    docId: request.docId,
    requestKey: request.requestKey,
    request,
    revision: 1,
    status: 'receiving',
    stage: 'receiving',
    progress: 0,
    coverage: {
      input: 0,
      analysis: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksTotal: 0,
    },
    providerRoutes: [],
    artifactStates: {
      summary: artifactState,
      outline: artifactState,
      mindmap: artifactState,
      quiz: artifactState,
      knowledge: artifactState,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostMicros: 0,
      currency: 'CNY',
    },
    createdAt: 1791500000000,
    updatedAt: 1791500000000,
  })
}

describe('HTTP analysis engine client', () => {
  it('uses only the fixed same-origin capability path', async () => {
    const mockFetch = fetcher(async () => jsonResponse(capabilities))
    const client = new HttpAnalysisEngineClient(mockFetch)

    const result = await client.capabilities(new AbortController().signal)

    expect(result.service).toBe('cat-analysis-engine')
    expect(mockFetch).toHaveBeenCalledWith(
      `${ANALYSIS_API_PREFIX}/capabilities`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    )
  })

  it('rejects non-JSON and oversized JSON responses', async () => {
    const nonJson = new HttpAnalysisEngineClient(fetcher(async () => new Response('ok', { status: 200 })))
    await expect(nonJson.capabilities(new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })

    const oversized = new HttpAnalysisEngineClient(
      fetcher(async () => jsonResponse(capabilities, 200, { 'content-length': String(MAX_ANALYSIS_JSON_BYTES + 1) })),
    )
    await expect(oversized.capabilities(new AbortController().signal)).rejects.toMatchObject({
      code: 'response_too_large',
    })

    const encoder = new TextEncoder()
    const missingType = new HttpAnalysisEngineClient(fetcher(async () =>
      new Response(encoder.encode(JSON.stringify(capabilities)))),
    )
    await expect(missingType.capabilities(new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('classifies retryable HTTP failures without exposing response bodies', async () => {
    const client = new HttpAnalysisEngineClient(fetcher(async () => new Response('provider secret', { status: 429 })))

    await expect(client.capabilities(new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<AnalysisClientError>>({
        code: 'rate_limited',
        retryable: true,
        status: 429,
      }),
    )
  })

  it.each([
    [401, 'unauthorized', false],
    [403, 'forbidden', false],
    [409, 'conflict', false],
    [500, 'service_unavailable', true],
    [400, 'request_failed', false],
  ] as const)('classifies HTTP %s as %s', async (status, code, retryable) => {
    const client = new HttpAnalysisEngineClient(fetcher(async () => new Response('hidden', { status })))

    await expect(client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code, retryable, status })
  })

  it('executes every versioned run endpoint with decoded responses', async () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const run = createRun()
    const calls: { url: string; method: string }[] = []
    const mockFetch = fetcher(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url.endsWith('/sources/source-photosynthesis')) {
        return jsonResponse({
          version: 1,
          sourceId: 'source-photosynthesis',
          receivedParts: 1,
          partCount: 1,
          complete: true,
          computedHash: 'a'.repeat(64),
        })
      }
      if (url.endsWith('/start')) return jsonResponse({ version: 1, run })
      if (url.endsWith('/cancel')) {
        return jsonResponse({ version: 1, runId: 'run-1', revision: 2, accepted: true })
      }
      if (url.endsWith('/artifacts/summary/retry')) {
        return jsonResponse({ version: 1, runId: 'run-1', kind: 'summary', revision: 2, accepted: true })
      }
      if (url.endsWith('/artifacts/summary')) return jsonResponse(summaryArtifact)
      if (url.endsWith('/content')) return jsonResponse({ version: 1, runId: 'run-1', deleted: true })
      if (url.endsWith('/runs') && method === 'POST') {
        return jsonResponse({ version: 1, run, reused: false })
      }
      return jsonResponse(run)
    })
    const client = new HttpAnalysisEngineClient(mockFetch)
    const sourcePart = {
      version: 1 as const,
      sourceId: 'source-photosynthesis',
      contentHash: 'a'.repeat(64),
      partHash: 'b'.repeat(64),
      partIndex: 0,
      partCount: 1,
      start: 0,
      end: 1200,
      totalChars: 1200,
      text: 'x'.repeat(1200),
    }

    await expect(client.createRun(request, new AbortController().signal)).resolves.toMatchObject({ reused: false })
    await expect(client.uploadSource('run-1', sourcePart, new AbortController().signal)).resolves.toMatchObject({
      complete: true,
    })
    await expect(client.startRun('run-1', 1, new AbortController().signal)).resolves.toMatchObject({ id: 'run-1' })
    await expect(client.getRun('run-1', new AbortController().signal)).resolves.toMatchObject({ id: 'run-1' })
    await expect(client.cancel('run-1', 1, new AbortController().signal)).resolves.toMatchObject({ revision: 2 })
    await expect(client.retryArtifact('run-1', 'summary', 1, new AbortController().signal)).resolves.toMatchObject({
      kind: 'summary',
    })
    await expect(client.getArtifact('run-1', 'summary', new AbortController().signal)).resolves.toEqual(summaryArtifact)
    await expect(client.deleteContent('run-1', new AbortController().signal)).resolves.toMatchObject({ deleted: true })

    expect(calls).toEqual(
      expect.arrayContaining([
        { url: `${ANALYSIS_API_PREFIX}/runs`, method: 'POST' },
        { url: `${ANALYSIS_API_PREFIX}/runs/run-1/start`, method: 'POST' },
        { url: `${ANALYSIS_API_PREFIX}/runs/run-1`, method: 'GET' },
        { url: `${ANALYSIS_API_PREFIX}/runs/run-1/artifacts/summary`, method: 'GET' },
        { url: `${ANALYSIS_API_PREFIX}/runs/run-1/content`, method: 'DELETE' },
      ]),
    )
  })

  it('rejects an artifact whose identity differs from its route', async () => {
    const client = new HttpAnalysisEngineClient(fetcher(async () => jsonResponse({
      ...summaryArtifact,
      runId: 'run-other',
    })))

    await expect(client.getArtifact('run-1', 'summary', new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    const wrongKind = new HttpAnalysisEngineClient(fetcher(async () => jsonResponse(summaryArtifact)))
    await expect(wrongKind.getArtifact('run-1', 'quiz', new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('rejects invalid run identifiers before issuing a request', async () => {
    const mockFetch = fetcher(async () => jsonResponse(createRun()))
    const client = new HttpAnalysisEngineClient(mockFetch)

    await expect(client.getRun('../secret', new AbortController().signal)).rejects.toBeDefined()
    await expect(client.getArtifact(
      'run-1',
      '../summary' as ArtifactKind,
      new AbortController().signal,
    )).rejects.toBeDefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('decodes split SSE frames and forwards Last-Event-ID', async () => {
    const mockFetch = fetcher(async () =>
      sseResponse([
        `id: event-0\ndata: ${JSON.stringify(acceptedEvent)}\n`,
        `\nid: event-1\ndata: ${JSON.stringify(progressEvent)}\n\n`,
      ]),
    )
    const client = new HttpAnalysisEngineClient(mockFetch)
    const events: AnalysisEventV1[] = []

    for await (const event of client.events('run-1', {
      lastEventId: 'event-prior',
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events.map((event) => event.eventId)).toEqual(['event-0', 'event-1'])
    const headers = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('last-event-id')).toBe('event-prior')
  })

  it('rejects an SSE id that differs from the contract event id', async () => {
    const client = new HttpAnalysisEngineClient(
      fetcher(async () => sseResponse([`id: event-wrong\ndata: ${JSON.stringify(acceptedEvent)}\n\n`])),
    )

    const consume = async (): Promise<void> => {
      const consumed: AnalysisEventV1[] = []
      for await (const event of client.events('run-1', { signal: new AbortController().signal })) consumed.push(event)
      expect(consumed).toHaveLength(0)
    }

    await expect(consume()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('accepts CRLF, comments and a final frame without a trailing delimiter', async () => {
    const client = new HttpAnalysisEngineClient(
      fetcher(async () =>
        sseResponse([
          ': heartbeat\r\n\r\n',
          `id: event-0\r\ndata: ${JSON.stringify(acceptedEvent)}`,
        ]),
      ),
    )
    const events: AnalysisEventV1[] = []

    for await (const event of client.events('run-1', { signal: new AbortController().signal })) events.push(event)

    expect(events).toEqual([acceptedEvent])

    const compact = new HttpAnalysisEngineClient(
      fetcher(async () => sseResponse([`id:event-0\ndata:${JSON.stringify(acceptedEvent)}\n\n`])),
    )
    const compactEvents: AnalysisEventV1[] = []
    for await (const event of compact.events('run-1', { signal: new AbortController().signal })) {
      compactEvents.push(event)
    }
    expect(compactEvents).toEqual([acceptedEvent])
  })

  it('rejects invalid event-stream responses and oversized incomplete frames', async () => {
    const wrongType = new HttpAnalysisEngineClient(fetcher(async () => jsonResponse(acceptedEvent)))
    const noBody = new HttpAnalysisEngineClient(
      fetcher(async () => new Response(null, { headers: { 'content-type': 'text/event-stream' } })),
    )
    const tooLarge = new HttpAnalysisEngineClient(
      fetcher(async () => sseResponse([`: ${'x'.repeat(MAX_ANALYSIS_EVENT_BYTES + 1)}`])),
    )
    const tooLargeComplete = new HttpAnalysisEngineClient(
      fetcher(async () => sseResponse([`: ${'x'.repeat(MAX_ANALYSIS_EVENT_BYTES + 1)}\n\n`])),
    )
    const missingType = new HttpAnalysisEngineClient(fetcher(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`id:event-0\ndata:${JSON.stringify(acceptedEvent)}\n\n`))
          controller.close()
        },
      }))
    }))

    const consume = async (client: HttpAnalysisEngineClient): Promise<void> => {
      for await (const event of client.events('run-1', { signal: new AbortController().signal })) void event
    }

    await expect(consume(wrongType)).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(consume(noBody)).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(consume(tooLarge)).rejects.toMatchObject({ code: 'response_too_large' })
    await expect(consume(tooLargeComplete)).rejects.toMatchObject({ code: 'response_too_large' })
    await expect(consume(missingType)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects invalid JSON bodies and streamed JSON beyond the byte cap', async () => {
    const invalidJson = new HttpAnalysisEngineClient(
      fetcher(async () => new Response('{', { headers: { 'content-type': 'application/json' } })),
    )
    const streamedTooLarge = new HttpAnalysisEngineClient(
      fetcher(async () =>
        new Response('x'.repeat(MAX_ANALYSIS_JSON_BYTES + 1), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(invalidJson.capabilities(new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(streamedTooLarge.capabilities(new AbortController().signal)).rejects.toMatchObject({
      code: 'response_too_large',
    })
  })
})
