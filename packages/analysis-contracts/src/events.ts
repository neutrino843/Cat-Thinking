import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, CANCEL_EFFECTS } from './constants'
import { identifierSchema, timestampSchema, unitIntervalSchema } from './common'
import { analysisErrorSchema } from './errors'
import { artifactEnvelopeSchema, artifactKindSchema } from './artifacts'
import { coverageSchema, runStageSchema, usageSchema } from './runs'

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

export const usageEventSchema = eventBase
  .extend({ type: z.literal('usage.updated'), usage: usageSchema })
  .strict()

export const artifactReadyEventSchema = eventBase
  .extend({ type: z.literal('artifact.ready'), artifact: artifactEnvelopeSchema })
  .strict()
  .superRefine((event, context) => {
    if (event.artifact.runId !== event.runId) {
      context.addIssue({ code: 'custom', message: 'artifact runId differs from event runId', path: ['artifact', 'runId'] })
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

export const analysisEventSchema = z.union([
  runAcceptedEventSchema,
  stageStartedEventSchema,
  progressEventSchema,
  evidenceProgressEventSchema,
  usageEventSchema,
  artifactReadyEventSchema,
  artifactFailedEventSchema,
  runCompletedEventSchema,
  runCancelledEventSchema,
  runFailedEventSchema,
])

export type AnalysisEventV1 = z.infer<typeof analysisEventSchema>
