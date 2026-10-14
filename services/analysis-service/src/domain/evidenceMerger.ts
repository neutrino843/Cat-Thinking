import { createHash } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_LIMITS,
  canonicalizeJson,
  evidenceGraphSchema,
  type CoverageV1,
  type EvidenceCardV1,
  type EvidenceChunkV1,
  type EvidenceClaimV1,
  type EvidenceGraphV1,
  type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const canonicalText = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
const stableId = (prefix: string, value: string): string => `${prefix}:${sha256(value).slice(0, 32)}`
export const EVIDENCE_MERGE_POLICY_VERSION = 'evidence-merge-v2'

export class EvidenceGraphCapacityExceededError extends Error {
  constructor(readonly dimension: 'claims' | 'terms' | 'learningObjectives' | 'cards' | 'chunks',
    readonly actual: number, readonly maximum: number) {
    super(`evidence graph capacity exceeded: ${dimension}`)
    this.name = 'EvidenceGraphCapacityExceededError'
  }
}

const enforceCapacity = (dimension: EvidenceGraphCapacityExceededError['dimension'], actual: number, maximum: number): void => {
  if (actual > maximum) throw new EvidenceGraphCapacityExceededError(dimension, actual, maximum)
}
const union = (left: readonly string[], right: readonly string[]): string[] => [...new Set([...left, ...right])].sort()
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const mergeCitations = (
  left: readonly SourceCitationV1[],
  right: readonly SourceCitationV1[],
): SourceCitationV1[] => {
  const citations = new Map<string, SourceCitationV1>()
  for (const citation of [...left, ...right]) citations.set(canonicalizeJson(citation), citation)
  return [...citations.values()].sort((a, b) =>
    compareText(a.sourceId, b.sourceId) || a.start - b.start || a.end - b.end
      || compareText(canonicalizeJson(a), canonicalizeJson(b)),
  ).slice(0, ANALYSIS_LIMITS.maxEvidenceCitationsPerItem)
}
export interface MergeEvidenceInput {
  readonly runId: string
  readonly chunks: readonly EvidenceChunkV1[]
  readonly cards: readonly EvidenceCardV1[]
  readonly sourceContentHashes: readonly string[]
  readonly coverage: CoverageV1
  readonly missingChunkIds: readonly string[]
  readonly chunkPlanHash: string
  readonly policyVersion: string
  readonly promptVersion: string
  readonly generatorProfile: string
  readonly createdAt: number
}

export const mergeEvidenceCards = (input: MergeEvidenceInput): EvidenceGraphV1 => {
  enforceCapacity('cards', input.cards.length, ANALYSIS_LIMITS.maxEvidenceCards)
  enforceCapacity('chunks', input.chunks.length, ANALYSIS_LIMITS.maxEvidenceChunks)
  // Keep full cards, but canonicalize collection order so input delivery order is
  // irrelevant to grouping, representative citations and the graph/cache hash.
  const cards = input.cards.map((card) => ({ ...card,
    claims: [...card.claims].sort((a, b) => compareText(a.id, b.id)),
    terms: [...card.terms].sort((a, b) => compareText(a.id, b.id)),
    learningObjectives: [...card.learningObjectives].sort((a, b) => compareText(a.id, b.id)),
  })).sort((a, b) => compareText(a.chunkId, b.chunkId))
  const termByLocalId = new Map<string, string>()
  const terms = new Map<string, EvidenceGraphV1['terms'][number]>()
  for (const card of cards) {
    for (const term of card.terms) {
      const key = `${canonicalText(term.term)}\u0000${canonicalText(term.definition ?? '')}`
      const id = stableId('term', key)
      termByLocalId.set(`${card.chunkId}:${term.id}`, id)
      const current = terms.get(key)
      terms.set(key, current
        ? { ...current, citations: mergeCitations(current.citations, term.citations) }
        : { ...term, id, citations: mergeCitations([], term.citations) })
      enforceCapacity('terms', terms.size, ANALYSIS_LIMITS.maxEvidenceTerms)
    }
  }

  const claimCandidates = cards.flatMap((card) => card.claims.map((claim) => ({
    local: `${card.chunkId}:${claim.id}`,
    key: `${claim.kind}\u0000${canonicalText(claim.statement)}`,
    value: { ...claim, conceptIds: union([], claim.conceptIds.map((id) => {
      const mapped = termByLocalId.get(`${card.chunkId}:${id}`)
      if (!mapped) throw new Error('claim references unknown concept')
      return mapped
    })) },
  }))).sort((a, b) => compareText(a.key, b.key)
    || compareText(canonicalizeJson(a.value.conceptIds), canonicalizeJson(b.value.conceptIds))
    || compareText(canonicalizeJson(a.value), canonicalizeJson(b.value)) || compareText(a.local, b.local))
  const claimsById = new Map<string, EvidenceClaimV1>()
  const claimGroupByLocal = new Map<string, EvidenceClaimV1>()
  let previousClaimKey: string | undefined
  let previousClaim: EvidenceClaimV1 | undefined
  const finishClaim = (claim: EvidenceClaimV1 | undefined): void => {
    if (!claim) return
    claim.id = stableId('claim', canonicalizeJson({ policy: EVIDENCE_MERGE_POLICY_VERSION,
      kind: claim.kind, statement: canonicalText(claim.statement), conceptIds: claim.conceptIds }))
    const existing = claimsById.get(claim.id)
    if (existing) existing.citations = mergeCitations(existing.citations, claim.citations)
    else claimsById.set(claim.id, claim)
    enforceCapacity('claims', claimsById.size, ANALYSIS_LIMITS.maxEvidenceClaims)
  }
  for (const candidate of claimCandidates) {
    const previous = previousClaim
    const combined = previous && previousClaimKey === candidate.key
      ? union(previous.conceptIds, candidate.value.conceptIds) : undefined
    let group: EvidenceClaimV1
    if (previous && combined && combined.length <= 50) {
      previous.conceptIds = combined
      previous.citations = mergeCitations(previous.citations, candidate.value.citations)
      group = previous
    } else {
      finishClaim(previous)
      group = { ...candidate.value, citations: mergeCitations([], candidate.value.citations) }
    }
    previousClaim = group
    previousClaimKey = candidate.key
    claimGroupByLocal.set(candidate.local, group)
  }
  finishClaim(previousClaim)

  const objectiveCandidates = cards.flatMap((card) => card.learningObjectives.map((objective) => ({
    local: `${card.chunkId}:${objective.id}`, key: canonicalText(objective.text),
    value: { ...objective, evidenceIds: union([], objective.evidenceIds.map((id) => {
      const mapped = claimGroupByLocal.get(`${card.chunkId}:${id}`)?.id ?? termByLocalId.get(`${card.chunkId}:${id}`)
      if (!mapped) throw new Error('learning objective references unknown evidence')
      return mapped
    })) },
  }))).sort((a, b) => compareText(a.key, b.key)
    || compareText(canonicalizeJson(a.value.evidenceIds), canonicalizeJson(b.value.evidenceIds))
    || compareText(canonicalizeJson(a.value), canonicalizeJson(b.value)) || compareText(a.local, b.local))
  const objectivesById = new Map<string, EvidenceGraphV1['learningObjectives'][number]>()
  let previousObjectiveKey: string | undefined
  let previousObjective: EvidenceGraphV1['learningObjectives'][number] | undefined
  const finishObjective = (objective: EvidenceGraphV1['learningObjectives'][number] | undefined): void => {
    if (!objective) return
    objective.id = stableId('objective', canonicalizeJson({ policy: EVIDENCE_MERGE_POLICY_VERSION,
      text: canonicalText(objective.text), evidenceIds: objective.evidenceIds }))
    if (!objectivesById.has(objective.id)) objectivesById.set(objective.id, objective)
    enforceCapacity('learningObjectives', objectivesById.size, ANALYSIS_LIMITS.maxLearningObjectives)
  }
  for (const candidate of objectiveCandidates) {
    const previous = previousObjective
    const combined = previous && previousObjectiveKey === candidate.key
      ? union(previous.evidenceIds, candidate.value.evidenceIds) : undefined
    if (previous && combined && combined.length <= 100) previous.evidenceIds = combined
    else {
      finishObjective(previous)
      previousObjective = { ...candidate.value }
    }
    previousObjectiveKey = candidate.key
  }
  finishObjective(previousObjective)

  const withoutHash = {
    version: ANALYSIS_CONTRACT_VERSION,
    runId: input.runId,
    chunkPlanHash: input.chunkPlanHash,
    sourceContentHashes: [...input.sourceContentHashes],
    policyVersion: `${EVIDENCE_MERGE_POLICY_VERSION}:${sha256(input.policyVersion).slice(0, 32)}`,
    promptVersion: input.promptVersion,
    generatorProfile: input.generatorProfile,
    chunks: [...input.chunks].sort((a, b) => a.ordinal - b.ordinal || compareText(a.chunkId, b.chunkId)),
    cards,
    claims: [...claimsById.values()].sort((a, b) => compareText(a.id, b.id)),
    terms: [...terms.values()].sort((a, b) => compareText(a.id, b.id)),
    learningObjectives: [...objectivesById.values()].sort((a, b) => compareText(a.id, b.id)),
    coverage: input.coverage,
    missingChunkIds: [...input.missingChunkIds].sort(),
    createdAt: input.createdAt,
  }
  return evidenceGraphSchema.parse({ ...withoutHash, graphHash: sha256(canonicalizeJson(withoutHash)) })
}

interface Range {
  readonly start: number
  readonly end: number
}

const unionLength = (ranges: readonly Range[]): number => {
  const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  let total = 0
  let start = -1
  let end = -1
  for (const range of ordered) {
    if (range.end <= range.start) continue
    if (range.start > end) {
      if (end > start) total += end - start
      start = range.start
      end = range.end
    } else {
      end = Math.max(end, range.end)
    }
  }
  if (end > start) total += end - start
  return total
}

export const calculateEvidenceCoverage = (input: {
  readonly selectedRanges: Readonly<Record<string, Range>>
  readonly chunks: readonly EvidenceChunkV1[]
  readonly cards: readonly EvidenceCardV1[]
}): CoverageV1 => {
  const denominator = Object.values(input.selectedRanges).reduce((total, range) => total + range.end - range.start, 0)
  const bySource = <T>(values: readonly T[], source: (value: T) => string): Map<string, T[]> => {
    const result = new Map<string, T[]>()
    for (const value of values) result.set(source(value), [...(result.get(source(value)) ?? []), value])
    return result
  }
  const chunks = bySource(input.chunks, (chunk) => chunk.sourceId)
  const cards = bySource(input.cards, (card) => card.sourceId)
  let planned = 0
  let analysed = 0
  let cited = 0
  for (const [sourceId, selected] of Object.entries(input.selectedRanges)) {
    const plannedChunks = chunks.get(sourceId) ?? []
    const completedIds = new Set((cards.get(sourceId) ?? []).map((card) => card.chunkId))
    planned += unionLength(plannedChunks.map((chunk) => ({
      start: Math.max(selected.start, chunk.start),
      end: Math.min(selected.end, chunk.end),
    })))
    analysed += unionLength(plannedChunks.filter((chunk) => completedIds.has(chunk.chunkId)).map((chunk) => ({
      start: Math.max(selected.start, chunk.start),
      end: Math.min(selected.end, chunk.end),
    })))
    cited += unionLength((cards.get(sourceId) ?? []).flatMap((card) => [
      ...card.claims.flatMap((claim) => claim.citations),
      ...card.terms.flatMap((term) => term.citations),
    ]).map((citation) => ({
      start: Math.max(selected.start, citation.start),
      end: Math.min(selected.end, citation.end),
    })))
  }
  const completed = input.cards.length
  return {
    input: denominator === 0 ? 0 : Math.min(1, planned / denominator),
    analysis: denominator === 0 ? 0 : Math.min(1, analysed / denominator),
    citation: analysed === 0 ? 0 : Math.min(1, cited / analysed),
    chunksCompleted: completed,
    chunksFailed: input.chunks.length - completed,
    chunksTotal: input.chunks.length,
  }
}
