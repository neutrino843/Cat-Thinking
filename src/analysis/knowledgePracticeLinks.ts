import {
  ANALYSIS_LIMITS, canonicalizeJson, evidenceGraphSchema, mindMapArtifactEnvelopeSchema,
  quizArtifactEnvelopeSchema, validateMindMapGraph,
  type EvidenceGraphV1, type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'

export const KNOWLEDGE_PRACTICE_LINK_VERSION = 1 as const
export const MAX_KNOWLEDGE_PRACTICE_LINKS = 10_000
export type KnowledgePracticeLinkFailure = 'invalid_artifact' | 'identity_mismatch' | 'duplicate_evidence'
  | 'invalid_graph' | 'unknown_evidence' | 'unsupported_citation' | 'capacity_exceeded'

export class KnowledgePracticeLinkError extends Error {
  constructor(readonly code: KnowledgePracticeLinkFailure) {
    super(`knowledge practice links rejected: ${code}`)
    this.name = 'KnowledgePracticeLinkError'
  }
}

export interface KnowledgePracticeLink {
  readonly nodeId: string
  readonly questionId: string
  readonly sharedEvidenceIds: readonly string[]
  readonly sourceCitations: readonly SourceCitationV1[]
}
export interface KnowledgePracticeLinksV1 {
  readonly version: typeof KNOWLEDGE_PRACTICE_LINK_VERSION
  readonly docId: string
  readonly runId: string
  readonly mindmapArtifactId: string
  readonly quizArtifactId: string
  readonly sourceContentHashes: readonly string[]
  readonly links: readonly KnowledgePracticeLink[]
}
export interface KnowledgePracticeLinkInput {
  readonly mindmap: unknown
  readonly quiz: unknown
  /** Optional stronger authority for server/tests; the frontend need not download a Graph. */
  readonly verifiedGraph?: unknown
}

const sameHashes = (left: readonly string[], right: readonly string[]): boolean => {
  const orderedLeft = [...left].sort()
  const orderedRight = [...right].sort()
  return orderedLeft.length === orderedRight.length && orderedLeft.every((hash, index) => hash === orderedRight[index])
}
const citationIdentity = (citation: SourceCitationV1): string => {
  const identity = { ...citation }
  delete identity.quote
  return canonicalizeJson(identity)
}
const supportsCitation = (citation: SourceCitationV1, allowed: readonly SourceCitationV1[]): boolean =>
  allowed.some((verified) => citationIdentity(verified) === citationIdentity(citation)
    && (citation.quote === undefined || citation.quote === verified.quote))
const citationsByIdentity = (citations: readonly SourceCitationV1[]): ReadonlyMap<string, readonly SourceCitationV1[]> => {
  const result = new Map<string, SourceCitationV1[]>()
  for (const citation of citations) {
    const key = citationIdentity(citation)
    const matching = result.get(key) ?? []
    matching.push(citation)
    result.set(key, matching)
  }
  return result
}

/** Only plain bounded JSON is accepted; checking never invokes getters or mutates inputs. */
const inspectJson = (value: unknown, maxBytes: number, maxNodes: number): void => {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }]
  const ancestors = new WeakSet<object>()
  let count = 0
  while (pending.length) {
    const current = pending.pop()
    if (!current) break
    if (current.exit) { ancestors.delete(current.value as object); continue }
    if (++count > maxNodes || current.depth > 32) throw new KnowledgePracticeLinkError('capacity_exceeded')
    if (current.value === null) continue
    if (typeof current.value !== 'object') {
      if (typeof current.value !== 'string' && typeof current.value !== 'boolean'
        && (typeof current.value !== 'number' || !Number.isFinite(current.value))) throw new KnowledgePracticeLinkError('invalid_artifact')
      continue
    }
    if (ancestors.has(current.value)) throw new KnowledgePracticeLinkError('invalid_artifact')
    ancestors.add(current.value)
    pending.push({ ...current, exit: true })
    if (!Array.isArray(current.value) && Object.getPrototypeOf(current.value) !== Object.prototype
      && Object.getPrototypeOf(current.value) !== null) throw new KnowledgePracticeLinkError('invalid_artifact')
    for (const key of Reflect.ownKeys(current.value)) {
      if (Array.isArray(current.value) && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
        || Array.isArray(current.value) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new KnowledgePracticeLinkError('invalid_artifact')
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new KnowledgePracticeLinkError('invalid_artifact')
      pending.push({ value: descriptor.value, depth: current.depth + 1 })
    }
  }
  if (new TextEncoder().encode(canonicalizeJson(value)).byteLength > maxBytes) throw new KnowledgePracticeLinkError('capacity_exceeded')
}

const graphCitations = (graph: EvidenceGraphV1): ReadonlyMap<string, readonly SourceCitationV1[]> => {
  const supported = new Map<string, readonly SourceCitationV1[]>()
  for (const entry of [...graph.claims, ...graph.terms]) supported.set(entry.id, entry.citations)
  for (const objective of graph.learningObjectives) {
    supported.set(objective.id, objective.evidenceIds.flatMap((id) => supported.get(id) ?? []))
  }
  return supported
}

/**
 * Derive related node/question pairs, never causal relations or mastery scores.
 * Schema parsing is not full grounding validation. Frontend callers must first
 * prepare and recheck both exact Artifact identities against the same current
 * task and source snapshots. An optional verified Graph checks evidence IDs and
 * citation support again; evidence IDs appearing in the two artifacts alone
 * never become a new authority.
 */
export function deriveKnowledgePracticeLinks(input: KnowledgePracticeLinkInput): KnowledgePracticeLinksV1 {
  inspectJson(input.mindmap, ANALYSIS_LIMITS.maxArtifactBytes, 100_000)
  inspectJson(input.quiz, ANALYSIS_LIMITS.maxArtifactBytes, 100_000)
  const mapResult = mindMapArtifactEnvelopeSchema.safeParse(input.mindmap)
  const quizResult = quizArtifactEnvelopeSchema.safeParse(input.quiz)
  if (!mapResult.success || !quizResult.success) throw new KnowledgePracticeLinkError('invalid_artifact')
  const mindmap = mapResult.data
  const quiz = quizResult.data
  if (mindmap.docId !== quiz.docId || mindmap.runId !== quiz.runId || mindmap.id === quiz.id
    || !sameHashes(mindmap.sourceContentHashes, quiz.sourceContentHashes)) throw new KnowledgePracticeLinkError('identity_mismatch')
  if (validateMindMapGraph(mindmap.payload).length || mindmap.payload.relations.some((relation) => relation.from === relation.to)) {
    throw new KnowledgePracticeLinkError('invalid_artifact')
  }

  let authority: ReadonlyMap<string, readonly SourceCitationV1[]> | undefined
  if (input.verifiedGraph !== undefined) {
    inspectJson(input.verifiedGraph, 16 * ANALYSIS_LIMITS.maxArtifactBytes, 1_000_000)
    const parsedGraph = evidenceGraphSchema.safeParse(input.verifiedGraph)
    if (!parsedGraph.success) throw new KnowledgePracticeLinkError('invalid_graph')
    if (parsedGraph.data.runId !== mindmap.runId || !sameHashes(parsedGraph.data.sourceContentHashes, mindmap.sourceContentHashes)) {
      throw new KnowledgePracticeLinkError('identity_mismatch')
    }
    authority = graphCitations(parsedGraph.data)
  }
  const entries = [...mindmap.payload.nodes, ...mindmap.payload.relations, ...quiz.payload.questions]
  for (const entry of entries) {
    if (new Set(entry.evidenceIds).size !== entry.evidenceIds.length) throw new KnowledgePracticeLinkError('duplicate_evidence')
    if (entry.citations.some((citation) => citation.provenance !== 'source')) throw new KnowledgePracticeLinkError('unsupported_citation')
    if (!authority) continue
    const allowed: SourceCitationV1[] = []
    for (const id of entry.evidenceIds) {
      const supported = authority.get(id)
      if (!supported) throw new KnowledgePracticeLinkError('unknown_evidence')
      allowed.push(...supported)
    }
    for (const citation of entry.citations) {
      if (citation.provenance === 'source' && !supportsCitation(citation, allowed)) throw new KnowledgePracticeLinkError('unsupported_citation')
    }
  }

  const questionsByEvidence = new Map<string, Set<number>>()
  quiz.payload.questions.forEach((question, index) => {
    for (const id of question.evidenceIds) {
      const questions = questionsByEvidence.get(id) ?? new Set<number>()
      questions.add(index)
      questionsByEvidence.set(id, questions)
    }
  })
  const questionSources = quiz.payload.questions.map((question) => citationsByIdentity(
    question.citations.filter((citation): citation is SourceCitationV1 => citation.provenance === 'source')))
  const links: KnowledgePracticeLink[] = []
  let linkBytes = 2
  for (const node of mindmap.payload.nodes) {
    const nodeSources = citationsByIdentity(node.citations.filter((citation): citation is SourceCitationV1 => citation.provenance === 'source'))
    const candidates = new Set(node.evidenceIds.flatMap((id) => [...questionsByEvidence.get(id) ?? []]))
    for (const index of [...candidates].sort((left, right) => left - right)) {
      const question = quiz.payload.questions[index]
      const questionEvidence = new Set(question.evidenceIds)
      const sharedEvidenceIds = node.evidenceIds.filter((id) => questionEvidence.has(id))
      const sharedSupport = authority && sharedEvidenceIds.flatMap((id) => authority.get(id) ?? [])
      const sharedCitations = new Map<string, SourceCitationV1>()
      for (const [identity, citations] of nodeSources) {
        const corresponding = questionSources[index].get(identity)
        if (!corresponding) continue
        const candidates = [...citations, ...corresponding]
        const quotes = new Set(candidates.map((citation) => citation.quote).filter((quote) => quote !== undefined))
        if (quotes.size > 1) continue
        const precise = candidates.find((citation) => citation.quote !== undefined) ?? citations[0]
        if (sharedSupport && !supportsCitation(precise, sharedSupport)) continue
        sharedCitations.set(identity, { ...precise })
      }
      if (sharedCitations.size === 0) continue
      if (links.length >= MAX_KNOWLEDGE_PRACTICE_LINKS) throw new KnowledgePracticeLinkError('capacity_exceeded')
      const link = Object.freeze({ nodeId: node.id, questionId: question.id,
        sharedEvidenceIds: Object.freeze(sharedEvidenceIds),
        sourceCitations: Object.freeze([...sharedCitations.values()].map((citation) => Object.freeze(citation))) })
      linkBytes += new TextEncoder().encode(canonicalizeJson(link)).byteLength + 1
      // Keep the complete result bounded too; dense matches are not silently
      // truncated into an incomplete learning view.
      if (linkBytes > ANALYSIS_LIMITS.maxArtifactBytes - 4_096) throw new KnowledgePracticeLinkError('capacity_exceeded')
      links.push(link)
    }
  }
  return Object.freeze({ version: KNOWLEDGE_PRACTICE_LINK_VERSION, docId: mindmap.docId, runId: mindmap.runId,
    mindmapArtifactId: mindmap.id, quizArtifactId: quiz.id, sourceContentHashes: Object.freeze([...mindmap.sourceContentHashes].sort()),
    links: Object.freeze(links) })
}
