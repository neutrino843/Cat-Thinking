import { createHash, timingSafeEqual } from 'node:crypto'
import { identifierSchema } from '@cat-thinking/analysis-contracts'
import type { FastifyRequest } from 'fastify'
import type { AnalysisServiceConfig } from '../config.js'
import { ServiceHttpError, createContractError } from '../errors.js'

export interface RequestIdentity {
  readonly tenantId: string
  readonly authentication: 'disabled' | 'service-token'
}

declare module 'fastify' {
  interface FastifyRequest {
    analysisIdentity: RequestIdentity | null
  }
}

const unauthorized = (): ServiceHttpError => new ServiceHttpError(
  401,
  createContractError('unauthorized', 'authentication', false, 'analysis.auth.unauthorized'),
)

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

export const constantTimeTokenMatch = (candidate: string, expected: string): boolean =>
  timingSafeEqual(digest(candidate), digest(expected))

const readSingleHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

const readBearerToken = (request: FastifyRequest): string | undefined => {
  const authorization = readSingleHeader(request.headers.authorization)
  if (!authorization?.startsWith('Bearer ')) return undefined
  const token = authorization.slice('Bearer '.length)
  return token.length > 0 ? token : undefined
}

const readTenantId = (request: FastifyRequest): string | undefined => {
  const candidate = readSingleHeader(request.headers['x-cat-tenant-id'])
  const parsed = identifierSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

export const createAuthenticationHook = (config: AnalysisServiceConfig) => async (
  request: FastifyRequest,
): Promise<void> => {
  if (config.auth.mode === 'disabled') {
    request.analysisIdentity = Object.freeze({
      tenantId: readTenantId(request) ?? 'local-development',
      authentication: 'disabled',
    })
    return
  }

  const token = readBearerToken(request)
  const tenantId = readTenantId(request)
  if (!token || !tenantId || !constantTimeTokenMatch(token, config.auth.token)) throw unauthorized()
  request.analysisIdentity = Object.freeze({ tenantId, authentication: 'service-token' })
}
