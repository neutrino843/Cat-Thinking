import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import {
  analysisErrorResponseSchema,
  analysisRunSchema,
  cancelRunResultSchema,
  engineCapabilitiesSchema,
  runCreatedSchema,
  sourceReceiptSchema,
  startRunResultSchema,
} from '@cat-thinking/analysis-contracts'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAnalysisServer } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'

const token = 'service-token-that-is-longer-than-thirty-two-bytes'
const origin = 'https://app.example.com'
const headers = {
  authorization: `Bearer ${token}`,
  'x-cat-tenant-id': 'tenant-1',
  origin,
}
const servers: FastifyInstance[] = []

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const setup = async (acceptsRuns = true): Promise<FastifyInstance> => {
  let id = 0
  const config = loadAnalysisServiceConfig({
    NODE_ENV: 'test',
    ANALYSIS_AUTH_MODE: 'service-token',
    ANALYSIS_SERVICE_TOKEN: token,
    ANALYSIS_CORS_ORIGINS: origin,
    ANALYSIS_ENABLE_REQUEST_LOGS: 'false',
    ANALYSIS_SSE_POLL_MS: '100',
    ANALYSIS_SSE_HEARTBEAT_MS: '1000',
  })
  const runService = new RunService({
    store: new InMemoryJobStore(),
    retentionSeconds: 3_600,
    now: () => 1_791_700_000_000,
    createId: () => `http-generated-${++id}`,
  })
  const server = await buildAnalysisServer(config, { logger: false, runService, acceptsRuns })
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('durable analysis HTTP lifecycle', () => {
  it('creates, uploads, starts, cancels, and replays a terminal SSE stream', async () => {
    const server = await setup()
    const text = '可恢复分析正文'
    const request = {
      version: 1,
      requestKey: 'd'.repeat(64),
      docId: 'doc-http',
      manifest: {
        version: 1,
        sources: [{
          version: 1,
          sourceId: 'source-http',
          kind: 'text',
          extractor: 'test@1',
          contentHash: hash(text),
          charCount: text.length,
          byteCount: new TextEncoder().encode(text).byteLength,
        }],
      },
      artifacts: ['summary'],
      options: {
        locale: 'zh-CN',
        qualityProfile: 'standard',
        summaryDetail: 'standard',
        quizQuestionCount: 1,
        externalKnowledge: false,
      },
    }
    const capabilityResponse = await server.inject({
      method: 'GET', url: '/api/analysis/v1/capabilities', headers,
    })
    const capabilities = engineCapabilitiesSchema.parse(capabilityResponse.json())
    expect(capabilities).toMatchObject({
      acceptsRuns: true,
      degradedReasons: [],
      supportsSse: true,
      supportsCancellation: true,
    })

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/analysis/v1/runs',
      headers,
      payload: { version: 1, request },
    })
    const created = runCreatedSchema.parse(createResponse.json())
    expect(createResponse.statusCode).toBe(200)

    const duplicate = runCreatedSchema.parse((await server.inject({
      method: 'POST',
      url: '/api/analysis/v1/runs',
      headers,
      payload: { version: 1, request },
    })).json())
    expect(duplicate).toMatchObject({ reused: true, run: { id: created.run.id } })

    const uploadResponse = await server.inject({
      method: 'PUT',
      url: `/api/analysis/v1/runs/${created.run.id}/sources/source-http`,
      headers,
      payload: {
        version: 1,
        sourceId: 'source-http',
        contentHash: hash(text),
        partHash: hash(text),
        partIndex: 0,
        partCount: 1,
        start: 0,
        end: text.length,
        totalChars: text.length,
        text,
      },
    })
    expect(sourceReceiptSchema.parse(uploadResponse.json())).toMatchObject({ complete: true })

    const startResponse = await server.inject({
      method: 'POST',
      url: `/api/analysis/v1/runs/${created.run.id}/start`,
      headers,
      payload: { version: 1, expectedRevision: 1 },
    })
    const started = startRunResultSchema.parse(startResponse.json())
    expect(started.run).toMatchObject({ status: 'queued', revision: 2 })

    const cancelResponse = await server.inject({
      method: 'POST',
      url: `/api/analysis/v1/runs/${created.run.id}/cancel`,
      headers,
      payload: { version: 1, expectedRevision: 2 },
    })
    expect(cancelRunResultSchema.parse(cancelResponse.json())).toMatchObject({ accepted: true, revision: 3 })

    const snapshot = analysisRunSchema.parse((await server.inject({
      method: 'GET', url: `/api/analysis/v1/runs/${created.run.id}`, headers,
    })).json())
    expect(snapshot.status).toBe('cancelled')

    const eventResponse = await server.inject({
      method: 'GET',
      url: `/api/analysis/v1/runs/${created.run.id}/events`,
      headers: { ...headers, accept: 'text/event-stream', 'last-event-id': 'http-generated-2' },
    })
    expect(eventResponse.statusCode).toBe(200)
    expect(eventResponse.headers['content-type']).toContain('text/event-stream')
    expect(eventResponse.body).not.toContain('run.accepted')
    expect(eventResponse.body).toContain('stage.started')
    expect(eventResponse.body).toContain('run.cancelled')
    const deleted = await server.inject({
      method: 'DELETE', url: `/api/analysis/v1/runs/${created.run.id}/content`, headers,
    })
    expect(deleted.json()).toMatchObject({ deleted: true })
  })

  it('uses stable errors for route identity mismatches and unknown event cursors', async () => {
    const server = await setup()
    const malformed = await server.inject({
      method: 'POST', url: '/api/analysis/v1/runs', headers, payload: { version: 1 },
    })
    expect(malformed.statusCode).toBe(400)
    expect(analysisErrorResponseSchema.parse(malformed.json()).error.messageKey).toBe('analysis.request.invalid')
    const text = '正文'
    const request = {
      version: 1,
      requestKey: 'e'.repeat(64),
      docId: 'doc-http',
      manifest: { version: 1, sources: [{
        version: 1,
        sourceId: 'source-http',
        kind: 'text',
        extractor: 'test@1',
        contentHash: hash(text),
        charCount: text.length,
        byteCount: new TextEncoder().encode(text).byteLength,
      }] },
      artifacts: ['summary'],
      options: {
        locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'brief', quizQuestionCount: 1,
        externalKnowledge: false,
      },
    }
    const created = runCreatedSchema.parse((await server.inject({
      method: 'POST', url: '/api/analysis/v1/runs', headers, payload: { version: 1, request },
    })).json())
    const mismatch = await server.inject({
      method: 'PUT',
      url: `/api/analysis/v1/runs/${created.run.id}/sources/source-http`,
      headers,
      payload: {
        version: 1,
        sourceId: 'source-other',
        contentHash: hash(text),
        partHash: hash(text),
        partIndex: 0,
        partCount: 1,
        start: 0,
        end: text.length,
        totalChars: text.length,
        text,
      },
    })
    expect(mismatch.statusCode).toBe(400)
    expect(analysisErrorResponseSchema.parse(mismatch.json()).error.messageKey).toBe('analysis.source.route_mismatch')

    const unknownCursor = await server.inject({
      method: 'GET',
      url: `/api/analysis/v1/runs/${created.run.id}/events`,
      headers: { ...headers, 'last-event-id': 'unknown-event' },
    })
    expect(unknownCursor.statusCode).toBe(409)
    expect(analysisErrorResponseSchema.parse(unknownCursor.json()).error.messageKey).toBe(
      'analysis.events.cursor_unknown',
    )

    const cancelled = cancelRunResultSchema.parse((await server.inject({
      method: 'POST',
      url: `/api/analysis/v1/runs/${created.run.id}/cancel`,
      headers,
      payload: { version: 1, expectedRevision: 1 },
    })).json())
    const retried = await server.inject({
      method: 'POST',
      url: `/api/analysis/v1/runs/${created.run.id}/artifacts/summary/retry`,
      headers,
      payload: { version: 1, kind: 'summary', expectedRevision: cancelled.revision },
    })
    expect(retried.json()).toMatchObject({ accepted: true, kind: 'summary', revision: 3 })
    const missingArtifact = await server.inject({
      method: 'GET',
      url: `/api/analysis/v1/runs/${created.run.id}/artifacts/summary`,
      headers,
    })
    expect(missingArtifact.statusCode).toBe(404)
    expect(analysisErrorResponseSchema.parse(missingArtifact.json()).error.messageKey).toBe(
      'analysis.artifact.not_found',
    )
    const invalidArtifactKind = await server.inject({
      method: 'GET',
      url: `/api/analysis/v1/runs/${created.run.id}/artifacts/not-a-kind`,
      headers,
    })
    expect(invalidArtifactKind.statusCode).toBe(400)
    expect(analysisErrorResponseSchema.parse(invalidArtifactKind.json()).error.messageKey).toBe(
      'analysis.artifact.kind_invalid',
    )
    const retryMismatch = await server.inject({
      method: 'POST',
      url: `/api/analysis/v1/runs/${created.run.id}/artifacts/quiz/retry`,
      headers,
      payload: { version: 1, kind: 'summary', expectedRevision: 3 },
    })
    expect(retryMismatch.statusCode).toBe(400)
    expect(analysisErrorResponseSchema.parse(retryMismatch.json()).error.messageKey).toBe(
      'analysis.artifact.route_mismatch',
    )
  })

  it('streams a live heartbeat and stops promptly when the client aborts', async () => {
    const server = await setup()
    const text = 'live stream'
    const request = {
      version: 1,
      requestKey: '1'.repeat(64),
      docId: 'doc-live',
      manifest: { version: 1, sources: [{
        version: 1,
        sourceId: 'source-live',
        kind: 'text',
        extractor: 'test@1',
        contentHash: hash(text),
        charCount: text.length,
        byteCount: text.length,
      }] },
      artifacts: ['summary'],
      options: {
        locale: 'en-US', qualityProfile: 'economy', summaryDetail: 'brief', quizQuestionCount: 1,
        externalKnowledge: false,
      },
    }
    const created = runCreatedSchema.parse((await server.inject({
      method: 'POST', url: '/api/analysis/v1/runs', headers, payload: { version: 1, request },
    })).json())
    const address = await server.listen({ host: '127.0.0.1', port: 0 })
    const streamed = await new Promise<{ statusCode?: number; contentType?: string; body: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE heartbeat timed out')), 4_000)
      const request = httpRequest(
        `${address}/api/analysis/v1/runs/${created.run.id}/events`,
        { headers: { ...headers, accept: 'text/event-stream' } },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
            if (!body.includes(': heartbeat')) return
            clearTimeout(timeout)
            response.destroy()
            resolve({
              statusCode: response.statusCode,
              contentType: response.headers['content-type'],
              body,
            })
          })
          response.on('error', (error) => {
            if (!body.includes(': heartbeat')) reject(error)
          })
        },
      )
      request.on('error', reject)
      request.end()
    })

    expect(streamed.statusCode).toBe(200)
    expect(streamed.contentType).toContain('text/event-stream')
    expect(streamed.body).toContain('run.accepted')
    expect(streamed.body).toContain(': heartbeat')
  }, 5_000)

  it('advertises recoverable infrastructure without accepting runs before a provider is ready', async () => {
    const server = await setup(false)
    const capabilities = engineCapabilitiesSchema.parse((await server.inject({
      method: 'GET', url: '/api/analysis/v1/capabilities', headers,
    })).json())
    expect(capabilities).toMatchObject({
      acceptsRuns: false,
      supportsSse: true,
      supportsCancellation: true,
      degradedReasons: ['provider.not-configured'],
    })
    const rejected = await server.inject({
      method: 'POST', url: '/api/analysis/v1/runs', headers, payload: {},
    })
    expect(rejected.statusCode).toBe(503)
  })
})
