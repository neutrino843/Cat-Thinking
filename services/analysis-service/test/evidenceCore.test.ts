import { createHash } from 'node:crypto'
import {
  evidenceCardSchema,
  sourceSnapshotSchema,
  type EvidenceCardV1,
  type EvidenceChunkV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import {
  EvidenceBudgetExceededError,
  defaultEvidenceBudgetPolicy,
  planEvidenceBudget,
} from '../src/domain/budgetPlanner.js'
import {
  hashChunkPlan,
  planEvidenceChunks,
  type ChunkPlannerPolicy,
} from '../src/domain/chunkPlanner.js'
import { calculateEvidenceCoverage, mergeEvidenceCards } from '../src/domain/evidenceMerger.js'
import {
  EvidenceValidationError,
  inspectEvidenceCard,
  validateEvidenceCard,
} from '../src/domain/evidenceValidator.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const policy: ChunkPlannerPolicy = {
  version: 'test-chunk-v1',
  targetCharacters: 100,
  maxCharacters: 140,
  overlapCharacters: 12,
  minimumBoundaryRatio: 0.5,
}

const source = (text: string) => sourceSnapshotSchema.parse({
  version: 1,
  sourceId: 'source-1',
  kind: 'pdf',
  extractor: 'fixture-v1',
  contentHash: hash(text),
  charCount: text.length,
  byteCount: new TextEncoder().encode(text).byteLength,
  pageCount: 2,
  locators: [
    { start: 0, end: Math.floor(text.length / 2), titlePath: ['第一章'], page: 1 },
    { start: Math.floor(text.length / 2), end: text.length, titlePath: ['第二章'], page: 2 },
  ],
})

const cardFor = (chunk: EvidenceChunkV1, text: string, statement = '光合作用把光能转化为化学能'): EvidenceCardV1 => {
  const citationEnd = Math.min(chunk.end, chunk.start + 8)
  const citation = {
    version: 1 as const,
    provenance: 'source' as const,
    sourceId: chunk.sourceId,
    start: chunk.start,
    end: citationEnd,
    quote: text.slice(chunk.start, citationEnd),
    ...(chunk.pageStart === undefined ? {} : { page: chunk.pageStart }),
  }
  return evidenceCardSchema.parse({
    version: 1,
    chunkId: chunk.chunkId,
    chunkHash: chunk.chunkHash,
    sourceId: chunk.sourceId,
    titlePath: chunk.titlePath,
    claims: [{ id: 'claim-local', kind: 'fact', statement, conceptIds: ['term-local'], citations: [citation] }],
    terms: [{ id: 'term-local', term: '光合作用', definition: '能量转换过程', citations: [citation] }],
    learningObjectives: [{ id: 'objective-local', text: '理解光合作用', evidenceIds: ['claim-local'] }],
  })
}

describe('evidence chunk planning', () => {
  it('is deterministic, preserves selected coverage and never splits a surrogate pair', () => {
    const text = `${'第一段包含中文内容。'.repeat(8)}\n\n${'第二段包含 emoji 🌱 和英文 content. '.repeat(8)}`
    const snapshot = source(text)
    const first = planEvidenceChunks([{ snapshot, text }], policy)
    const second = planEvidenceChunks([{ snapshot, text }], policy)

    expect(second).toEqual(first)
    expect(first.length).toBeGreaterThan(1)
    expect(first[0]?.start).toBe(0)
    expect(first.at(-1)?.end).toBe(text.length)
    expect(new Set(first.map((chunk) => chunk.chunkId)).size).toBe(first.length)
    expect(first.every((chunk) => chunk.end - chunk.start <= policy.maxCharacters)).toBe(true)
    for (const chunk of first) {
      const left = text.charCodeAt(chunk.end - 1)
      const right = text.charCodeAt(chunk.end)
      expect(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff).toBe(false)
    }
    expect(hashChunkPlan(first)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('honors selected ranges and rejects invalid or non-advancing policies', () => {
    const text = '甲'.repeat(300)
    const snapshot = sourceSnapshotSchema.parse({ ...source(text), selectedRange: { start: 50, end: 250 } })
    const chunks = planEvidenceChunks([{ snapshot, text }], policy)
    expect(chunks[0]?.start).toBe(50)
    expect(chunks.at(-1)?.end).toBe(250)
    expect(() => planEvidenceChunks([{ snapshot, text }], { ...policy, overlapCharacters: 100 }))
      .toThrow(/overlapCharacters/)
    expect(() => planEvidenceChunks([{ snapshot, text: `${text}x` }], policy)).toThrow(/length/)
  })
})

describe('evidence budget planning', () => {
  it('chooses fast and hierarchical paths and increases the high-quality upper bound', () => {
    const text = '知识点。'.repeat(80)
    const chunks = planEvidenceChunks([{ snapshot: source(text), text }], policy)
    const standard = planEvidenceBudget(chunks, 'standard')
    const highQuality = planEvidenceBudget(chunks, 'high-quality')
    expect(standard.path).toBe('hierarchical')
    expect(standard.mapCalls).toBe(chunks.length)
    expect(highQuality.estimatedTotalTokens).toBeGreaterThan(standard.estimatedTotalTokens)
    expect(highQuality.estimatedCostMicros).toBeGreaterThan(standard.estimatedCostMicros)

    const one = [{ ...chunks[0]!, total: 1, ordinal: 0 }]
    expect(planEvidenceBudget(one, 'economy').path).toBe('fast')
  })

  it('fails explicitly instead of silently dropping chunks', () => {
    const text = '预算。'.repeat(100)
    const chunks = planEvidenceChunks([{ snapshot: source(text), text }], policy)
    const constrained = {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, maxChunks: 1 },
    }
    expect(() => planEvidenceBudget(chunks, 'standard', constrained)).toThrow(EvidenceBudgetExceededError)
  })

  it('enforces every budget dimension and validates merge fan-in', () => {
    const text = 'budget input '.repeat(30)
    const chunks = planEvidenceChunks([{ snapshot: source(text), text }], policy)
    expect(() => planEvidenceBudget(chunks, 'standard', {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, mergeFanIn: 0 },
    })).toThrow(/mergeFanIn/)
    expect(() => planEvidenceBudget(chunks, 'standard', {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, maxInputTokens: 1 },
    })).toThrow(expect.objectContaining({ dimension: 'input_tokens' }))
    expect(() => planEvidenceBudget(chunks, 'standard', {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, maxEstimatedTokens: 1 },
    })).toThrow(expect.objectContaining({ dimension: 'total_tokens' }))
    expect(() => planEvidenceBudget(chunks, 'standard', {
      ...defaultEvidenceBudgetPolicy,
      limits: { ...defaultEvidenceBudgetPolicy.limits, maxEstimatedCostMicros: 0 },
    })).toThrow(expect.objectContaining({ dimension: 'cost' }))
  })
})

describe('evidence chunk policy boundaries', () => {
  it('rejects invalid version, size, overlap and ratio settings', () => {
    const text = 'x'.repeat(200)
    const input = [{ snapshot: source(text), text }]
    const invalidPolicies: ChunkPlannerPolicy[] = [
      { ...policy, version: 'bad version' },
      { ...policy, targetCharacters: 99 },
      { ...policy, targetCharacters: 100.5 },
      { ...policy, maxCharacters: 99 },
      { ...policy, maxCharacters: 140.5 },
      { ...policy, overlapCharacters: -1 },
      { ...policy, overlapCharacters: policy.targetCharacters },
      { ...policy, minimumBoundaryRatio: 0 },
      { ...policy, minimumBoundaryRatio: 1.1 },
    ]
    for (const invalid of invalidPolicies) expect(() => planEvidenceChunks(input, invalid)).toThrow()
  })

  it('rejects an empty selected source range', () => {
    const text = 'xx'
    const snapshot = { ...source(text), selectedRange: { start: 1, end: 1 } }
    expect(() => planEvidenceChunks([{ snapshot, text }], policy)).toThrow(/empty/)
  })
})

describe('evidence validation and deterministic merge', () => {
  it('rejects invalid identity, ranges, pages, quotes and dangling references', () => {
    const text = '光合作用把光能转化为化学能。'.repeat(20)
    const snapshot = source(text)
    const chunk = planEvidenceChunks([{ snapshot, text }], policy)[0]!
    const valid = cardFor(chunk, text)
    expect(inspectEvidenceCard({ card: valid, chunk, snapshot, sourceText: text })).toEqual([])

    const invalid = evidenceCardSchema.parse({
      ...valid,
      claims: [{
        ...valid.claims[0]!,
        conceptIds: ['missing-term'],
        citations: [{
          ...valid.claims[0]!.citations[0]!,
          quote: '错误引用',
          page: 2,
        }],
      }],
      learningObjectives: [{ ...valid.learningObjectives[0]!, evidenceIds: ['missing-claim'] }],
    })
    const issues = inspectEvidenceCard({ card: invalid, chunk, snapshot, sourceText: text })
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'citation_quote_invalid',
      'citation_page_invalid',
      'reference_missing',
    ]))
    expect(() => validateEvidenceCard({ card: invalid, chunk, snapshot, sourceText: text }))
      .toThrow(EvidenceValidationError)
  })

  it('deduplicates equivalent evidence, rewrites local ids and produces a stable graph hash', () => {
    const text = '光合作用把光能转化为化学能。'.repeat(30)
    const snapshot = source(text)
    const chunks = planEvidenceChunks([{ snapshot, text }], policy)
    const cards = chunks.slice(0, 2).map((chunk) => cardFor(chunk, text))
    cards.forEach((card, index) => validateEvidenceCard({ card, chunk: chunks[index]!, snapshot, sourceText: text }))
    const coverage = calculateEvidenceCoverage({
      selectedRanges: { 'source-1': { start: 0, end: text.length } },
      chunks,
      cards,
    })
    const input = {
      runId: 'run-1',
      chunks,
      cards,
      sourceContentHashes: [snapshot.contentHash],
      coverage,
      missingChunkIds: chunks.slice(2).map((chunk) => chunk.chunkId),
      chunkPlanHash: hashChunkPlan(chunks),
      policyVersion: policy.version,
      promptVersion: 'evidence-map-v1',
      generatorProfile: 'fixture-v1',
      createdAt: 1_791_500_000_000,
    } as const
    const first = mergeEvidenceCards(input)
    const second = mergeEvidenceCards(input)
    expect(second).toEqual(first)
    expect(first.claims).toHaveLength(1)
    expect(first.terms).toHaveLength(1)
    expect(first.learningObjectives[0]?.evidenceIds[0]).toBe(first.claims[0]?.id)
    expect(first.graphHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.coverage.input).toBe(1)
    expect(first.coverage.analysis).toBeLessThan(1)
  })

  it('handles empty coverage, orphan sources and invalid ranges deterministically', () => {
    expect(calculateEvidenceCoverage({
      selectedRanges: { orphan: { start: 0, end: 0 } },
      chunks: [],
      cards: [],
    })).toEqual({
      input: 0,
      analysis: 0,
      citation: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksTotal: 0,
    })
    expect(calculateEvidenceCoverage({
      selectedRanges: { orphan: { start: 0, end: 10 } },
      chunks: [{
        version: 1,
        chunkId: 'invalid-runtime-range',
        chunkHash: hash('invalid-runtime-range'),
        sourceId: 'orphan',
        start: 5,
        end: 5,
        titlePath: [],
        estimatedTokens: 1,
        ordinal: 0,
        total: 1,
        overlapBefore: 0,
        overlapAfter: 0,
      }],
      cards: [],
    })).toMatchObject({ input: 0, analysis: 0, citation: 0, chunksFailed: 1 })
  })

  it('rewrites term and missing local references before graph validation', () => {
    const text = 'reference mapping text. '.repeat(20)
    const snapshot = source(text)
    const chunks = planEvidenceChunks([{ snapshot, text }], policy)
    const base = cardFor(chunks[0]!, text)
    const termObjective = {
      ...base,
      claims: [{ ...base.claims[0]!, conceptIds: ['missing-local-term'] }],
      learningObjectives: [{ ...base.learningObjectives[0]!, evidenceIds: ['term-local'] }],
    }
    const mergeInput = {
      runId: 'run-reference',
      chunks,
      cards: [termObjective],
      sourceContentHashes: [snapshot.contentHash],
      coverage: calculateEvidenceCoverage({
        selectedRanges: { 'source-1': { start: 0, end: text.length } },
        chunks,
        cards: [termObjective],
      }),
      missingChunkIds: chunks.slice(1).map(({ chunkId }) => chunkId),
      chunkPlanHash: hashChunkPlan(chunks),
      policyVersion: policy.version,
      promptVersion: 'evidence-map-v1',
      generatorProfile: 'fixture-v1',
      createdAt: 1_791_500_000_000,
    } as const
    const merged = mergeEvidenceCards(mergeInput)
    expect(merged.claims[0]?.conceptIds[0]).toMatch(/^term:/)
    expect(merged.learningObjectives[0]?.evidenceIds).toEqual([merged.terms[0]?.id])

    expect(() => mergeEvidenceCards({
      ...mergeInput,
      cards: [{
        ...termObjective,
        learningObjectives: [{ ...base.learningObjectives[0]!, evidenceIds: ['missing-evidence'] }],
      }],
    })).toThrow(/unknown evidence/)
  })

  it('orders otherwise identical citations by their end offset', () => {
    const text = 'citation ordering text. '.repeat(20)
    const snapshot = source(text)
    const chunks = planEvidenceChunks([{ snapshot, text }], policy)
    const cards = chunks.slice(0, 2).map((chunk, index) => {
      const base = cardFor(chunk, text)
      const localCitation = { ...base.claims[0]!.citations[0]!, start: 0, end: index + 1 }
      return {
        ...base,
        claims: [{ ...base.claims[0]!, citations: [localCitation] }],
        terms: [{ ...base.terms[0]!, citations: [localCitation] }],
      }
    })
    const merged = mergeEvidenceCards({
      runId: 'run-citation-order',
      chunks,
      cards,
      sourceContentHashes: [snapshot.contentHash],
      coverage: { input: 1, analysis: 1, citation: 1, chunksCompleted: 2, chunksFailed: 0, chunksTotal: chunks.length },
      missingChunkIds: chunks.slice(2).map(({ chunkId }) => chunkId),
      chunkPlanHash: hashChunkPlan(chunks),
      policyVersion: policy.version,
      promptVersion: 'evidence-map-v1',
      generatorProfile: 'fixture-v1',
      createdAt: 1_791_500_000_000,
    })
    expect(merged.claims[0]?.citations.map(({ end }) => end)).toEqual([1, 2])
  })
})
