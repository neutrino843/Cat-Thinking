import { personalProviderActionSchema, personalProviderModelsInputSchema, personalProviderModelsResultSchema, personalProviderSettingsInputSchema } from '@cat-thinking/analysis-contracts'
import type { FastifyInstance } from 'fastify'
import { ServiceHttpError, createContractError, serviceUnavailableError } from '../errors.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError } from '../personal/profileStore.js'
import { unavailablePersonalStatus, type PersonalAnalysisRuntime } from '../personal/personalRuntime.js'
import { ProviderConnectionError } from '../providers/providerConnection.js'

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
