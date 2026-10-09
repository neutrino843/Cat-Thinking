import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import type { AnalysisServiceConfig } from '../config.js'
import { createEngineCapabilities } from '../domain/capabilities.js'
import {
  ServiceHttpError,
  createContractError,
  createErrorResponse,
} from '../errors.js'
import { createLoggerOptions } from '../telemetry/logger.js'
import { createAuthenticationHook } from './auth.js'
import { createOriginGuard } from './originGuard.js'
import { registerRunRoutes } from './runRoutes.js'
import type { RunService } from '../domain/runService.js'

export interface BuildAnalysisServerOptions {
  readonly logger?: false
  readonly now?: () => number
  readonly runService?: RunService
  readonly acceptsRuns?: boolean
}

const invalidRequestError = (messageKey: string): ServiceHttpError => new ServiceHttpError(
  400,
  createContractError('invalid_request', 'client', false, messageKey),
)

const apiNotFoundError = (): ServiceHttpError => new ServiceHttpError(
  404,
  createContractError('invalid_request', 'client', false, 'analysis.route.not_found'),
)

export interface ClassifiedHttpError {
  readonly serviceError: ServiceHttpError
  readonly unexpected: boolean
  readonly originalName?: string
  readonly originalCode?: string
}

export const classifyHttpError = (error: unknown): ClassifiedHttpError => {
  const errorRecord = typeof error === 'object' && error !== null
    ? error as { code?: string; name?: string; statusCode?: number }
    : {}
  if (error instanceof ServiceHttpError) {
    return { serviceError: error, unexpected: false }
  }
  if (errorRecord.statusCode === 429 || errorRecord.code === 'CAT_RATE_LIMITED') {
    return {
      serviceError: new ServiceHttpError(
        429,
        createContractError('rate_limited', 'rate-limit', true, 'analysis.rate_limit.exceeded'),
      ),
      unexpected: false,
    }
  }
  if (errorRecord.statusCode === 413 || errorRecord.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      serviceError: new ServiceHttpError(
        413,
        createContractError('invalid_request', 'client', false, 'analysis.request.body_too_large'),
      ),
      unexpected: false,
    }
  }
  if (errorRecord.statusCode === 400 || errorRecord.statusCode === 415) {
    return { serviceError: invalidRequestError('analysis.request.invalid'), unexpected: false }
  }
  return {
    serviceError: new ServiceHttpError(
      500,
      createContractError('internal_error', 'internal', true, 'analysis.internal_error'),
    ),
    unexpected: true,
    originalName: errorRecord.name,
    originalCode: errorRecord.code,
  }
}

export const buildAnalysisServer = async (
  config: AnalysisServiceConfig,
  options: BuildAnalysisServerOptions = {},
): Promise<FastifyInstance> => {
  const now = options.now ?? Date.now
  const server = Fastify<HttpServer>({
    bodyLimit: config.bodyLimitBytes,
    connectionTimeout: config.connectionTimeoutMs,
    exposeHeadRoutes: false,
    forceCloseConnections: 'idle',
    genReqId: () => randomUUID(),
    keepAliveTimeout: config.keepAliveTimeoutMs,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger === false ? false : createLoggerOptions(config),
    onConstructorPoisoning: 'error',
    onProtoPoisoning: 'error',
    requestTimeout: config.requestTimeoutMs,
    return503OnClosing: true,
    routerOptions: { maxParamLength: 128 },
    trustProxy: config.trustProxyHops === 0
      ? false
      : (_address: string, hop: number) => hop < config.trustProxyHops,
  })

  server.decorateRequest('analysisIdentity', null)

  server.setErrorHandler(async (error: unknown, request, reply) => {
    const classified = classifyHttpError(error)
    if (classified.unexpected) {
      request.log.error({
        event: 'analysis.http.unexpected_error',
        traceId: request.id,
        errorName: classified.originalName ?? 'UnknownError',
        errorCode: classified.originalCode,
      }, 'unexpected analysis service error')
    }

    const { serviceError } = classified
    if (serviceError.statusCode === 401) reply.header('www-authenticate', 'Bearer')
    return reply
      .code(serviceError.statusCode)
      .type('application/json')
      .send(createErrorResponse(request.id, serviceError.contractError))
  })

  await server.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.environment === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  })

  await server.register(cors, {
    allowedHeaders: ['authorization', 'content-type', 'last-event-id', 'x-cat-tenant-id'],
    credentials: config.corsOrigins.length > 0,
    exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'],
    maxAge: 600,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    strictPreflight: true,
  })

  await server.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    ipv6Subnet: 64,
    errorResponseBuilder: () => ({ statusCode: 429, code: 'CAT_RATE_LIMITED' }),
  })

  server.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  server.addHook('onResponse', async (request, reply) => {
    if (!config.requestLogsEnabled) return
    request.log.info({
      event: 'analysis.http.completed',
      traceId: request.id,
      tenantId: request.analysisIdentity?.tenantId,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    }, 'analysis request completed')
  })

  server.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    service: 'cat-analysis-engine',
    version: config.serviceVersion,
    timestamp: now(),
  }))

  server.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const ready = options.runService ? await options.runService.checkHealth() : true
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      service: 'cat-analysis-engine',
      version: config.serviceVersion,
      timestamp: now(),
    })
  })

  await server.register(async (api) => {
    api.addHook('onRequest', createOriginGuard(config.corsOrigins))
    api.addHook('onRequest', createAuthenticationHook(config))

    const acceptsRuns = options.acceptsRuns ?? false
    api.get('/capabilities', async () => createEngineCapabilities(config, {
      jobStoreReady: options.runService !== undefined,
      providerReady: acceptsRuns,
      acceptsRuns,
    }))
    registerRunRoutes(api, config, { runService: options.runService, acceptsRuns })
  }, { prefix: '/api/analysis/v1' })

  server.setNotFoundHandler(async () => {
    throw apiNotFoundError()
  })

  return server
}
