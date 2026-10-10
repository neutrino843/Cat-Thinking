import { z } from 'zod'
import {
  ANALYSIS_CONTRACT_VERSION,
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  QUALITY_PROFILES,
  RUN_STAGES,
  RUN_STATUSES,
} from './constants.js'
import { identifierSchema, sha256Schema, timestampSchema, unitIntervalSchema, uniqueValues } from './common.js'
import { analysisErrorSchema } from './errors.js'
import { artifactKindSchema } from './artifacts.js'
import { sourceManifestSchema } from './sources.js'

export const qualityProfileSchema = z.enum(QUALITY_PROFILES)
export const runStatusSchema = z.enum(RUN_STATUSES)
export const runStageSchema = z.enum(RUN_STAGES)
export const artifactStatusSchema = z.enum(ARTIFACT_STATUSES)

export const analysisOptionsSchema = z
  .object({
    locale: z.string().trim().min(2).max(35),
    qualityProfile: qualityProfileSchema,
    summaryDetail: z.enum(['brief', 'standard', 'detailed']),
    quizQuestionCount: z.number().int().min(1).max(100),
    externalKnowledge: z.boolean(),
  })
  .strict()

export const analysisRequestSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    requestKey: sha256Schema,
    docId: identifierSchema,
    manifest: sourceManifestSchema,
    artifacts: z.array(artifactKindSchema).min(1).max(ARTIFACT_KINDS.length),
    options: analysisOptionsSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (!uniqueValues(request.artifacts)) {
      context.addIssue({ code: 'custom', message: 'artifact kinds must be unique', path: ['artifacts'] })
    }
    if (request.artifacts.includes('mindmap') && !request.artifacts.includes('outline')) {
      context.addIssue({
        code: 'custom',
        message: 'mindmap requires outline',
        path: ['artifacts'],
      })
    }
  })

export const artifactStateSchema = z
  .object({
    status: artifactStatusSchema,
    attempt: z.number().int().nonnegative(),
    artifactId: identifierSchema.optional(),
    error: analysisErrorSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict()

export const artifactStatesSchema = z
  .object({
    summary: artifactStateSchema.optional(),
    outline: artifactStateSchema.optional(),
    mindmap: artifactStateSchema.optional(),
    quiz: artifactStateSchema.optional(),
    knowledge: artifactStateSchema.optional(),
  })
  .strict()

export const coverageSchema = z
  .object({
    input: unitIntervalSchema,
    analysis: unitIntervalSchema,
    citation: unitIntervalSchema.optional(),
    chunksCompleted: z.number().int().nonnegative(),
    chunksFailed: z.number().int().nonnegative(),
    chunksTotal: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.chunksCompleted + coverage.chunksFailed > coverage.chunksTotal) {
      context.addIssue({
        code: 'custom',
        message: 'completed and failed chunks exceed total',
        path: ['chunksCompleted'],
      })
    }
  })

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostMicros: z.number().int().nonnegative(),
    actualCostMicros: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  })
  .strict()

export const providerRouteSchema = z
  .object({
    providerId: identifierSchema,
    modelId: identifierSchema,
    profileVersion: identifierSchema,
    promptVersion: identifierSchema,
  })
  .strict()

export const analysisRunSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    id: identifierSchema,
    docId: identifierSchema,
    requestKey: sha256Schema,
    request: analysisRequestSchema,
    revision: z.number().int().positive(),
    status: runStatusSchema,
    stage: runStageSchema.optional(),
    progress: unitIntervalSchema,
    coverage: coverageSchema,
    providerRoutes: z.array(providerRouteSchema).max(50),
    artifactStates: artifactStatesSchema,
    usage: usageSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    expiresAt: timestampSchema.optional(),
    error: analysisErrorSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.request.docId !== run.docId || run.request.requestKey !== run.requestKey) {
      context.addIssue({ code: 'custom', message: 'run identity differs from request', path: ['request'] })
    }
    const requested = new Set(run.request.artifacts)
    for (const kind of ARTIFACT_KINDS) {
      const state = run.artifactStates[kind]
      if (requested.has(kind) !== (state !== undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'artifactStates must exactly match requested artifacts',
          path: ['artifactStates', kind],
        })
      }
    }
  })

export type QualityProfile = z.infer<typeof qualityProfileSchema>
export type AnalysisOptionsV1 = z.infer<typeof analysisOptionsSchema>
export type AnalysisRequestV1 = z.infer<typeof analysisRequestSchema>
export type ArtifactStateV1 = z.infer<typeof artifactStateSchema>
export type CoverageV1 = z.infer<typeof coverageSchema>
export type UsageV1 = z.infer<typeof usageSchema>
export type ProviderRouteV1 = z.infer<typeof providerRouteSchema>
export type AnalysisRunV1 = z.infer<typeof analysisRunSchema>
