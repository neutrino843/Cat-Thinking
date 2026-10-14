import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { analysisRequestSchema, collectArtifactCitations, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import { RunService } from '../src/domain/runService.js'
import { validateGeneratedArtifact } from '../src/domain/artifactValidator.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { ARTIFACT_REFERENCE_DRAFT_VERSION, ArtifactReferenceDraftError, createArtifactReferenceCatalog, hydrateArtifactReferenceDraft } from '../src/providers/artifactReferenceDraft.js'
import type { ModelRequest } from '../src/providers/modelProvider.js'
import { ARTIFACT_REFERENCE_CORPUS, createPublicCorpusEvidence } from './fixtures/artifactReferenceCorpus.js'
import { FakeAnalysisProvider, FIXTURE_TEXT } from './fixtures/fakeAnalysisProvider.js'
import { BrowserSyntheticProvider } from './fixtures/browserSyntheticProvider.js'
import { createPersonalFixtureFetch } from './fixtures/personalProviderFixture.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const decodeModelJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('Public artifact reference corpus', () => {
  it.each(ARTIFACT_REFERENCE_CORPUS)('$title: retains all verified support, and restores exact source citations', async (item) => {
    const { graph, snapshot } = createPublicCorpusEvidence(item)
    const catalog = createArtifactReferenceCatalog(graph)
    expect(catalog.references).toHaveLength(item.facts.length)
    expect(catalog.evidence.claims.map((claim) => claim.id)).toEqual(item.facts.map((fact) => fact.id))
    for (const claim of graph.claims) {
      const compactClaim = catalog.evidence.claims.find((entry) => entry.id === claim.id)!
      const refId = compactClaim.citations[0]!.refId
      expect(catalog.referenceById.get(refId)).toEqual(claim.citations[0])
      expect(snapshot.sourceId).toBe(claim.citations[0]!.sourceId)
      const source = claim.citations[0]!
      expect(item.text.slice(source.start, source.end)).toBe(source.quote)
      expect(catalog.evidence.terms.find((term) => term.id === `term-${claim.id}`)!.citations).toEqual([{ refId }])
      expect([...catalog.referencesByEvidenceId.get(`objective-${claim.id}`)!]).toEqual([refId])
    }
    const modelInput = JSON.stringify({ evidence: catalog.evidence, referenceCatalog: catalog.references })
    expect(modelInput.match(/"quote":/gu)).toHaveLength(item.facts.length)
    expect(modelInput).not.toContain('sourceText')
    expect(catalog.evidence.learningObjectives).toEqual(graph.learningObjectives)

    const grounded = { evidenceIds: graph.claims.map((claim) => claim.id), citations: catalog.references.map(({ refId }) => ({ refId })) }
    const payload = hydrateArtifactReferenceDraft('summary', decodeModelJson({ draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION,
      payload: { overview: { id: 'overview', text: item.expectedSummary, ...grounded },
        keyPoints: catalog.evidence.claims.map((claim) => ({ id: `point-${claim.id}`, text: claim.statement,
          evidenceIds: [claim.id], citations: claim.citations })), confusions: [] },
    }), catalog)
    const service = new RunService({ store: new InMemoryJobStore(), retentionSeconds: 3600, now: () => 1 })
    const { run } = await service.createRun('public-corpus', analysisRequestSchema.parse({ version: 1,
      requestKey: hash(item.id), docId: `document-${item.id}`, manifest: { version: 1, sources: [snapshot] },
      artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard',
        quizQuestionCount: 1, externalKnowledge: false } }))
    const artifact = validateGeneratedArtifact({ expectedKind: 'summary', graph: { ...graph, runId: run.id }, run,
      artifact: { version: 1, schemaVersion: 1, id: `artifact-${item.id}`, runId: run.id, docId: run.docId, kind: 'summary',
        sourceContentHashes: graph.sourceContentHashes, createdAt: 1, updatedAt: 1, payload } })
    const restored = collectArtifactCitations(artifact)
    expect(restored.every((citation) => citation.provenance === 'source')).toBe(true)
    for (const citation of restored) {
      if (citation.provenance !== 'source') throw new Error('unexpected corpus provenance')
      expect(item.text.slice(citation.start, citation.end)).toBe(citation.quote)
    }
    expect(item.expectedBehavior.length).toBeGreaterThan(0)
  })

  it('keeps repeated text at different positions separate while deduplicating identical support', () => {
    const item = ARTIFACT_REFERENCE_CORPUS.find((entry) => entry.id === 'repeated-passages')!
    const catalog = createArtifactReferenceCatalog(createPublicCorpusEvidence(item).graph)
    const repeats = catalog.references.filter(({ citation }) => citation.quote === '保持其他条件一致。')
    expect(repeats).toHaveLength(2)
    expect(repeats[0]!.citation.start).toBe(item.text.indexOf('保持其他条件一致。'))
    expect(repeats[1]!.citation.start).toBe(item.text.lastIndexOf('保持其他条件一致。'))
    expect(repeats[0]!.refId).not.toBe(repeats[1]!.refId)
  })

  it('reduces long repeated citation input without removing the final record', () => {
    const item = ARTIFACT_REFERENCE_CORPUS.find((entry) => entry.id === 'long-overlapping-support')!
    const { graph } = createPublicCorpusEvidence(item)
    const catalog = createArtifactReferenceCatalog(graph)
    const legacy = JSON.stringify({ evidence: { claims: graph.claims, terms: graph.terms, learningObjectives: graph.learningObjectives } })
    const compact = JSON.stringify({ evidence: catalog.evidence, referenceCatalog: catalog.references })
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(Buffer.byteLength(legacy, 'utf8') * 0.9)
    expect(catalog.references).toHaveLength(64)
    expect(catalog.evidence.claims.at(-1)!.id).toBe('record-64')
    expect(catalog.references.at(-1)!.citation.quote).toContain('第64组记录')
    expect(catalog.evidence.learningObjectives).toHaveLength(64)
  })

  it('rejects unknown references and a real reference selected for unrelated evidence', () => {
    const item = ARTIFACT_REFERENCE_CORPUS.find((entry) => entry.id === 'laboratory-chapters')!
    const catalog = createArtifactReferenceCatalog(createPublicCorpusEvidence(item).graph)
    const draft = (refId: string) => ({ draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, payload: {
      overview: { id: 'overview', text: '观察盐在水中的溶解过程。', evidenceIds: ['purpose'], citations: [{ refId }] },
      keyPoints: [{ id: 'point', text: '观察盐在水中的溶解过程。', evidenceIds: ['purpose'], citations: [{ refId }] }], confusions: [],
    } })
    for (const [refId, code] of [['cite-999', 'reference_not_found'], ['cite-4', 'reference_not_supported']] as const) {
      try {
        hydrateArtifactReferenceDraft('summary', draft(refId), catalog)
        throw new Error('invalid reference was accepted')
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactReferenceDraftError)
        expect(error).toMatchObject({ code })
      }
    }
  })
})

const fixtureModelRequest = (kind: ArtifactKind, refs: boolean): ModelRequest => {
  const citation = refs ? { refId: 'cite-29' } : { version: 1, provenance: 'source', sourceId: 'synthetic-source',
    start: 0, end: FIXTURE_TEXT.length, quote: FIXTURE_TEXT }
  const grounded = { evidenceIds: ['provided-claim'], citations: [citation] }
  return { invocationId: `fixture-${kind}`, role: `artifact-${kind}`, qualityProfile: 'standard', systemPrompt: '',
    userPrompt: JSON.stringify({ kind, options: { quizQuestionCount: 3 }, evidence: {
      claims: [{ id: 'provided-claim', statement: FIXTURE_TEXT, citations: [citation] }], terms: [], learningObjectives: [],
    }, referenceCatalog: refs ? [{ refId: 'cite-29', citation: { version: 1, provenance: 'source', sourceId: 'synthetic-source',
      start: 0, end: FIXTURE_TEXT.length, quote: FIXTURE_TEXT } }] : undefined,
    outline: kind === 'mindmap' ? { title: 'Photosynthesis', nodes: [{ id: 'source-node', title: 'Energy conversion', ...grounded, children: [] }] } : undefined }),
    maxOutputTokens: 4096, output: { name: refs ? `artifact_${kind}_source_refs_v1` : `artifact_${kind}_v1`, schema: {} } }
}

const allCitationLists = (value: unknown): unknown[][] => {
  if (Array.isArray(value)) return value.flatMap(allCitationLists)
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [...(Array.isArray(record.citations) ? [record.citations] : []),
    ...Object.entries(record).filter(([key]) => key !== 'citations').flatMap(([, item]) => allCitationLists(item))]
}

describe('Synthetic provider artifact wire compatibility', () => {
  it.each(['summary', 'outline', 'mindmap', 'quiz', 'knowledge'] as const)('%s copies the supplied compact ID, and keeps legacy output independent', (kind) => {
    const provider = new FakeAnalysisProvider()
    const compact = JSON.parse(provider.output(fixtureModelRequest(kind, true))) as { draftVersion: string; payload: unknown }
    expect(compact.draftVersion).toBe(ARTIFACT_REFERENCE_DRAFT_VERSION)
    const compactCitations = allCitationLists(compact.payload).flat()
    expect(compactCitations.length).toBeGreaterThan(0)
    expect(compactCitations.every((citation) => JSON.stringify(citation) === '{"refId":"cite-29"}')).toBe(true)
    const legacy = JSON.parse(provider.output(fixtureModelRequest(kind, false))) as Record<string, unknown>
    expect(legacy).not.toHaveProperty('draftVersion')
    expect(allCitationLists(legacy).flat()).toContainEqual(expect.objectContaining({ sourceId: 'synthetic-source', quote: FIXTURE_TEXT }))
  })

  it('browser knowledge inference uses compact explicit provenance only on the new output name', async () => {
    const provider = new BrowserSyntheticProvider()
    const result = await provider.generate(fixtureModelRequest('knowledge', true), new AbortController().signal)
    const compact = JSON.parse(result.outputText) as { payload: unknown }
    expect(allCitationLists(compact.payload).flat()).toContainEqual({ provenance: 'inference', label: '基于能量转换证据的学习推断' })
    expect(allCitationLists(compact.payload).flat()).not.toContainEqual(expect.objectContaining({ version: 1 }))
    const legacy = await provider.generate(fixtureModelRequest('knowledge', false), new AbortController().signal)
    expect(allCitationLists(JSON.parse(legacy.outputText)).flat()).toContainEqual({ version: 1,
      provenance: 'inference', label: '基于能量转换证据的学习推断' })
  })

  it('browser partial failures do not confuse identical compact IDs from two documents', async () => {
    const provider = new BrowserSyntheticProvider()
    const requestFor = (sourceId: string) => {
      const request = fixtureModelRequest('outline', true)
      const prompt = JSON.parse(request.userPrompt) as { evidence: { claims: { statement: string }[] };
        referenceCatalog: { citation: { sourceId: string } }[] }
      prompt.evidence.claims[0]!.statement += ' fixture partial'
      prompt.referenceCatalog[0]!.citation.sourceId = sourceId
      return { ...request, userPrompt: JSON.stringify(prompt) }
    }
    const first = requestFor('synthetic-source-first')
    const second = requestFor('synthetic-source-second')
    await expect(provider.generate(first, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'synthetic_partial_failure' })
    await expect(provider.generate(first, new AbortController().signal)).resolves.toMatchObject({ outputText: expect.any(String) })
    await expect(provider.generate(second, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'synthetic_partial_failure' })
  })

  it.each(['json-schema', 'json-object'] as const)('personal fake HTTP retains source-reference drafts in %s mode', async (mode) => {
    const fixture = createPersonalFixtureFetch()
    const request = fixtureModelRequest('summary', true)
    const response = await fixture.fetchImplementation('http://127.0.0.1:9876/v1/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'synthetic-model', messages: [
        { role: 'system', content: 'Return artifact-source-refs-v1 drafts.' }, { role: 'user', content: request.userPrompt },
      ], response_format: mode === 'json-schema' ? { type: 'json_schema', json_schema: { name: request.output.name, schema: {} } }
        : { type: 'json_object' } }), signal: new AbortController().signal })
    const responseBody = await response.json() as { choices: { message: { content: string } }[] }
    const draft = JSON.parse(responseBody.choices[0]!.message.content) as { draftVersion: string; payload: unknown }
    expect(draft.draftVersion).toBe(ARTIFACT_REFERENCE_DRAFT_VERSION)
    expect(allCitationLists(draft.payload).flat()).toContainEqual({ refId: 'cite-29' })
    expect(fixture.calls).toEqual([{ method: 'POST', modelId: 'synthetic-model' }])
  })
})
