import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_LIMITS,
  analysisEventSchema,
  canonicalizeJson,
  evidenceCardSchema,
  evidenceChunkSchema,
  evidenceGraphSchema,
  sourceSnapshotSchema,
  uploadSourcePartSchema,
} from '../src'

const hash = (character: string): string => character.repeat(64)
const citation = {
  version: 1 as const,
  provenance: 'source' as const,
  sourceId: 'source-1',
  start: 0,
  end: 4,
  quote: 'text',
  page: 1,
}
const chunk = {
  version: 1 as const,
  chunkId: 'chunk-1',
  chunkHash: hash('a'),
  sourceId: 'source-1',
  start: 0,
  end: 10,
  titlePath: ['chapter'],
  pageStart: 1,
  pageEnd: 1,
  estimatedTokens: 4,
  ordinal: 0,
  total: 1,
  overlapBefore: 0,
  overlapAfter: 0,
}
const claim = {
  id: 'claim-1',
  kind: 'fact' as const,
  statement: 'A supported statement',
  conceptIds: ['term-1'],
  citations: [citation],
}
const term = {
  id: 'term-1',
  term: 'term',
  definition: 'definition',
  citations: [citation],
}
const objective = { id: 'objective-1', text: 'learn it', evidenceIds: ['claim-1'] }
const card = {
  version: 1 as const,
  chunkId: chunk.chunkId,
  chunkHash: chunk.chunkHash,
  sourceId: chunk.sourceId,
  titlePath: chunk.titlePath,
  claims: [claim],
  terms: [term],
  learningObjectives: [objective],
}
const coverage = {
  input: 1,
  analysis: 1,
  citation: 1,
  chunksCompleted: 1,
  chunksFailed: 0,
  chunksTotal: 1,
}
const graph = {
  version: 1 as const,
  runId: 'run-1',
  graphHash: hash('b'),
  chunkPlanHash: hash('c'),
  sourceContentHashes: [hash('d')],
  policyVersion: 'policy-v1',
  promptVersion: 'prompt-v1',
  generatorProfile: 'profile-v1',
  chunks: [chunk],
  cards: [card],
  claims: [claim],
  terms: [term],
  learningObjectives: [objective],
  coverage,
  missingChunkIds: [],
  createdAt: 1_791_500_000_000,
}

describe('evidence contracts', () => {
  it('accepts a complete evidence graph and evidence-ready event', () => {
    expect(evidenceGraphSchema.parse(graph)).toEqual(graph)
    expect(analysisEventSchema.safeParse({
      version: 1,
      type: 'evidence.ready',
      eventId: 'event-1',
      runId: graph.runId,
      runRevision: 2,
      sequence: 1,
      createdAt: graph.createdAt,
      graphHash: graph.graphHash,
      cardCount: 1,
      claimCount: 1,
      coverage,
    }).success).toBe(true)
  })

  it('reports all chunk ordering and page invariants', () => {
    const result = evidenceChunkSchema.safeParse({
      ...chunk,
      start: 10,
      end: 5,
      ordinal: 1,
      pageStart: 2,
      pageEnd: 1,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(['end', 'ordinal', 'pageEnd']),
      )
    }
  })

  it('rejects duplicate, dangling and globally conflicting graph evidence', () => {
    const unknownCard = { ...card, chunkId: 'chunk-unknown' }
    const invalid = evidenceGraphSchema.safeParse({
      ...graph,
      chunks: [chunk, chunk],
      cards: [card, unknownCard],
      claims: [claim, claim],
      terms: [term, term],
      learningObjectives: [
        objective,
        { ...objective, evidenceIds: ['evidence-missing'] },
      ],
    })
    expect(invalid.success).toBe(false)
    if (!invalid.success) {
      const messages = invalid.error.issues.map((issue) => issue.message)
      expect(messages).toEqual(expect.arrayContaining([
        'chunk ids must be unique',
        'card references an unknown chunk',
        'claims ids must be unique',
        'terms ids must be unique',
        'learningObjectives ids must be unique',
        'evidence graph ids must be globally unique',
        'learning objective references unknown evidence',
      ]))
    }
  })

  it('rejects duplicate ids inside a card', () => {
    expect(evidenceCardSchema.safeParse({
      ...card,
      terms: [{ ...term, id: claim.id }],
    }).success).toBe(false)
  })
})

describe('source and canonical edge cases', () => {
  it('checks locator source bounds, pages and selected ranges', () => {
    const result = sourceSnapshotSchema.safeParse({
      version: 1,
      sourceId: 'source-1',
      kind: 'pdf',
      extractor: 'fixture-v1',
      contentHash: hash('e'),
      charCount: 10,
      byteCount: 10,
      pageCount: 1,
      selectedRange: { start: 0, end: 11 },
      locators: [{ start: 0, end: 11, titlePath: [], page: 2 }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'selected range exceeds source length',
        'locator range exceeds source length',
        'locator page exceeds source page count',
      ]))
    }
    expect(sourceSnapshotSchema.safeParse({
      version: 1,
      sourceId: 'source-1',
      kind: 'text',
      extractor: 'fixture-v1',
      contentHash: hash('e'),
      charCount: 10,
      byteCount: 10,
      selectedRange: { start: 5, end: 5 },
    }).success).toBe(false)
  })

  it('enforces UTF-8 upload byte limits independently from character count', () => {
    const text = '界'.repeat(Math.floor(ANALYSIS_LIMITS.maxUploadPartBytes / 3) + 1)
    expect(uploadSourcePartSchema.safeParse({
      version: 1,
      sourceId: 'source-1',
      contentHash: hash('f'),
      partHash: hash('0'),
      partIndex: 0,
      partCount: 1,
      start: 0,
      end: text.length,
      totalChars: text.length,
      text,
    }).success).toBe(false)
  })

  it('canonicalizes nested objects and rejects unsupported values', () => {
    expect(canonicalizeJson({ z: [-0, true, null], a: { value: 'ok' } }))
      .toBe('{"a":{"value":"ok"},"z":[0,true,null]}')
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/Non-finite/)
    expect(() => canonicalizeJson({ missing: undefined })).toThrow(/Undefined/)
    expect(() => canonicalizeJson(new Date())).toThrow(/Unsupported object/)
    expect(() => canonicalizeJson(Symbol('unsupported'))).toThrow(/Unsupported value/)
  })
})
