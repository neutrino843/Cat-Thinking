import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, ANALYSIS_LIMITS, ARTIFACT_KINDS } from './constants'
import { boundedTextSchema, identifierSchema, timestampSchema, uniqueValues } from './common'
import { citationSchema } from './citations'

export const artifactKindSchema = z.enum(ARTIFACT_KINDS)

export const groundedTextSchema = z
  .object({
    id: identifierSchema,
    text: boundedTextSchema,
    evidenceIds: z.array(identifierSchema).max(100),
    citations: z.array(citationSchema).min(1).max(ANALYSIS_LIMITS.maxCitationCount),
  })
  .strict()

export const summaryArtifactSchema = z
  .object({
    overview: groundedTextSchema,
    keyPoints: z.array(groundedTextSchema).min(1).max(100),
    confusions: z.array(groundedTextSchema).max(50),
    conclusion: groundedTextSchema.optional(),
  })
  .strict()

export interface OutlineNodeV1 {
  id: string
  title: string
  summary?: string
  evidenceIds: string[]
  citations: z.infer<typeof citationSchema>[]
  children: OutlineNodeV1[]
}

export const outlineNodeSchema: z.ZodType<OutlineNodeV1> = z.lazy(() =>
  z
    .object({
      id: identifierSchema,
      title: boundedTextSchema.max(1_000),
      summary: z.string().trim().max(5_000).optional(),
      evidenceIds: z.array(identifierSchema).max(100),
      citations: z.array(citationSchema).max(ANALYSIS_LIMITS.maxCitationCount),
      children: z.array(outlineNodeSchema).max(100),
    })
    .strict(),
)

export const outlineArtifactSchema = z
  .object({
    title: boundedTextSchema.max(1_000),
    nodes: z.array(outlineNodeSchema).min(1).max(100),
  })
  .strict()

export const mindMapNodeSchema = z
  .object({
    id: identifierSchema,
    parentId: identifierSchema.nullable(),
    text: boundedTextSchema.max(1_000),
    note: z.string().trim().max(5_000).optional(),
    evidenceIds: z.array(identifierSchema).max(100),
    citations: z.array(citationSchema).max(ANALYSIS_LIMITS.maxCitationCount),
  })
  .strict()

export const mindMapRelationSchema = z
  .object({
    id: identifierSchema,
    from: identifierSchema,
    to: identifierSchema,
    label: z.string().trim().max(500).optional(),
    evidenceIds: z.array(identifierSchema).max(100),
    citations: z.array(citationSchema).max(ANALYSIS_LIMITS.maxCitationCount),
  })
  .strict()

export const mindMapArtifactSchema = z
  .object({
    title: boundedTextSchema.max(1_000),
    nodes: z.array(mindMapNodeSchema).min(1).max(ANALYSIS_LIMITS.maxMindMapNodes),
    relations: z.array(mindMapRelationSchema).max(ANALYSIS_LIMITS.maxMindMapNodes).default([]),
  })
  .strict()
  .superRefine((artifact, context) => {
    const nodeIds = artifact.nodes.map((node) => node.id)
    if (!uniqueValues(nodeIds)) {
      context.addIssue({ code: 'custom', message: 'mind map node ids must be unique', path: ['nodes'] })
    }
    const relationIds = artifact.relations.map((relation) => relation.id)
    if (!uniqueValues(relationIds)) {
      context.addIssue({ code: 'custom', message: 'mind map relation ids must be unique', path: ['relations'] })
    }
  })

const quizQuestionBase = z.object({
  id: identifierSchema,
  prompt: boundedTextSchema,
  explanation: boundedTextSchema,
  difficulty: z.enum(['easy', 'medium', 'hard']),
  evidenceIds: z.array(identifierSchema).min(1).max(100),
  citations: z.array(citationSchema).min(1).max(ANALYSIS_LIMITS.maxCitationCount),
})

export const multipleChoiceQuestionSchema = quizQuestionBase
  .extend({
    type: z.literal('multiple-choice'),
    options: z.array(boundedTextSchema.max(2_000)).min(2).max(6),
    answerIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.answerIndex >= question.options.length) {
      context.addIssue({ code: 'custom', message: 'answerIndex exceeds options', path: ['answerIndex'] })
    }
    const normalized = question.options.map((option) => option.trim().toLocaleLowerCase())
    if (!uniqueValues(normalized)) {
      context.addIssue({ code: 'custom', message: 'options must be unique', path: ['options'] })
    }
  })

export const trueFalseQuestionSchema = quizQuestionBase
  .extend({
    type: z.literal('true-false'),
    answer: z.boolean(),
  })
  .strict()

export const shortAnswerQuestionSchema = quizQuestionBase
  .extend({
    type: z.literal('short-answer'),
    answer: boundedTextSchema,
    rubric: z.array(boundedTextSchema).min(1).max(20),
  })
  .strict()

export const quizQuestionSchema = z.union([
  multipleChoiceQuestionSchema,
  trueFalseQuestionSchema,
  shortAnswerQuestionSchema,
])

export const quizArtifactSchema = z
  .object({
    title: boundedTextSchema.max(1_000),
    questions: z.array(quizQuestionSchema).min(1).max(ANALYSIS_LIMITS.maxQuizQuestions),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (!uniqueValues(artifact.questions.map((question) => question.id))) {
      context.addIssue({ code: 'custom', message: 'question ids must be unique', path: ['questions'] })
    }
  })

export const knowledgeItemSchema = z
  .object({
    id: identifierSchema,
    title: boundedTextSchema.max(1_000),
    explanation: boundedTextSchema,
    relationship: z.enum(['prerequisite', 'analogy', 'application', 'contrast', 'extension']),
    provenance: z.enum(['source', 'inference', 'external']),
    evidenceIds: z.array(identifierSchema).max(100),
    citations: z.array(citationSchema).min(1).max(ANALYSIS_LIMITS.maxCitationCount),
  })
  .strict()
  .superRefine((item, context) => {
    if (!item.citations.some((citation) => citation.provenance === item.provenance)) {
      context.addIssue({
        code: 'custom',
        message: 'knowledge provenance requires a matching citation',
        path: ['citations'],
      })
    }
  })

export const knowledgeArtifactSchema = z
  .object({
    items: z.array(knowledgeItemSchema).min(1).max(ANALYSIS_LIMITS.maxKnowledgeItems),
  })
  .strict()

const artifactEnvelopeBase = z.object({
  version: z.literal(ANALYSIS_CONTRACT_VERSION),
  schemaVersion: z.literal(ANALYSIS_CONTRACT_VERSION),
  id: identifierSchema,
  runId: identifierSchema,
  docId: identifierSchema,
  sourceContentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(ANALYSIS_LIMITS.maxSourcesPerRun),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const summaryArtifactEnvelopeSchema = artifactEnvelopeBase
  .extend({ kind: z.literal('summary'), payload: summaryArtifactSchema })
  .strict()
export const outlineArtifactEnvelopeSchema = artifactEnvelopeBase
  .extend({ kind: z.literal('outline'), payload: outlineArtifactSchema })
  .strict()
export const mindMapArtifactEnvelopeSchema = artifactEnvelopeBase
  .extend({ kind: z.literal('mindmap'), payload: mindMapArtifactSchema })
  .strict()
export const quizArtifactEnvelopeSchema = artifactEnvelopeBase
  .extend({ kind: z.literal('quiz'), payload: quizArtifactSchema })
  .strict()
export const knowledgeArtifactEnvelopeSchema = artifactEnvelopeBase
  .extend({ kind: z.literal('knowledge'), payload: knowledgeArtifactSchema })
  .strict()

export const artifactEnvelopeSchema = z.discriminatedUnion('kind', [
  summaryArtifactEnvelopeSchema,
  outlineArtifactEnvelopeSchema,
  mindMapArtifactEnvelopeSchema,
  quizArtifactEnvelopeSchema,
  knowledgeArtifactEnvelopeSchema,
])

export type ArtifactKind = z.infer<typeof artifactKindSchema>
export type SummaryArtifactV1 = z.infer<typeof summaryArtifactSchema>
export type OutlineArtifactV1 = z.infer<typeof outlineArtifactSchema>
export type MindMapArtifactV1 = z.infer<typeof mindMapArtifactSchema>
export type QuizArtifactV1 = z.infer<typeof quizArtifactSchema>
export type KnowledgeArtifactV1 = z.infer<typeof knowledgeArtifactSchema>
export type ArtifactEnvelopeV1 = z.infer<typeof artifactEnvelopeSchema>
