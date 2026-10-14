import type { FastifyRequest } from 'fastify'
import { ServiceHttpError, createContractError } from '../errors.js'

const forbiddenOrigin = (): ServiceHttpError => new ServiceHttpError(
  403,
  createContractError('forbidden', 'authorization', false, 'analysis.origin.forbidden'),
)

export const createOriginGuard = (allowedOrigins: readonly string[]) => {
  const allowed = new Set(allowedOrigins)
  return async (request: FastifyRequest): Promise<void> => {
    const fetchSite = request.headers['sec-fetch-site']
    if (fetchSite === 'cross-site') throw forbiddenOrigin()
    const origin = request.headers.origin
    if (origin !== undefined && !allowed.has(origin)) throw forbiddenOrigin()
  }
}
