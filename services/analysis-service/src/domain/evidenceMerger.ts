import { createHash } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
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

const mergeCitations = (
  left: readonly SourceCitationV1[],
  right: readonly SourceCitationV1[],
): SourceCitationV1[] => {
  const citations = new Map<string, SourceCitationV1>()
  for (const citation of [...left, ...right]) citations.set(canonicalizeJson(citation), citation)
  return [...citations.values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.end - b.end,
  )
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
  const termByLocalId = new Map<string, string>()
  const terms = new Map<string, EvidenceGraphV1['terms'][number]>()
  for (const card of input.cards) {
    for (const term of card.terms) {
      const key = `${canonicalText(term.term)}\u0000${canonicalText(term.definition ?? '')}`
      const id = stableId('term', key)
      termByLocalId.set(`${card.chunkId}:${term.id}`, id)
      const current = terms.get(key)
      terms.set(key, current
        ? { ...current, citations: mergeCitations(current.citations, term.citations) }
        : { ...term, id })
    }
  }

  const claimByLocalId = new Map<string, string>()
  const claims = new Map<string, EvidenceClaimV1>()
  for (const card of input.cards) {
    for (const claim of card.claims) {
      const key = `${claim.kind}\u0000${canonicalText(claim.statement)}`
      const id = stableId('claim', key)
      claimByLocalId.set(`${card.chunkId}:${claim.id}`, id)
      const conceptIds = claim.conceptIds.map((conceptId) =>
        termByLocalId.get(`${card.chunkId}:${conceptId}`) ?? stableId('term', `missing:${card.chunkId}:${conceptId}`),
      )
      const current = claims.get(key)
      claims.set(key, current
        ? {
            ...current,
            conceptIds: [...new Set([...current.conceptIds, ...conceptIds])].sort(),
            citations: mergeCitations(current.citations, claim.citations),
          }
        : { ...claim, id, conceptIds: [...new Set(conceptIds)].sort() })
    }
  }

  const objectives = new Map<string, EvidenceGraphV1['learningObjectives'][number]>()
  for (const card of input.cards) {
    for (const objective of card.learningObjectives) {
      const key = canonicalText(objective.text)
      const evidenceIds = objective.evidenceIds.map((localId) =>
        claimByLocalId.get(`${card.chunkId}:${localId}`)
        ?? termByLocalId.get(`${card.chunkId}:${localId}`)
        ?? stableId('evidence', `missing:${card.chunkId}:${localId}`),
      )
      const current = objectives.get(key)
      objectives.set(key, current
        ? { ...current, evidenceIds: [...new Set([...current.evidenceIds, ...evidenceIds])].sort() }
        : { ...objective, id: stableId('objective', key), evidenceIds: [...new Set(evidenceIds)].sort() })
    }
  }

  const withoutHash = {
    version: ANALYSIS_CONTRACT_VERSION,
    runId: input.runId,
    chunkPlanHash: input.chunkPlanHash,
    sourceContentHashes: [...input.sourceContentHashes],
    policyVersion: input.policyVersion,
    promptVersion: input.promptVersion,
    generatorProfile: input.generatorProfile,
    chunks: [...input.chunks],
    cards: [...input.cards],
    claims: [...claims.values()],
    terms: [...terms.values()],
    learningObjectives: [...objectives.values()],
    coverage: input.coverage,
    missingChunkIds: [...input.missingChunkIds],
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
