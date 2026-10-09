import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, RUN_STAGES } from './constants.js'
import { identifierSchema, jsonPrimitiveSchema } from './common.js'

export const analysisErrorCodeSchema = z.enum([
  'invalid_request',
  'unsupported_contract',
  'source_missing',
  'source_hash_mismatch',
  'source_too_large',
  'protocol_error',
  'schema_invalid',
  'citation_invalid',
  'artifact_invalid',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'budget_exceeded',
  'provider_timeout',
  'provider_unavailable',
  'provider_rejected',
  'service_unavailable',
  'cancelled',
  'conflict',
  'internal_error',
])

export const analysisErrorCategorySchema = z.enum([
  'client',
  'validation',
  'authentication',
  'authorization',
  'rate-limit',
  'budget',
  'provider',
  'availability',
  'cancellation',
  'conflict',
  'internal',
])

export const analysisErrorSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    code: analysisErrorCodeSchema,
    category: analysisErrorCategorySchema,
    retryable: z.boolean(),
    messageKey: identifierSchema,
    stage: z.enum(RUN_STAGES).optional(),
    details: z.record(z.string().max(80), jsonPrimitiveSchema).optional(),
  })
  .strict()

export type AnalysisErrorCode = z.infer<typeof analysisErrorCodeSchema>
export type AnalysisErrorV1 = z.infer<typeof analysisErrorSchema>
