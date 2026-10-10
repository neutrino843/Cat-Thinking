import {
  analysisErrorResponseSchema,
  engineCapabilitiesSchema,
} from '@cat-thinking/analysis-contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAnalysisServer, classifyHttpError } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { createEngineCapabilities } from '../src/domain/capabilities.js'
import { RunService } from '../src/domain/runService.js'
import { ServiceHttpError, createContractError } from '../src/errors.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createLoggerOptions, loggerRedactionPaths } from '../src/telemetry/logger.js'

const token = 'service-token-that-is-longer-than-thirty-two-bytes'
const origin = 'https://app.example.com'
const openServers: FastifyInstance[] = []

const createServer = async (overrides: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> => {
  const config = loadAnalysisServiceConfig({
    NODE_ENV: 'test',
    ANALYSIS_AUTH_MODE: 'service-token',
    ANALYSIS_SERVICE_TOKEN: token,
    ANALYSIS_CORS_ORIGINS: origin,
    ANALYSIS_ENABLE_REQUEST_LOGS: 'false',
    ...overrides,
  })
  const server = await buildAnalysisServer(config, { logger: false, now: () => 1_791_600_000_000 })
  openServers.push(server)
  return server
}

const authorizedHeaders = {
  authorization: `Bearer ${token}`,
  'x-cat-tenant-id': 'tenant-1',
  origin,
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()))
})

describe('analysis service security boundary', () => {
  it('reports each unavailable capability independently', () => {
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test' })
    expect(createEngineCapabilities(config)).toMatchObject({
      acceptsRuns: false,
      supportsSse: false,
      degradedReasons: ['provider.not-configured', 'job-store.not-configured', 'dispatcher.not-ready'],
    })
    expect(createEngineCapabilities(config, { providerReady: true })).toMatchObject({
      acceptsRuns: false,
      supportsSse: false,
      degradedReasons: ['job-store.not-configured', 'dispatcher.not-ready'],
    })
    expect(createEngineCapabilities(config, {
      jobStoreReady: true,
      providerReady: true,
      dispatcherReady: true,
    })).toMatchObject({ acceptsRuns: true, degradedReasons: [] })
  })

  it('serves unauthenticated liveness and readiness without consuming rate limit', async () => {
    const server = await createServer({ ANALYSIS_RATE_LIMIT_MAX: '1' })

    const health = await server.inject({ method: 'GET', url: '/health' })
    const ready = await server.inject({ method: 'GET', url: '/ready' })
    const healthAgain = await server.inject({ method: 'GET', url: '/health' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ status: 'ok', timestamp: 1_791_600_000_000 })
    expect(ready.statusCode).toBe(200)
    expect(healthAgain.statusCode).toBe(200)
  })

  it('rejects missing credentials with a stable, non-secret error envelope', async () => {
    const server = await createServer()
    const response = await server.inject({ method: 'GET', url: '/api/analysis/v1/capabilities' })
    const payload = analysisErrorResponseSchema.parse(response.json())

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(payload.traceId).toBe(response.headers['x-request-id'])
    expect(payload.error.code).toBe('unauthorized')
    expect(response.body).not.toContain(token)
  })

  it('requires both a valid constant-time token and a validated tenant id', async () => {
    const server = await createServer()
    const invalidToken = await server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: { ...authorizedHeaders, authorization: 'Bearer wrong-token' },
    })
    const missingTenant = await server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: { authorization: `Bearer ${token}`, origin },
    })

    expect(invalidToken.statusCode).toBe(401)
    expect(missingTenant.statusCode).toBe(401)
  })

  it('returns validated degraded capabilities until jobs and providers exist', async () => {
    const server = await createServer()
    const response = await server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: authorizedHeaders,
    })
    const capabilities = engineCapabilitiesSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(capabilities.acceptsRuns).toBe(false)
    expect(capabilities.degradedReasons).toEqual([
      'provider.not-configured',
      'job-store.not-configured',
      'dispatcher.not-ready',
    ])
    expect(capabilities.supportsSse).toBe(false)
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('allows an exact CORS preflight and rejects untrusted browser origins', async () => {
    const server = await createServer()
    const preflight = await server.inject({
      method: 'OPTIONS',
      url: '/api/analysis/v1/capabilities',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-cat-tenant-id',
      },
    })
    const rejected = await server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: {
        ...authorizedHeaders,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    })

    expect(preflight.statusCode).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe(origin)
    expect(rejected.statusCode).toBe(403)
    expect(analysisErrorResponseSchema.parse(rejected.json()).error.code).toBe('forbidden')
  })

  it('rate limits API traffic with a contract-shaped retryable error', async () => {
    const server = await createServer({ ANALYSIS_RATE_LIMIT_MAX: '2' })
    const request = () => server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: authorizedHeaders,
    })

    expect((await request()).statusCode).toBe(200)
    expect((await request()).statusCode).toBe(200)
    const limited = await request()
    const payload = analysisErrorResponseSchema.parse(limited.json())

    expect(limited.statusCode).toBe(429)
    expect(payload.error.code).toBe('rate_limited')
    expect(payload.error.retryable).toBe(true)
  })

  it('enforces JSON body size before reporting that run creation is unavailable', async () => {
    const server = await createServer({ ANALYSIS_BODY_LIMIT_BYTES: '1024' })
    const unavailable = await server.inject({
      method: 'POST',
      url: '/api/analysis/v1/runs',
      headers: authorizedHeaders,
      payload: { small: true },
    })
    const oversized = await server.inject({
      method: 'POST',
      url: '/api/analysis/v1/runs',
      headers: authorizedHeaders,
      payload: { content: 'x'.repeat(2_000) },
    })

    expect(unavailable.statusCode).toBe(503)
    expect(analysisErrorResponseSchema.parse(unavailable.json()).error.code).toBe('service_unavailable')
    expect(oversized.statusCode).toBe(413)
    expect(analysisErrorResponseSchema.parse(oversized.json()).error.messageKey).toBe('analysis.request.body_too_large')
  })

  it('returns stable errors for missing routes and redacts all credential fields', async () => {
    const server = await createServer()
    const response = await server.inject({ method: 'GET', url: '/missing' })

    expect(response.statusCode).toBe(404)
    expect(analysisErrorResponseSchema.parse(response.json()).error.messageKey).toBe('analysis.route.not_found')
    expect(loggerRedactionPaths()).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.headers.cookie',
      'token',
      'secret',
      'apiKey',
      'provider.apiKey',
    ]))

    const logger = createLoggerOptions(loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_LOG_LEVEL: 'info' }))
    expect(logger).toMatchObject({
      level: 'info',
      redact: { censor: '[REDACTED]' },
    })
  })

  it('supports a no-CORS local boundary, disabled auth, proxy hops, and default clock', async () => {
    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_LOG_LEVEL: 'silent',
      ANALYSIS_TRUST_PROXY_HOPS: '1',
      ANALYSIS_ENABLE_REQUEST_LOGS: 'true',
    })
    const server = await buildAnalysisServer(config)
    openServers.push(server)
    const response = await server.inject({
      method: 'GET',
      url: '/api/analysis/v1/capabilities',
      headers: { 'x-cat-tenant-id': 'local-tenant' },
    })
    const health = await server.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(Number.isInteger(health.json().timestamp)).toBe(true)
    expect(health.headers['strict-transport-security']).toBeUndefined()
    expect(createLoggerOptions(config)).toBe(false)
  })

  it('enables HSTS only for a valid production configuration', async () => {
    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'production',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: token,
      ANALYSIS_CORS_ORIGINS: origin,
      ANALYSIS_ENABLE_REQUEST_LOGS: 'false',
    })
    const server = await buildAnalysisServer(config, { logger: false })
    openServers.push(server)
    const response = await server.inject({ method: 'GET', url: '/health' })

    expect(response.headers['strict-transport-security']).toContain('max-age=31536000')
  })

  it('reports not-ready when a configured durable store loses health', async () => {
    class UnhealthyStore extends InMemoryJobStore {
      override checkHealth(): Promise<boolean> {
        return Promise.resolve(false)
      }
    }
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_LOG_LEVEL: 'silent' })
    const runService = new RunService({ store: new UnhealthyStore(), retentionSeconds: 3_600 })
    const server = await buildAnalysisServer(config, { logger: false, runService })
    openServers.push(server)

    const response = await server.inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ status: 'not-ready' })
  })

  it('classifies framework and domain failures without exposing raw messages', () => {
    const domainError = new ServiceHttpError(
      401,
      createContractError('unauthorized', 'authentication', false, 'analysis.auth.unauthorized'),
    )

    expect(classifyHttpError(domainError).serviceError).toBe(domainError)
    expect(classifyHttpError({ statusCode: 429 }).serviceError.contractError.code).toBe('rate_limited')
    expect(classifyHttpError({ code: 'CAT_RATE_LIMITED' }).serviceError.statusCode).toBe(429)
    expect(classifyHttpError({ statusCode: 413 }).serviceError.contractError.messageKey).toBe('analysis.request.body_too_large')
    expect(classifyHttpError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }).serviceError.statusCode).toBe(413)
    expect(classifyHttpError({ statusCode: 400 }).serviceError.statusCode).toBe(400)
    expect(classifyHttpError({ statusCode: 415 }).serviceError.statusCode).toBe(400)
    expect(classifyHttpError(new Error('private detail'))).toMatchObject({
      unexpected: true,
      originalName: 'Error',
      serviceError: { statusCode: 500 },
    })
    expect(classifyHttpError(null)).toMatchObject({ unexpected: true, serviceError: { statusCode: 500 } })
  })
})
