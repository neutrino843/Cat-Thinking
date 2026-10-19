import { personalProviderActionSchema, personalProviderModelsInputSchema, personalProviderModelsResultSchema, personalProviderSettingsInputSchema } from '@cat-thinking/analysis-contracts'
import type { FastifyInstance } from 'fastify'
import { ServiceHttpError, createContractError, serviceUnavailableError } from '../errors.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError } from '../personal/profileStore.js'
import { unavailablePersonalStatus, type PersonalAnalysisRuntime } from '../personal/personalRuntime.js'
import { ProviderConnectionError } from '../providers/providerConnection.js'
import { z } from 'zod'
import { LOCAL_MODELS } from '../personal/localModels.js'

const decode = <T>(schema: { parse(value: unknown): T }, value: unknown): T => {
  try { return schema.parse(value) } catch { throw new ServiceHttpError(400, createContractError('invalid_request', 'client', false, 'analysis.personal.settings_invalid')) }
}
const classifyPersonalError = (error: unknown): never => {
  if (error instanceof PersonalProfileConflictError) throw new ServiceHttpError(409,
    createContractError('conflict', 'conflict', false, 'analysis.personal.profile_changed'))
  if (error instanceof PersonalProfileUnavailableError) throw serviceUnavailableError()
  if (error instanceof ProviderConnectionError) throw new ServiceHttpError(400,
    createContractError('invalid_request', 'client', false, error.safeCode === 'credentials_required'
      ? 'analysis.personal.credentials_required' : error.safeCode === 'credentials_rejected'
        ? 'analysis.personal.credentials_rejected' : error.safeCode === 'models_unsupported'
          ? 'analysis.personal.models_not_supported' : 'analysis.personal.connection_failed'))
  throw error
}

/** Registered inside the existing exact-origin and service-token API scope. */
export const registerPersonalRoutes = (api: FastifyInstance, personal?: PersonalAnalysisRuntime): void => {
  const run = async <T>(operation: (runtime: PersonalAnalysisRuntime) => Promise<T>): Promise<T> => {
    if (!personal) throw serviceUnavailableError()
    try { return await operation(personal) } catch (error) { return classifyPersonalError(error) }
  }
  api.get('/personal/settings', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return personal ? run((runtime) => runtime.status()) : unavailablePersonalStatus()
  })
  api.post('/personal/chat', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = decode(z.object({ question: z.string().trim().min(1).max(2000), context: z.string().max(12000).default(''), expectedRevision: z.number().int().nonnegative().safe().optional() }).strict(), request.body)
    return run((runtime) => runtime.chat(input))
  })
  api.get('/personal/local-models', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return run((runtime) => runtime.localModels.status())
  })
  api.get('/personal/local-models/storage', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return run((runtime) => runtime.localModels.storage())
  })
  api.post('/personal/local-models/storage', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = decode(z.object({ directory: z.string().trim().min(1).max(2048).optional(), save: z.boolean().optional() }).strict(), request.body)
    return run((runtime) => input.save && input.directory ? runtime.localModels.configureStorage(input.directory) : runtime.localModels.storage(input.directory))
  })
  api.post('/personal/local-models/:action', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const { action } = decode(z.object({ action: z.enum(['start', 'stop', 'pull', 'cancel']) }), request.params)
    const input = decode(z.object({ model: z.enum(LOCAL_MODELS).optional() }).strict(), request.body)
    return run(async (runtime) => {
      if (action === 'start') return runtime.localModels.start()
      if (action === 'stop') return runtime.localModels.stop()
      if (action === 'cancel') { runtime.localModels.cancel(); return runtime.localModels.status() }
      if (!input.model) throw new ProviderConnectionError('model_required')
      runtime.localModels.pull(input.model)
      return runtime.localModels.status()
    })
  })
  api.put('/personal/settings', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = decode(personalProviderSettingsInputSchema, request.body)
    return run((runtime) => runtime.save(input))
  })
  api.post('/personal/models', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = decode(personalProviderModelsInputSchema, request.body)
    return personalProviderModelsResultSchema.parse(await run((runtime) => runtime.models(input)))
  })
  for (const action of ['check', 'enable', 'pause'] as const) {
    api.post(`/personal/${action}`, async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const input = decode(personalProviderActionSchema, request.body)
      return run((runtime) => runtime[action](input.expectedRevision))
    })
  }
  api.delete('/personal/settings', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = decode(personalProviderActionSchema, request.body)
    return run((runtime) => runtime.clear(input.expectedRevision))
  })
}
