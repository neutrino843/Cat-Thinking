import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION } from './constants.js'
import { boundedTextSchema, identifierSchema } from './common.js'
import { sourceRangeSchema } from './sources.js'

export const sourceCitationSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    provenance: z.literal('source'),
    sourceId: identifierSchema,
    start: sourceRangeSchema.shape.start,
    end: sourceRangeSchema.shape.end,
    page: z.number().int().positive().max(100_000).optional(),
    locator: z.string().trim().max(500).optional(),
    quote: z.string().max(2_000).optional(),
  })
  .strict()
  .refine((citation) => citation.end > citation.start, {
    message: 'citation end must be greater than start',
    path: ['end'],
  })

export const inferenceCitationSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    provenance: z.literal('inference'),
    label: boundedTextSchema.max(500).optional(),
  })
  .strict()

export const externalCitationSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    provenance: z.literal('external'),
    externalSourceId: identifierSchema,
    label: boundedTextSchema.max(500).optional(),
  })
  .strict()

export const citationSchema = z.discriminatedUnion('provenance', [
  sourceCitationSchema,
  inferenceCitationSchema,
  externalCitationSchema,
])

export type SourceCitationV1 = z.infer<typeof sourceCitationSchema>
export type CitationV1 = z.infer<typeof citationSchema>
