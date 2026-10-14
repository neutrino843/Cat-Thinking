import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION } from './constants.js'
import { identifierSchema, sha256Schema } from './common.js'
import { analysisRunSchema, usageSchema } from './runs.js'

export const lookupRunByRequestKeyQuerySchema = z.object({ requestKey: sha256Schema }).strict()
export const runRequestLookupSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(ANALYSIS_CONTRACT_VERSION), status: z.literal('found'), run: analysisRunSchema }).strict(),
  z.object({ version: z.literal(ANALYSIS_CONTRACT_VERSION), status: z.literal('absent') }).strict(),
  z.object({ version: z.literal(ANALYSIS_CONTRACT_VERSION), status: z.literal('abandoned'), runId: identifierSchema.optional() }).strict(),
])
export const abandonRunRequestSchema = z.object({
  version: z.literal(ANALYSIS_CONTRACT_VERSION), requestKey: sha256Schema,
}).strict()
export const abandonRunRequestResultSchema = z.object({
  version: z.literal(ANALYSIS_CONTRACT_VERSION), requestKey: sha256Schema,
  abandoned: z.literal(true), runId: identifierSchema.optional(),
}).strict()
export const runUsageSchema = z.object({
  version: z.literal(ANALYSIS_CONTRACT_VERSION), runId: identifierSchema,
  usage: usageSchema, invocationCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(),
  completeness: z.enum(['complete', 'unresolved']),
}).strict().superRefine((value, context) => {
  if (value.unresolvedCount > value.invocationCount || (value.completeness === 'complete') !== (value.unresolvedCount === 0)) {
    context.addIssue({ code: 'custom', path: ['completeness'], message: 'usage completeness must match unresolved invocations' })
  }
})
export type RunRequestLookupV1 = z.infer<typeof runRequestLookupSchema>
export type AbandonRunRequestResultV1 = z.infer<typeof abandonRunRequestResultSchema>
export type RunUsageV1 = z.infer<typeof runUsageSchema>
