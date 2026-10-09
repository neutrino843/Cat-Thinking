import type { FastifyServerOptions } from 'fastify'
import type { AnalysisServiceConfig } from '../config.js'

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-analysis-service-token',
  'res.headers.set-cookie',
  'authorization',
  'cookie',
  'token',
  'secret',
] as const

export const createLoggerOptions = (
  config: AnalysisServiceConfig,
): FastifyServerOptions['logger'] => config.logLevel === 'silent'
  ? false
  : {
      level: config.logLevel,
      redact: {
        paths: [...REDACTED_PATHS],
        censor: '[REDACTED]',
      },
    }

export const loggerRedactionPaths = (): readonly string[] => REDACTED_PATHS
