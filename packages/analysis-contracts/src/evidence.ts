import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, ANALYSIS_LIMITS } from './constants.js'
import {
  boundedTextSchema,
  identifierSchema,
  sha256Schema,
  timestampSchema,
  uniqueValues,
} from './common.js'
import { sourceCitationSchema } from './citations.js'
import { coverageSchema } from './runs.js'

export const evidenceChunkSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    chunkId: identifierSchema,
    chunkHash: sha256Schema,
    sourceId: identifierSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    titlePath: z.array(z.string().trim().min(1).max(500)).max(32),
    pageStart: z.number().int().positive().max(100_000).optional(),
    pageEnd: z.number().int().positive().max(100_000).optional(),
    estimatedTokens: z.number().int().positive(),
    ordinal: z.number().int().nonnegative(),
    total: z.number().int().positive().max(ANALYSIS_LIMITS.maxEvidenceChunks),
    overlapBefore: z.number().int().nonnegative(),
    overlapAfter: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.end <= chunk.start) {
      context.addIssue({ code: 'custom', message: 'chunk end must be greater than start', path: ['end'] })
    }
    if (chunk.ordinal >= chunk.total) {
      context.addIssue({ code: 'custom', message: 'chunk ordinal exceeds total', path: ['ordinal'] })
    }
    if (chunk.pageStart !== undefined && chunk.pageEnd !== undefined && chunk.pageEnd < chunk.pageStart) {
      context.addIssue({ code: 'custom', message: 'pageEnd precedes pageStart', path: ['pageEnd'] })
    }
  })

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

export const evidenceGraphSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    runId: identifierSchema,
    graphHash: sha256Schema,
    chunkPlanHash: sha256Schema,
    sourceContentHashes: z.array(sha256Schema).min(1).max(ANALYSIS_LIMITS.maxSourcesPerRun),
    policyVersion: identifierSchema,
    promptVersion: identifierSchema,
    generatorProfile: identifierSchema,
    chunks: z.array(evidenceChunkSchema).min(1).max(ANALYSIS_LIMITS.maxEvidenceChunks),
    cards: z.array(evidenceCardSchema).min(1).max(ANALYSIS_LIMITS.maxEvidenceCards),
    claims: z.array(evidenceClaimSchema).max(ANALYSIS_LIMITS.maxEvidenceClaims),
    terms: z.array(evidenceTermSchema).max(ANALYSIS_LIMITS.maxEvidenceTerms),
    learningObjectives: z.array(learningObjectiveSchema).max(ANALYSIS_LIMITS.maxLearningObjectives),
    coverage: coverageSchema,
    missingChunkIds: z.array(identifierSchema).max(ANALYSIS_LIMITS.maxEvidenceChunks),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((graph, context) => {
    if (!uniqueValues(graph.chunks.map((chunk) => chunk.chunkId))) {
      context.addIssue({ code: 'custom', message: 'chunk ids must be unique', path: ['chunks'] })
    }
    if (!uniqueValues(graph.cards.map((card) => card.chunkId))) {
      context.addIssue({ code: 'custom', message: 'card chunk ids must be unique', path: ['cards'] })
    }
    const chunkIds = new Set(graph.chunks.map((chunk) => chunk.chunkId))
    for (const [index, card] of graph.cards.entries()) {
      if (!chunkIds.has(card.chunkId)) {
        context.addIssue({
          code: 'custom',
          message: 'card references an unknown chunk',
          path: ['cards', index, 'chunkId'],
        })
      }
    }
    for (const [field, values] of [
      ['claims', graph.claims],
      ['terms', graph.terms],
      ['learningObjectives', graph.learningObjectives],
    ] as const) {
      if (!uniqueValues(values.map((value) => value.id))) {
        context.addIssue({ code: 'custom', message: `${field} ids must be unique`, path: [field] })
      }
    }
    const graphIds = [
      ...graph.claims.map((claim) => claim.id),
      ...graph.terms.map((term) => term.id),
      ...graph.learningObjectives.map((objective) => objective.id),
    ]
    if (!uniqueValues(graphIds)) {
      context.addIssue({ code: 'custom', message: 'evidence graph ids must be globally unique', path: ['claims'] })
    }
    const evidenceIds = new Set([...graph.claims, ...graph.terms].map((value) => value.id))
    for (const [index, objective] of graph.learningObjectives.entries()) {
      for (const evidenceId of objective.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: 'learning objective references unknown evidence',
            path: ['learningObjectives', index, 'evidenceIds'],
          })
        }
      }
    }
  })

export type EvidenceClaimV1 = z.infer<typeof evidenceClaimSchema>
export type EvidenceCardV1 = z.infer<typeof evidenceCardSchema>
export type EvidenceChunkV1 = z.infer<typeof evidenceChunkSchema>
export type EvidenceGraphV1 = z.infer<typeof evidenceGraphSchema>
