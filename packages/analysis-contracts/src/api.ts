import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, ARTIFACT_KINDS, QUALITY_PROFILES } from './constants'
import { byteCountSchema, identifierSchema } from './common'
import { artifactKindSchema } from './artifacts'
import { analysisRequestSchema, analysisRunSchema } from './runs'

export const engineCapabilitiesSchema = z
  .object({
    service: z.literal('cat-analysis-engine'),
    serviceVersion: z.string().trim().min(1).max(100),
    contractVersions: z.array(z.literal(ANALYSIS_CONTRACT_VERSION)).min(1),
    qualityProfiles: z.array(z.enum(QUALITY_PROFILES)).min(1).max(QUALITY_PROFILES.length),
    artifactKinds: z.array(z.enum(ARTIFACT_KINDS)).min(1).max(ARTIFACT_KINDS.length),
    maxSourcesPerRun: z.number().int().positive(),
    maxSourceCharacters: z.number().int().positive(),
    maxUploadPartBytes: byteCountSchema,
    supportsSse: z.boolean(),
    supportsCancellation: z.boolean(),
    supportsExternalKnowledge: z.boolean(),
    retentionSeconds: z.number().int().nonnegative(),
  })
  .strict()

export const createAnalysisRunSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    request: analysisRequestSchema,
  })
  .strict()

export const runCreatedSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    run: analysisRunSchema,
    reused: z.boolean(),
  })
  .strict()

export const startRunRequestSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    expectedRevision: z.number().int().positive(),
  })
  .strict()

export const startRunResultSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    run: analysisRunSchema,
  })
  .strict()

export const cancelRunRequestSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    expectedRevision: z.number().int().positive(),
  })
  .strict()

export const cancelRunResultSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    runId: identifierSchema,
    revision: z.number().int().positive(),
    accepted: z.boolean(),
  })
  .strict()

export const retryArtifactRequestSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    kind: artifactKindSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict()

export const retryArtifactAcceptedSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    runId: identifierSchema,
    kind: artifactKindSchema,
    revision: z.number().int().positive(),
    accepted: z.boolean(),
  })
  .strict()

export const deleteRunContentResultSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    runId: identifierSchema,
    deleted: z.boolean(),
  })
  .strict()

export type EngineCapabilitiesV1 = z.infer<typeof engineCapabilitiesSchema>
export type CreateAnalysisRunV1 = z.infer<typeof createAnalysisRunSchema>
export type RunCreatedV1 = z.infer<typeof runCreatedSchema>
export type StartRunRequestV1 = z.infer<typeof startRunRequestSchema>
export type StartRunResultV1 = z.infer<typeof startRunResultSchema>
export type CancelRunRequestV1 = z.infer<typeof cancelRunRequestSchema>
export type CancelRunResultV1 = z.infer<typeof cancelRunResultSchema>
export type RetryArtifactRequestV1 = z.infer<typeof retryArtifactRequestSchema>
export type RetryArtifactAcceptedV1 = z.infer<typeof retryArtifactAcceptedSchema>
export type DeleteRunContentResultV1 = z.infer<typeof deleteRunContentResultSchema>
