import { describe, expect, it } from 'vitest'
import validRequestFixture from '../fixtures/analysis-request.valid.json'
import invalidCycleFixture from '../fixtures/mindmap-artifact.cycle.invalid.json'
import invalidQuizFixture from '../fixtures/quiz-artifact.invalid.json'
import validSummaryFixture from '../fixtures/summary-artifact.valid.json'
import {
  analysisRequestSchema,
  artifactEnvelopeSchema,
  artifactReadyEventSchema,
  canonicalizeJson,
  mindMapArtifactEnvelopeSchema,
  quizArtifactEnvelopeSchema,
  summaryArtifactEnvelopeSchema,
  uploadSourcePartSchema,
  validateArtifactAgainstManifest,
  validateMindMapGraph,
} from '../src'

describe('analysis contract fixtures', () => {
  it('accepts a complete multi-artifact request', () => {
    const request = analysisRequestSchema.parse(validRequestFixture)

    expect(request.artifacts).toEqual(['summary', 'outline', 'mindmap', 'quiz', 'knowledge'])
    expect(request.manifest.sources[0]?.pageCount).toBe(2)
  })

  it('accepts a grounded summary and validates it against the source manifest', () => {
    const artifact = summaryArtifactEnvelopeSchema.parse(validSummaryFixture)
    const request = analysisRequestSchema.parse(validRequestFixture)

    expect(validateArtifactAgainstManifest(artifact, request.manifest)).toEqual([])
  })

  it('rejects unknown request fields instead of silently discarding them', () => {
    const result = analysisRequestSchema.safeParse({ ...validRequestFixture, baseUrl: 'https://example.invalid' })

    expect(result.success).toBe(false)
  })

  it('rejects a multiple-choice answer outside the option range', () => {
    expect(quizArtifactEnvelopeSchema.safeParse(invalidQuizFixture).success).toBe(false)
  })

  it('detects mind-map cycles after structural decoding', () => {
    const artifact = mindMapArtifactEnvelopeSchema.parse(invalidCycleFixture)
    const issues = validateMindMapGraph(artifact.payload)

    expect(issues.some((issue) => issue.message === 'parent cycle detected')).toBe(true)
    expect(issues.some((issue) => issue.message.includes('exactly one root'))).toBe(true)
  })

  it('rejects citations outside the selected source range', () => {
    const artifact = summaryArtifactEnvelopeSchema.parse(validSummaryFixture)
    const request = analysisRequestSchema.parse(validRequestFixture)
    request.manifest.sources[0]!.selectedRange = { start: 200, end: 400 }

    const issues = validateArtifactAgainstManifest(artifact, request.manifest)
    expect(issues.some((issue) => issue.code === 'range_invalid')).toBe(true)
  })

  it('rejects an artifact event that targets a different run', () => {
    const result = artifactReadyEventSchema.safeParse({
      version: 1,
      type: 'artifact.ready',
      eventId: 'event-1',
      runId: 'run-other',
      runRevision: 1,
      sequence: 3,
      createdAt: 1791500002000,
      artifact: validSummaryFixture,
    })

    expect(result.success).toBe(false)
  })

  it('keeps the top-level artifact decoder discriminated and strict', () => {
    const valid = artifactEnvelopeSchema.safeParse(validSummaryFixture)
    const invalid = artifactEnvelopeSchema.safeParse({ ...validSummaryFixture, kind: 'raw-model-response' })

    expect(valid.success).toBe(true)
    expect(invalid.success).toBe(false)
  })
})

describe('canonical request input', () => {
  it('is stable across object key order and normalizes negative zero', () => {
    const first = canonicalizeJson({ z: -0, a: { d: 2, c: 1 } })
    const second = canonicalizeJson({ a: { c: 1, d: 2 }, z: 0 })

    expect(first).toBe(second)
    expect(first).toBe('{"a":{"c":1,"d":2},"z":0}')
  })

  it('rejects undefined and non-finite numbers', () => {
    expect(() => canonicalizeJson({ value: undefined })).toThrow(/Undefined value/)
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow(/Non-finite number/)
  })
})

describe('source upload parts', () => {
  it('uses explicit UTF-16 character ranges without splitting contract identity', () => {
    const text = '光合🌱'
    const result = uploadSourcePartSchema.safeParse({
      version: 1,
      sourceId: 'source-1',
      contentHash: 'a'.repeat(64),
      partHash: 'b'.repeat(64),
      partIndex: 0,
      partCount: 1,
      start: 0,
      end: text.length,
      totalChars: text.length,
      text,
    })

    expect(result.success).toBe(true)
  })

  it('enforces the upload byte limit for multibyte text', () => {
    const text = '汉'.repeat(200_000)
    const result = uploadSourcePartSchema.safeParse({
      version: 1,
      sourceId: 'source-1',
      contentHash: 'a'.repeat(64),
      partHash: 'b'.repeat(64),
      partIndex: 0,
      partCount: 1,
      start: 0,
      end: text.length,
      totalChars: text.length,
      text,
    })

    expect(result.success).toBe(false)
  })
})
