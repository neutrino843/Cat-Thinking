import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, CANCEL_EFFECTS } from './constants.js'
import { identifierSchema, timestampSchema, unitIntervalSchema } from './common.js'
import { analysisErrorSchema } from './errors.js'
import { artifactDescriptorSchema, artifactKindSchema } from './artifacts.js'
import { coverageSchema, runStageSchema, usageSchema } from './runs.js'

const eventBase = z.object({
  version: z.literal(ANALYSIS_CONTRACT_VERSION),
  eventId: identifierSchema,
  runId: identifierSchema,
  runRevision: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  createdAt: timestampSchema,
})

export const runAcceptedEventSchema = eventBase
  .extend({ type: z.literal('run.accepted'), requestKey: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()

export const stageStartedEventSchema = eventBase
  .extend({ type: z.literal('stage.started'), stage: runStageSchema })
  .strict()

export const progressEventSchema = eventBase
  .extend({
    type: z.literal('progress.updated'),
    stage: runStageSchema,
    progress: unitIntervalSchema,
  })
  .strict()

export const evidenceProgressEventSchema = eventBase
  .extend({
    type: z.literal('evidence.progress'),
    coverage: coverageSchema,
    missingChunkIds: z.array(identifierSchema).max(1_000),
  })
  .strict()

export const evidenceReadyEventSchema = eventBase
  .extend({
    type: z.literal('evidence.ready'),
    graphHash: z.string().regex(/^[a-f0-9]{64}$/),
    cardCount: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
    coverage: coverageSchema,
  })
  .strict()

export const usageEventSchema = eventBase
  .extend({ type: z.literal('usage.updated'), usage: usageSchema })
  .strict()

export const artifactReadyEventSchema = eventBase
  .extend({ type: z.literal('artifact.ready'), descriptor: artifactDescriptorSchema })
  .strict()
  .superRefine((event, context) => {
    if (event.descriptor.runId !== event.runId) {
      context.addIssue({
        code: 'custom',
        message: 'artifact descriptor runId differs from event runId',
        path: ['descriptor', 'runId'],
      })
    }
  })

export const artifactFailedEventSchema = eventBase
  .extend({ type: z.literal('artifact.failed'), kind: artifactKindSchema, error: analysisErrorSchema })
  .strict()

export const runCompletedEventSchema = eventBase
  .extend({ type: z.literal('run.completed'), status: z.enum(['partial', 'succeeded']), coverage: coverageSchema })
  .strict()

export const runCancelledEventSchema = eventBase
  .extend({ type: z.literal('run.cancelled'), effect: z.enum(CANCEL_EFFECTS) })
  .strict()

export const runFailedEventSchema = eventBase
  .extend({ type: z.literal('run.failed'), error: analysisErrorSchema })
  .strict()

export const runExpiredEventSchema = eventBase
  .extend({ type: z.literal('run.expired'), reason: z.literal('retention_elapsed') })
  .strict()

export const analysisEventSchema = z.union([
  runAcceptedEventSchema,
  stageStartedEventSchema,
  progressEventSchema,
  evidenceProgressEventSchema,
  evidenceReadyEventSchema,
  usageEventSchema,
  artifactReadyEventSchema,
  artifactFailedEventSchema,
  runCompletedEventSchema,
  runCancelledEventSchema,
  runFailedEventSchema,
  runExpiredEventSchema,
])

export type AnalysisEventV1 = z.infer<typeof analysisEventSchema>
