import { once } from 'node:events'
import {
  artifactKindSchema,
  cancelRunRequestSchema,
  createAnalysisRunSchema,
  identifierSchema,
  retryArtifactRequestSchema,
  startRunRequestSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
} from '@cat-thinking/analysis-contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AnalysisServiceConfig } from '../config.js'
import { RunService, isTerminalRun } from '../domain/runService.js'
import { ServiceHttpError, createContractError, serviceUnavailableError } from '../errors.js'

interface RunParams { runId: string }
interface SourceParams extends RunParams { sourceId: string }
interface ArtifactParams extends RunParams { kind: string }

const invalidRequest = (messageKey: string): ServiceHttpError => new ServiceHttpError(
  400,
  createContractError('invalid_request', 'client', false, messageKey),
)

const decode = <T>(decoder: { parse(input: unknown): T }, input: unknown, messageKey: string): T => {
  try {
    return decoder.parse(input)
  } catch {
    throw invalidRequest(messageKey)
  }
}

const readIdentity = (request: FastifyRequest): string => {
  const tenantId = request.analysisIdentity?.tenantId
  if (!tenantId) throw invalidRequest('analysis.tenant.missing')
  return tenantId
}

const readRunId = (runId: string): string => decode(identifierSchema, runId, 'analysis.run.id_invalid')

const readLastEventId = (request: FastifyRequest): string | undefined => {
  const value = request.headers['last-event-id']
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw invalidRequest('analysis.events.cursor_invalid')
  return decode(identifierSchema, value, 'analysis.events.cursor_invalid')
}

const frameFor = (event: AnalysisEventV1): string => `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`

const write = async (reply: FastifyReply, value: string, signal: AbortSignal): Promise<void> => {
  if (signal.aborted || reply.raw.destroyed) return
  if (reply.raw.write(value)) return
  await Promise.race([
    once(reply.raw, 'drain'),
    once(signal, 'abort'),
  ])
}

const streamEvents = async (
  request: FastifyRequest<{ Params: RunParams }>,
  reply: FastifyReply,
  runService: RunService,
  config: AnalysisServiceConfig,
): Promise<void> => {
  const tenantId = readIdentity(request)
  const runId = readRunId(request.params.runId)
  let lastEventId = readLastEventId(request)
  let events = await runService.listEvents(tenantId, runId, lastEventId)
  let run = await runService.getRun(tenantId, runId)

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  request.raw.once('close', abort)
  reply.raw.once('close', abort)
  reply.raw.once('error', abort)

  const existingHeaders = reply.getHeaders()
  reply.hijack()
  for (const [name, value] of Object.entries(existingHeaders)) {
    if (value !== undefined) reply.raw.setHeader(name, value)
  }
  reply.raw.setHeader('cache-control', 'no-cache, no-transform')
  reply.raw.setHeader('connection', 'keep-alive')
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('x-accel-buffering', 'no')
  reply.raw.writeHead(200)

  let lastWriteAt = Date.now()
  try {
    while (!controller.signal.aborted && !reply.raw.destroyed) {
      for (const event of events) {
        await write(reply, frameFor(event), controller.signal)
        lastEventId = event.eventId
        lastWriteAt = Date.now()
      }
      if (isTerminalRun(run)) break

      const observedVersion = runService.broker.version(runId)
      await runService.broker.wait(runId, observedVersion, config.ssePollMs, controller.signal)
      if (controller.signal.aborted) break
      events = await runService.listEvents(tenantId, runId, lastEventId)
      run = await runService.getRun(tenantId, runId)
      if (events.length === 0 && Date.now() - lastWriteAt >= config.sseHeartbeatMs) {
        await write(reply, `: heartbeat ${Date.now()}\n\n`, controller.signal)
        lastWriteAt = Date.now()
      }
    }
  } finally {
    request.raw.removeListener('close', abort)
    if (!reply.raw.destroyed) reply.raw.end()
  }
}

export interface RegisterRunRoutesOptions {
  readonly runService?: RunService
  readonly acceptsRuns: boolean
}

export const registerRunRoutes = (
  api: FastifyInstance,
  config: AnalysisServiceConfig,
  options: RegisterRunRoutesOptions,
): void => {
  const requireService = (): RunService => {
    if (!options.runService) throw serviceUnavailableError()
    return options.runService
  }

  api.post('/runs', async (request) => {
    if (!options.acceptsRuns) throw serviceUnavailableError()
    const service = requireService()
    const body = decode(createAnalysisRunSchema, request.body, 'analysis.request.invalid')
    return service.createRun(readIdentity(request), body.request)
  })

  api.put<{ Params: SourceParams }>('/runs/:runId/sources/:sourceId', async (request) => {
    const service = requireService()
    const runId = readRunId(request.params.runId)
    const sourceId = decode(identifierSchema, request.params.sourceId, 'analysis.source.id_invalid')
    const body = decode(uploadSourcePartSchema, request.body, 'analysis.source.part_invalid')
    if (body.sourceId !== sourceId) throw invalidRequest('analysis.source.route_mismatch')
    return service.uploadSource(readIdentity(request), runId, body)
  })

  api.post<{ Params: RunParams }>('/runs/:runId/start', async (request) => {
    const service = requireService()
    const body = decode(startRunRequestSchema, request.body, 'analysis.run.start_invalid')
    return service.startRun(readIdentity(request), readRunId(request.params.runId), body.expectedRevision)
  })

  api.get<{ Params: RunParams }>('/runs/:runId', async (request) => {
    return requireService().getRun(readIdentity(request), readRunId(request.params.runId))
  })

  api.get<{ Params: RunParams }>('/runs/:runId/events', async (request, reply) => {
    await streamEvents(request, reply, requireService(), config)
  })

  api.post<{ Params: RunParams }>('/runs/:runId/cancel', async (request) => {
    const body = decode(cancelRunRequestSchema, request.body, 'analysis.run.cancel_invalid')
    return requireService().cancel(
      readIdentity(request),
      readRunId(request.params.runId),
      body.expectedRevision,
    )
  })

  api.post<{ Params: ArtifactParams }>('/runs/:runId/artifacts/:kind/retry', async (request) => {
    const routeKind = decode(artifactKindSchema, request.params.kind, 'analysis.artifact.kind_invalid')
    const body = decode(retryArtifactRequestSchema, request.body, 'analysis.artifact.retry_invalid')
    if (body.kind !== routeKind) throw invalidRequest('analysis.artifact.route_mismatch')
    return requireService().retryArtifact(
      readIdentity(request),
      readRunId(request.params.runId),
      routeKind,
      body.expectedRevision,
    )
  })

  api.get<{ Params: ArtifactParams }>('/runs/:runId/artifacts/:kind', async (request) => {
    const kind = decode(artifactKindSchema, request.params.kind, 'analysis.artifact.kind_invalid')
    return requireService().getArtifact(
      readIdentity(request),
      readRunId(request.params.runId),
      kind,
    )
  })

  api.delete<{ Params: RunParams }>('/runs/:runId/content', async (request) => {
    return requireService().deleteContent(readIdentity(request), readRunId(request.params.runId))
  })
}
