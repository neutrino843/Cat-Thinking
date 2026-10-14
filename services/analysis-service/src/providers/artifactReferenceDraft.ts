import {
  ANALYSIS_LIMITS, canonicalizeJson, evidenceGraphSchema, groundedTextSchema, identifierSchema,
  knowledgeArtifactSchema, knowledgeItemSchema, mindMapArtifactSchema, mindMapNodeSchema,
  mindMapRelationSchema, multipleChoiceQuestionSchema, outlineArtifactSchema, quizArtifactSchema,
  shortAnswerQuestionSchema, summaryArtifactSchema, trueFalseQuestionSchema,
  type ArtifactEnvelopeV1, type ArtifactKind, type EvidenceGraphV1, type OutlineArtifactV1,
  type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import { ARTIFACT_REFERENCE_DRAFT_VERSION } from '../domain/artifactPolicyVersions.js'
import { normalizeOptionalNulls } from './strictOutputSchema.js'

export { ARTIFACT_REFERENCE_DRAFT_VERSION, ARTIFACT_SOURCE_REFERENCE_VERSIONS,
  ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION } from '../domain/artifactPolicyVersions.js'
export const MAX_ARTIFACT_REFERENCE_OUTLINE_DEPTH = 32

export type ArtifactReferenceDraftFailure = 'schema_invalid' | 'reference_not_found' | 'reference_not_supported'
  | 'evidence_invalid' | 'catalog_invalid' | 'capacity_exceeded' | 'inference_invalid'

/** Contains no source text, model output, credentials or provider error details. */
export class ArtifactReferenceDraftError extends Error {
  constructor(readonly code: ArtifactReferenceDraftFailure) {
    super(`artifact reference draft rejected: ${code}`)
    this.name = 'ArtifactReferenceDraftError'
  }
}

export interface ArtifactSourceReference {
  readonly refId: string
  readonly citation: SourceCitationV1
}
interface DraftSourceCitation { readonly refId: string }
type CompactClaim = Omit<EvidenceGraphV1['claims'][number], 'citations'> & { readonly citations: readonly DraftSourceCitation[] }
type CompactTerm = Omit<EvidenceGraphV1['terms'][number], 'citations'> & { readonly citations: readonly DraftSourceCitation[] }

export interface ArtifactReferenceCatalog {
  readonly draftVersion: typeof ARTIFACT_REFERENCE_DRAFT_VERSION
  readonly references: readonly ArtifactSourceReference[]
  readonly evidence: Readonly<{
    claims: readonly CompactClaim[]
    terms: readonly CompactTerm[]
    learningObjectives: readonly EvidenceGraphV1['learningObjectives'][number][]
  }>
  readonly referenceById: ReadonlyMap<string, SourceCitationV1>
  readonly referencesByEvidenceId: ReadonlyMap<string, ReadonlySet<string>>
}

const sourceReferenceSchema = z.object({ refId: z.string().regex(/^cite-[1-9][0-9]*$/u).max(128) }).strict()
const inferenceReferenceSchema = z.object({
  provenance: z.literal('inference'), label: z.string().trim().min(1).max(500).optional(),
}).strict()
const draftCitationSchema = z.union([sourceReferenceSchema, inferenceReferenceSchema])
const citations = (minimum = 0) => z.array(draftCitationSchema).min(minimum).max(ANALYSIS_LIMITS.maxCitationCount)
const groundedDraftSchema = groundedTextSchema.extend({ citations: citations(1) })
interface OutlineDraftNode {
  id: string
  title: string
  summary?: string
  evidenceIds: string[]
  citations: z.infer<typeof draftCitationSchema>[]
  children: OutlineDraftNode[]
}
const outlineDraftNodeSchema: z.ZodType<OutlineDraftNode> = z.lazy(() => z.object({
  id: identifierSchema, title: z.string().trim().min(1).max(1_000),
  summary: z.string().trim().max(5_000).optional(), evidenceIds: z.array(identifierSchema).max(100),
  citations: citations(), children: z.array(outlineDraftNodeSchema).max(100),
}).strict())

// These are private model drafts. The public Artifact V1 schemas remain unchanged
// and are applied again after program-owned citations have been restored.
const draftPayloadSchemas = {
  summary: summaryArtifactSchema.extend({
    overview: groundedDraftSchema, keyPoints: z.array(groundedDraftSchema).min(1).max(100),
    confusions: z.array(groundedDraftSchema).max(50), conclusion: groundedDraftSchema.optional(),
  }),
  outline: outlineArtifactSchema.extend({ nodes: z.array(outlineDraftNodeSchema).min(1).max(100) }),
  mindmap: z.object({
    title: mindMapArtifactSchema.shape.title,
    nodes: z.array(mindMapNodeSchema.extend({ citations: citations() })).min(1).max(ANALYSIS_LIMITS.maxMindMapNodes),
    relations: z.array(mindMapRelationSchema.extend({ citations: citations() })).max(ANALYSIS_LIMITS.maxMindMapNodes).default([]),
  }).strict(),
  quiz: z.object({
    title: quizArtifactSchema.shape.title,
    questions: z.array(z.union([
      z.object({ ...multipleChoiceQuestionSchema.shape, citations: citations(1) }).strict(),
      trueFalseQuestionSchema.extend({ citations: citations(1) }),
      shortAnswerQuestionSchema.extend({ citations: citations(1) }),
    ])).min(1).max(ANALYSIS_LIMITS.maxQuizQuestions),
  }).strict(),
  knowledge: knowledgeArtifactSchema.extend({ items: z.array(z.object({
    ...knowledgeItemSchema.shape, provenance: z.enum(['source', 'inference']), citations: citations(1),
  }).strict()).min(1).max(ANALYSIS_LIMITS.maxKnowledgeItems) }),
} as const
const publicPayloadSchemas = {
  summary: summaryArtifactSchema, outline: outlineArtifactSchema, mindmap: mindMapArtifactSchema,
  quiz: quizArtifactSchema, knowledge: knowledgeArtifactSchema,
} as const
const wrapperSchemas: Readonly<Record<ArtifactKind, z.ZodType<unknown>>> = {
  summary: z.object({ draftVersion: z.literal(ARTIFACT_REFERENCE_DRAFT_VERSION), payload: draftPayloadSchemas.summary }).strict(),
  outline: z.object({ draftVersion: z.literal(ARTIFACT_REFERENCE_DRAFT_VERSION), payload: draftPayloadSchemas.outline }).strict(),
  mindmap: z.object({ draftVersion: z.literal(ARTIFACT_REFERENCE_DRAFT_VERSION), payload: draftPayloadSchemas.mindmap }).strict(),
  quiz: z.object({ draftVersion: z.literal(ARTIFACT_REFERENCE_DRAFT_VERSION), payload: draftPayloadSchemas.quiz }).strict(),
  knowledge: z.object({ draftVersion: z.literal(ARTIFACT_REFERENCE_DRAFT_VERSION), payload: draftPayloadSchemas.knowledge }).strict(),
}

export const artifactReferenceDraftSchema = (kind: ArtifactKind): z.ZodType<unknown> => wrapperSchemas[kind]
export const artifactReferenceDraftOutputSchema = (kind: ArtifactKind): Readonly<Record<string, unknown>> =>
  z.toJSONSchema(wrapperSchemas[kind], { io: 'input' })

/** Reject cycles/prototype keys before any recursive parser or normalizer runs. */
const inspectDraft = (value: unknown): void => {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }]
  const ancestors = new WeakSet<object>()
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()
    if (!current) break
    if (current.exit) {
      ancestors.delete(current.value as object)
      continue
    }
    if (++nodes > 100_000 || current.depth > 64) throw new ArtifactReferenceDraftError('capacity_exceeded')
    if (current.value === null) continue
    if (typeof current.value !== 'object') {
      if (typeof current.value !== 'string' && typeof current.value !== 'boolean'
        && (typeof current.value !== 'number' || !Number.isFinite(current.value))) {
        throw new ArtifactReferenceDraftError('schema_invalid')
      }
      continue
    }
    if (ancestors.has(current.value)) throw new ArtifactReferenceDraftError('schema_invalid')
    ancestors.add(current.value)
    pending.push({ ...current, exit: true })
    if (!Array.isArray(current.value) && Object.getPrototypeOf(current.value) !== Object.prototype
      && Object.getPrototypeOf(current.value) !== null) throw new ArtifactReferenceDraftError('schema_invalid')
    for (const key of Reflect.ownKeys(current.value)) {
      if (Array.isArray(current.value) && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new ArtifactReferenceDraftError('schema_invalid')
      }
      if (Array.isArray(current.value) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new ArtifactReferenceDraftError('schema_invalid')
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ArtifactReferenceDraftError('schema_invalid')
      pending.push({ value: descriptor.value, depth: current.depth + 1 })
    }
  }
  if (Buffer.byteLength(canonicalizeJson(value), 'utf8') > ANALYSIS_LIMITS.maxArtifactBytes) {
    throw new ArtifactReferenceDraftError('capacity_exceeded')
  }
}

/** The graph's source verification belongs to the existing Evidence validator. */
export const createArtifactReferenceCatalog = (value: EvidenceGraphV1): ArtifactReferenceCatalog => {
  const parsed = evidenceGraphSchema.safeParse(value)
  if (!parsed.success) throw new ArtifactReferenceDraftError('catalog_invalid')
  const graph = parsed.data
  const references: ArtifactSourceReference[] = []
  const referenceById = new Map<string, SourceCitationV1>()
  const referencesByEvidenceId = new Map<string, ReadonlySet<string>>()
  const idsByCitation = new Map<string, string>()
  const chunksBySource = new Map<string, EvidenceGraphV1['chunks']>()
  for (const chunk of graph.chunks) {
    const sourceChunks = chunksBySource.get(chunk.sourceId) ?? []
    sourceChunks.push(chunk)
    chunksBySource.set(chunk.sourceId, sourceChunks)
  }
  const compactCitations = (item: EvidenceGraphV1['claims'][number] | EvidenceGraphV1['terms'][number]): readonly DraftSourceCitation[] => {
    const refs = item.citations.map((citation) => {
      const key = canonicalizeJson(citation)
      let refId = idsByCitation.get(key)
      if (!refId) {
        if (!(chunksBySource.get(citation.sourceId) ?? []).some((chunk) =>
          chunk.start <= citation.start && chunk.end >= citation.end)) throw new ArtifactReferenceDraftError('catalog_invalid')
        refId = `cite-${references.length + 1}`
        const immutableCitation = Object.freeze({ ...citation })
        references.push(Object.freeze({ refId, citation: immutableCitation }))
        idsByCitation.set(key, refId)
        referenceById.set(refId, immutableCitation)
      }
      return Object.freeze({ refId })
    })
    referencesByEvidenceId.set(item.id, new Set(refs.map((ref) => ref.refId)))
    return Object.freeze(refs)
  }
  const claims = graph.claims.map((claim) => {
    Object.freeze(claim.conceptIds)
    return Object.freeze({ ...claim, citations: compactCitations(claim) })
  })
  const terms = graph.terms.map((term) => Object.freeze({ ...term, citations: compactCitations(term) }))
  if (references.length === 0) throw new ArtifactReferenceDraftError('catalog_invalid')
  for (const objective of graph.learningObjectives) {
    const refs = new Set<string>()
    for (const id of objective.evidenceIds) {
      const inherited = referencesByEvidenceId.get(id)
      if (!inherited || inherited.size === 0) throw new ArtifactReferenceDraftError('catalog_invalid')
      for (const ref of inherited) refs.add(ref)
    }
    referencesByEvidenceId.set(objective.id, refs)
  }
  const learningObjectives = graph.learningObjectives.map((objective) => {
    Object.freeze(objective.evidenceIds)
    return Object.freeze(objective)
  })
  const evidence = Object.freeze({ claims: Object.freeze(claims), terms: Object.freeze(terms),
    learningObjectives: Object.freeze(learningObjectives) })
  if (Buffer.byteLength(canonicalizeJson({ references, evidence }), 'utf8') > ANALYSIS_LIMITS.maxArtifactBytes) {
    throw new ArtifactReferenceDraftError('capacity_exceeded')
  }
  return Object.freeze({ draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, references: Object.freeze(references),
    evidence, referenceById, referencesByEvidenceId })
}

const supportedReferences = (evidenceIds: readonly string[], catalog: ArtifactReferenceCatalog): Set<string> => {
  const allowed = new Set<string>()
  for (const id of evidenceIds) {
    const refs = catalog.referencesByEvidenceId.get(id)
    if (!refs) throw new ArtifactReferenceDraftError('evidence_invalid')
    for (const ref of refs) allowed.add(ref)
  }
  return allowed
}

export const hydrateArtifactReferenceDraft = (
  kind: ArtifactKind, value: unknown, catalog: ArtifactReferenceCatalog,
): ArtifactEnvelopeV1['payload'] => {
  inspectDraft(value)
  const decoded = wrapperSchemas[kind].safeParse(normalizeOptionalNulls(value, artifactReferenceDraftOutputSchema(kind)))
  if (!decoded.success) throw new ArtifactReferenceDraftError('schema_invalid')
  const payload = (decoded.data as { payload: unknown }).payload
  let outlineNodes = 0
  const visit = (input: unknown, outlineDepth = 0): unknown => {
    if (Array.isArray(input)) return input.map((item) => visit(item, outlineDepth))
    if (input === null || typeof input !== 'object') return input
    const record = input as Record<string, unknown>
    let nextDepth = outlineDepth
    if ('children' in record) {
      nextDepth += 1
      if (nextDepth > MAX_ARTIFACT_REFERENCE_OUTLINE_DEPTH || ++outlineNodes > ANALYSIS_LIMITS.maxOutlineNodes) {
        throw new ArtifactReferenceDraftError('capacity_exceeded')
      }
    }
    const result = Object.fromEntries(Object.entries(record).map(([key, child]) => [key,
      key === 'citations' ? child : visit(child, nextDepth)]))
    if (!Array.isArray(record.citations) || !Array.isArray(record.evidenceIds)) return result
    const allowed = supportedReferences(record.evidenceIds as string[], catalog)
    let sourceCount = 0
    let inferenceCount = 0
    result.citations = record.citations.map((reference: z.infer<typeof draftCitationSchema>) => {
      if ('refId' in reference) {
        const citation = catalog.referenceById.get(reference.refId)
        if (!citation) throw new ArtifactReferenceDraftError('reference_not_found')
        if (!allowed.has(reference.refId)) throw new ArtifactReferenceDraftError('reference_not_supported')
        sourceCount += 1
        return { ...citation }
      }
      if (kind !== 'knowledge' || record.provenance !== 'inference' || !reference.label?.trim()) {
        throw new ArtifactReferenceDraftError('inference_invalid')
      }
      inferenceCount += 1
      return { version: 1, ...reference }
    })
    if (record.provenance === 'inference' && (sourceCount === 0 || inferenceCount === 0)) {
      throw new ArtifactReferenceDraftError('inference_invalid')
    }
    return result
  }
  const hydrated = publicPayloadSchemas[kind].safeParse(visit(payload))
  if (!hydrated.success) throw new ArtifactReferenceDraftError('schema_invalid')
  return hydrated.data
}

/** Compact a validated Outline for a subsequent map prompt without losing its hierarchy. */
export const compactArtifactOutline = (outline: OutlineArtifactV1, catalog: ArtifactReferenceCatalog): unknown => {
  inspectDraft(outline)
  const decoded = outlineArtifactSchema.safeParse(outline)
  if (!decoded.success) throw new ArtifactReferenceDraftError('schema_invalid')
  const exactByIdentity = new Map(catalog.references.map((ref) => [canonicalizeJson(ref.citation), ref]))
  const refsWithoutQuote = new Map<string, ArtifactSourceReference[]>()
  for (const ref of catalog.references) {
    const withoutQuote = { ...ref.citation }
    delete withoutQuote.quote
    const key = canonicalizeJson(withoutQuote)
    const matching = refsWithoutQuote.get(key) ?? []
    matching.push(ref)
    refsWithoutQuote.set(key, matching)
  }
  let nodeCount = 0
  const compact = (nodes: OutlineArtifactV1['nodes'], depth: number): unknown[] => {
    if (nodes.length === 0) return []
    if (depth > MAX_ARTIFACT_REFERENCE_OUTLINE_DEPTH) throw new ArtifactReferenceDraftError('capacity_exceeded')
    return nodes.map((node) => {
      if (++nodeCount > ANALYSIS_LIMITS.maxOutlineNodes) throw new ArtifactReferenceDraftError('capacity_exceeded')
      const allowed = supportedReferences(node.evidenceIds, catalog)
      return { ...node, citations: node.citations.map((citation) => {
        if (citation.provenance !== 'source') throw new ArtifactReferenceDraftError('catalog_invalid')
        const exact = exactByIdentity.get(canonicalizeJson(citation))
        if (exact && allowed.has(exact.refId)) return { refId: exact.refId }
        // Older validated Outline payloads may omit quote. Only an unambiguous
        // exact match of every remaining identity field is eligible.
        const candidates = citation.quote === undefined
          ? (refsWithoutQuote.get(canonicalizeJson(citation)) ?? []).filter((ref) => allowed.has(ref.refId)) : []
        if (candidates.length !== 1) throw new ArtifactReferenceDraftError('reference_not_supported')
        return { refId: candidates[0].refId }
      }), children: compact(node.children, depth + 1) }
    })
  }
  return { title: decoded.data.title, nodes: compact(decoded.data.nodes, 1) }
}
