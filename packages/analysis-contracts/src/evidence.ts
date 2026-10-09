import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION } from './constants.js'
import { boundedTextSchema, identifierSchema, sha256Schema, uniqueValues } from './common.js'
import { sourceCitationSchema } from './citations.js'

export const evidenceClaimKindSchema = z.enum([
  'definition',
  'fact',
  'procedure',
  'formula',
  'relationship',
  'example',
])

export const evidenceClaimSchema = z
  .object({
    id: identifierSchema,
    kind: evidenceClaimKindSchema,
    statement: boundedTextSchema,
    conceptIds: z.array(identifierSchema).max(50),
    citations: z.array(sourceCitationSchema).min(1).max(20),
  })
  .strict()

export const evidenceTermSchema = z
  .object({
    id: identifierSchema,
    term: boundedTextSchema.max(500),
    definition: boundedTextSchema.optional(),
    citations: z.array(sourceCitationSchema).min(1).max(20),
  })
  .strict()

export const learningObjectiveSchema = z
  .object({
    id: identifierSchema,
    text: boundedTextSchema,
    evidenceIds: z.array(identifierSchema).min(1).max(100),
  })
  .strict()

export const evidenceCardSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    chunkId: identifierSchema,
    chunkHash: sha256Schema,
    sourceId: identifierSchema,
    titlePath: z.array(z.string().trim().min(1).max(500)).max(32),
    claims: z.array(evidenceClaimSchema).max(200),
    terms: z.array(evidenceTermSchema).max(200),
    learningObjectives: z.array(learningObjectiveSchema).max(100),
  })
  .strict()
  .superRefine((card, context) => {
    const ids = [
      ...card.claims.map((claim) => claim.id),
      ...card.terms.map((term) => term.id),
      ...card.learningObjectives.map((objective) => objective.id),
    ]
    if (!uniqueValues(ids)) {
      context.addIssue({ code: 'custom', message: 'evidence ids must be unique', path: ['claims'] })
    }
  })

export type EvidenceClaimV1 = z.infer<typeof evidenceClaimSchema>
export type EvidenceCardV1 = z.infer<typeof evidenceCardSchema>
