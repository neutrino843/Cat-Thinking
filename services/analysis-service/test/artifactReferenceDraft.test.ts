import {
  artifactEnvelopeSchema, evidenceGraphSchema, mindMapArtifactSchema, outlineArtifactSchema,
  quizArtifactSchema, summaryArtifactSchema, knowledgeArtifactSchema,
  type ArtifactKind, type EvidenceGraphV1, type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_REFERENCE_DRAFT_VERSION, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION,
  ARTIFACT_SOURCE_REFERENCE_VERSIONS, ArtifactReferenceDraftError,
  artifactReferenceDraftOutputSchema, artifactReferenceDraftSchema,
  compactArtifactOutline, createArtifactReferenceCatalog, hydrateArtifactReferenceDraft,
} from '../src/providers/artifactReferenceDraft.js'
import { strictOutputSchema } from '../src/providers/strictOutputSchema.js'

const hash = 'a'.repeat(64)
const citation: SourceCitationV1 = {
  version: 1, provenance: 'source', sourceId: 'source-public', start: 0, end: 4, quote: '原文事实',
  page: 1, locator: '第一节',
}
const otherCitation: SourceCitationV1 = { ...citation, start: 5, end: 9, quote: '后续知识' }
const graphFor = (): EvidenceGraphV1 => evidenceGraphSchema.parse({
  version: 1, runId: 'run-public', graphHash: hash, chunkPlanHash: hash, sourceContentHashes: [hash],
  policyVersion: 'public-fixture', promptVersion: 'public-evidence', generatorProfile: 'fake-fixture',
  chunks: [{ version: 1, chunkId: 'chunk-public', chunkHash: hash, sourceId: 'source-public', start: 0, end: 50,
    titlePath: ['知识'], estimatedTokens: 25, ordinal: 0, total: 1, overlapBefore: 0, overlapAfter: 0 }],
  cards: [{ version: 1, chunkId: 'chunk-public', chunkHash: hash, sourceId: 'source-public', titlePath: ['知识'],
    claims: [{ id: 'card-claim', kind: 'fact', statement: '原文事实', conceptIds: [], citations: [citation] }],
    terms: [], learningObjectives: [] }],
  claims: [
    { id: 'claim-one', kind: 'fact', statement: '原文事实', conceptIds: ['term-one'], citations: [citation] },
    { id: 'claim-two', kind: 'fact', statement: '后续知识', conceptIds: [], citations: [otherCitation] },
  ],
  terms: [{ id: 'term-one', term: '事实', definition: '原文支持的知识', citations: [citation] }],
  learningObjectives: [{ id: 'objective-one', text: '理解联系', evidenceIds: ['claim-one', 'term-one', 'claim-two'] }],
  coverage: { input: 1, analysis: 1, citation: 1, chunksCompleted: 1, chunksFailed: 0, chunksTotal: 1 },
  missingChunkIds: [], createdAt: 1,
})
const text = (id: string, evidenceId = 'claim-one', refId = 'cite-1') => ({
  id, text: '原文支持的学习要点', evidenceIds: [evidenceId], citations: [{ refId }],
})
const payloadFor = (kind: ArtifactKind): Record<string, unknown> => {
  switch (kind) {
    case 'summary': return { overview: text('overview'), keyPoints: [text('point')], confusions: [] }
    case 'outline': return { title: '有联系的结构', nodes: [{ id: 'concept', title: '事实',
      evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }], children: [{ id: 'detail', title: '后续知识',
        evidenceIds: ['claim-two'], citations: [{ refId: 'cite-2' }], children: [] }] }] }
    case 'mindmap': return { title: '有联系的结构', nodes: [
      { id: 'document-root', parentId: null, text: '有联系的结构', evidenceIds: [], citations: [] },
      { id: 'concept', parentId: 'document-root', text: '事实', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }] },
    ], relations: [] }
    case 'quiz': return { title: '自测', questions: [{ id: 'question', type: 'true-false', prompt: '事实是否成立？',
      explanation: '请复核原文', difficulty: 'easy', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }], answer: true }] }
    case 'knowledge': return { items: [{ id: 'knowledge', title: '根据事实推断', explanation: '原文支持的联系',
      relationship: 'extension', provenance: 'inference', evidenceIds: ['claim-one'],
      citations: [{ refId: 'cite-1' }, { provenance: 'inference', label: '根据原文整理的推断' }] }] }
  }
}
const draftFor = (kind: ArtifactKind) => ({ draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, payload: payloadFor(kind) })
const schemas = { summary: summaryArtifactSchema, outline: outlineArtifactSchema, mindmap: mindMapArtifactSchema,
  quiz: quizArtifactSchema, knowledge: knowledgeArtifactSchema }
const expectCode = (run: () => unknown, code: ArtifactReferenceDraftError['code']) => {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(ArtifactReferenceDraftError)
    expect((error as ArtifactReferenceDraftError).code).toBe(code)
    return
  }
  throw new Error(`expected draft failure ${code}`)
}

describe('program-owned Artifact reference catalog', () => {
  it('deduplicates exact citations while retaining claim, term and objective support', () => {
    const catalog = createArtifactReferenceCatalog(graphFor())
    expect(catalog.references).toEqual([{ refId: 'cite-1', citation }, { refId: 'cite-2', citation: otherCitation }])
    expect(catalog.evidence.claims[0].citations).toEqual([{ refId: 'cite-1' }])
    expect(catalog.evidence.terms[0].citations).toEqual([{ refId: 'cite-1' }])
    expect([...catalog.referencesByEvidenceId.get('objective-one') ?? []]).toEqual(['cite-1', 'cite-2'])
    expect(JSON.stringify(catalog.evidence)).not.toContain('"quote"')
    expect(JSON.stringify(catalog.references).match(/原文事实/gu)).toHaveLength(1)
  })
  it.each(['quote', 'page', 'locator'] as const)('does not merge different %s identities at the same offsets', (field) => {
    const graph = graphFor()
    const different = { ...citation, [field]: field === 'page' ? 2 : '另一标记' }
    graph.claims[1].citations = [different]
    expect(createArtifactReferenceCatalog(graph).references).toHaveLength(2)
  })
  it('does not merge repeated source text at different positions', () => {
    const graph = graphFor()
    graph.claims[1].citations = [{ ...citation, start: 10, end: 14 }]
    expect(createArtifactReferenceCatalog(graph).references).toHaveLength(2)
  })
  it.each(['cross-kind-id', 'objective-unknown', 'objective-objective', 'no-source', 'unknown-source', 'outside-source'])(
    'rejects invalid graph support: %s', (scenario) => {
      const graph = graphFor()
      if (scenario === 'cross-kind-id') graph.terms[0].id = graph.claims[0].id
      if (scenario === 'objective-unknown') graph.learningObjectives[0].evidenceIds = ['missing']
      if (scenario === 'objective-objective') graph.learningObjectives[0].evidenceIds = ['objective-one']
      if (scenario === 'no-source') { graph.claims = []; graph.terms = []; graph.learningObjectives = [] }
      if (scenario === 'unknown-source') graph.claims[0].citations[0].sourceId = 'missing-source'
      if (scenario === 'outside-source') graph.claims[0].citations[0].end = 51
      expectCode(() => createArtifactReferenceCatalog(graph), 'catalog_invalid')
    })
  it('keeps the catalog isolated from subsequent graph mutation', () => {
    const graph = graphFor()
    const catalog = createArtifactReferenceCatalog(graph)
    graph.claims[0].citations[0].quote = '后来改动的文字'
    expect(catalog.referenceById.get('cite-1')?.quote).toBe('原文事实')
    expect(Object.isFrozen(catalog.references[0].citation)).toBe(true)
    expect(Object.isFrozen(catalog.evidence.claims[0].conceptIds)).toBe(true)
    expect(Object.isFrozen(catalog.evidence.learningObjectives[0].evidenceIds)).toBe(true)
  })
  it('rejects excessive prompt evidence instead of silently dropping references', () => {
    const graph = graphFor()
    graph.claims = Array.from({ length: 150 }, (_, index) => ({ ...graph.claims[0], id: `claim-${index}`,
      statement: '公'.repeat(20_000) }))
    graph.learningObjectives = []
    expectCode(() => createArtifactReferenceCatalog(graph), 'capacity_exceeded')
  })
})

describe('private Artifact drafts hydrate to the existing V1 contract', () => {
  it.each(['summary', 'outline', 'mindmap', 'quiz', 'knowledge'] as const)('hydrates %s without model-owned source fields', (kind) => {
    const catalog = createArtifactReferenceCatalog(graphFor())
    const payload = hydrateArtifactReferenceDraft(kind, draftFor(kind), catalog)
    expect(schemas[kind].safeParse(payload).success).toBe(true)
    expect(artifactEnvelopeSchema.safeParse({ version: 1, schemaVersion: 1, id: `artifact-${kind}`, kind,
      runId: 'run-public', docId: 'doc-public', sourceContentHashes: [hash], createdAt: 1, updatedAt: 1, payload }).success).toBe(true)
    expect(JSON.stringify(payload)).toContain('"quote":"原文事实"')
    expect(JSON.stringify(payload)).not.toContain('"refId"')
    expect(artifactReferenceDraftSchema(kind).safeParse(draftFor(kind)).success).toBe(true)
    expect(artifactReferenceDraftOutputSchema(kind)).toHaveProperty('additionalProperties', false)
  })
  it('maintains the new version family without changing public Artifact version 1', () => {
    expect(ARTIFACT_SOURCE_REFERENCE_VERSIONS).toEqual({ summary: 'summary-grounded-refs-v2',
      outline: 'outline-grounded-hierarchy-refs-v3', mindmap: 'mindmap-outline-hierarchy-refs-v3',
      quiz: 'quiz-grounded-refs-v2', knowledge: 'knowledge-grounded-refs-v3' })
    expect(ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION).toBe('artifact-ref-repair-v3')
  })
  it('resolves learning objectives through their verified supporting evidence', () => {
    const draft = draftFor('summary')
    draft.payload.overview = text('overview', 'objective-one', 'cite-2')
    const payload = summaryArtifactSchema.parse(hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())))
    expect(payload.overview.citations).toEqual([otherCitation])
  })
  it('does not fill in absent quotes from another citation or source span', () => {
    const graph = graphFor()
    delete graph.claims[0].citations[0].quote
    const catalog = createArtifactReferenceCatalog(graph)
    const payload = summaryArtifactSchema.parse(hydrateArtifactReferenceDraft('summary', draftFor('summary'), catalog))
    expect(payload.overview.citations[0]).not.toHaveProperty('quote')
    expect(catalog.references).toHaveLength(3)
  })
  it.each(['unknown-ref', 'wrong-evidence', 'unknown-evidence'])('rejects %s instead of attaching any available source', (scenario) => {
    const draft = draftFor('summary')
    draft.payload.overview = text('overview', scenario === 'unknown-evidence' ? 'missing' : 'claim-one',
      scenario === 'unknown-ref' ? 'cite-999' : 'cite-2')
    expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())),
      scenario === 'unknown-ref' ? 'reference_not_found' : scenario === 'unknown-evidence' ? 'evidence_invalid' : 'reference_not_supported')
  })
  it.each(['sourceId', 'start', 'end', 'quote', 'page', 'locator', 'version', 'unexpected'])(
    'rejects additional model-owned reference field %s', (field) => {
      const draft = draftFor('summary')
      draft.payload.overview = { ...text('overview'), citations: [{ refId: 'cite-1', [field]: field === 'start' ? 0 : 'forged' }] }
      expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    })
  it.each(['old-payload', 'old-citation', 'wrong-version', 'wrapper-identity', 'external'])('rejects mixed or downgraded contracts: %s', (scenario) => {
    const original = draftFor('summary')
    let draft: unknown = original
    if (scenario === 'old-payload') draft = original.payload
    if (scenario === 'old-citation') original.payload.overview = { ...text('overview'), citations: [citation] }
    if (scenario === 'wrong-version') draft = { ...original, draftVersion: 'artifact-v1' }
    if (scenario === 'wrapper-identity') draft = { ...original, runId: 'forged' }
    if (scenario === 'external') original.payload.overview = { ...text('overview'), citations: [{ provenance: 'external', externalSourceId: 'web' }] }
    expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
  })
  it('normalizes optional provider nulls while retaining the required nullable map parent', () => {
    const draft = draftFor('mindmap')
    draft.payload.nodes = [
      { id: 'root', parentId: null, text: '有联系的结构', note: null, evidenceIds: [], citations: [] },
      { id: 'concept', parentId: 'root', text: '事实', note: null, evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }] },
    ]
    const payload = mindMapArtifactSchema.parse(hydrateArtifactReferenceDraft('mindmap', draft, createArtifactReferenceCatalog(graphFor())))
    expect(payload.nodes[0].parentId).toBeNull()
    expect(payload.nodes.every((node) => node.note === undefined)).toBe(true)
    const summary = { ...draftFor('summary'), payload: { ...payloadFor('summary'), conclusion: null } }
    expect(summaryArtifactSchema.parse(hydrateArtifactReferenceDraft('summary', summary, createArtifactReferenceCatalog(graphFor()))).conclusion).toBeUndefined()
    expect(strictOutputSchema(artifactReferenceDraftOutputSchema('mindmap'))).toHaveProperty('additionalProperties', false)
  })
  it('rejects null for required source reference ids and missing nullable parents', () => {
    const draft = draftFor('summary')
    draft.payload.overview = { ...text('overview'), citations: [{ refId: null }] }
    expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    const map = draftFor('mindmap')
    map.payload.nodes = [{ id: 'root', text: '有联系的结构', evidenceIds: [], citations: [] }]
    expectCode(() => hydrateArtifactReferenceDraft('mindmap', map, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
  })
  it.each(['missing-marker', 'missing-label', 'missing-source', 'source-with-inference'])('keeps inference explicitly labeled and grounded: %s', (scenario) => {
    const draft = draftFor('knowledge')
    const item = (draft.payload.items as Record<string, unknown>[])[0]
    if (scenario === 'missing-marker') item.citations = [{ refId: 'cite-1' }]
    if (scenario === 'missing-label') item.citations = [{ refId: 'cite-1' }, { provenance: 'inference' }]
    if (scenario === 'missing-source') item.citations = [{ provenance: 'inference', label: '推断' }]
    if (scenario === 'source-with-inference') item.provenance = 'source'
    expectCode(() => hydrateArtifactReferenceDraft('knowledge', draft, createArtifactReferenceCatalog(graphFor())), 'inference_invalid')
  })
  it('never permits inference citations on a summary', () => {
    const draft = draftFor('summary')
    draft.payload.overview = { ...text('overview'), citations: [{ provenance: 'inference', label: '推断' }] }
    expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())), 'inference_invalid')
  })
  it('preserves an ordinary source knowledge item as a fact without adding an inference marker', () => {
    const draft = draftFor('knowledge')
    const item = (draft.payload.items as Record<string, unknown>[])[0]
    item.provenance = 'source'
    item.citations = [{ refId: 'cite-1' }]
    const payload = knowledgeArtifactSchema.parse(hydrateArtifactReferenceDraft('knowledge', draft, createArtifactReferenceCatalog(graphFor())))
    expect(payload.items[0].provenance).toBe('source')
    expect(payload.items[0].citations).toEqual([citation])
  })
  it('preserves multiple-choice and self-assessed short-answer fields under the same reference protocol', () => {
    const draft = draftFor('quiz')
    const base = { prompt: '哪项？', explanation: '原文解释', difficulty: 'easy', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }] }
    draft.payload.questions = [
      { ...base, id: 'choice', type: 'multiple-choice', options: ['正确', '错误'], answerIndex: 0 },
      { ...base, id: 'short', type: 'short-answer', answer: '正确内容', rubric: ['原文支持'] },
    ]
    const payload = quizArtifactSchema.parse(hydrateArtifactReferenceDraft('quiz', draft, createArtifactReferenceCatalog(graphFor())))
    expect(payload.questions[0]).toMatchObject({ type: 'multiple-choice', answerIndex: 0, options: ['正确', '错误'] })
    expect(payload.questions[1]).toMatchObject({ type: 'short-answer', answer: '正确内容', rubric: ['原文支持'] })
  })
  it('reapplies answer and uniqueness invariants from the public Quiz and MindMap schemas', () => {
    const draft = draftFor('quiz')
    draft.payload.questions = [{ id: 'question', type: 'multiple-choice', prompt: '哪项？', explanation: '原文解释',
      difficulty: 'easy', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }], options: ['正确', '错误'], answerIndex: 3 }]
    expectCode(() => hydrateArtifactReferenceDraft('quiz', draft, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    const map = draftFor('mindmap')
    map.payload.nodes = [
      { id: 'root', parentId: null, text: '有联系的结构', evidenceIds: [], citations: [] },
      { id: 'root', parentId: null, text: '有联系的结构', evidenceIds: [], citations: [] },
    ]
    expectCode(() => hydrateArtifactReferenceDraft('mindmap', map, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
  })
  it.each(['__proto__', 'prototype', 'constructor'])('rejects JSON prototype key %s without mutation', (key) => {
    const draft = JSON.parse(JSON.stringify(draftFor('summary')).replace('"overview":{', `"overview":{"${key}":{},`))
    expectCode(() => hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it('rejects cyclic values and getters before recursive parsing', () => {
    const cyclic: Record<string, unknown> = draftFor('summary')
    cyclic.payload = cyclic
    expectCode(() => hydrateArtifactReferenceDraft('summary', cyclic, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    let executed = false
    const hostile = { get payload() { executed = true; return payloadFor('summary') }, draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION }
    expectCode(() => hydrateArtifactReferenceDraft('summary', hostile, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
    expect(executed).toBe(false)
  })
  it.each([undefined, NaN, Infinity, 1n])('rejects non-JSON primitive %s with a safe failure code', (value) => {
    expectCode(() => hydrateArtifactReferenceDraft('summary', value, createArtifactReferenceCatalog(graphFor())), 'schema_invalid')
  })
  it('enforces the aggregate Outline node limit across many valid branches', () => {
    const node = (id: string) => ({ id, title: '事实', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }], children: [] })
    const parents = Array.from({ length: 5 }, (_, index) => ({ ...node(`parent-${index}`),
      children: Array.from({ length: 99 }, (_, child) => node(`child-${index}-${child}`)) }))
    const catalog = createArtifactReferenceCatalog(graphFor())
    const value = { draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, payload: { title: '结构', nodes: parents } }
    expect(() => hydrateArtifactReferenceDraft('outline', value, catalog)).not.toThrow()
    parents[0].children.push(node('over-limit'))
    expectCode(() => hydrateArtifactReferenceDraft('outline', value, catalog), 'capacity_exceeded')
  })
  it('allows shallow grounded maps and bounded outlines but safely rejects excessive depth', () => {
    const catalog = createArtifactReferenceCatalog(graphFor())
    expect(() => hydrateArtifactReferenceDraft('mindmap', draftFor('mindmap'), catalog)).not.toThrow()
    const outline = (depth: number) => {
      let node: Record<string, unknown> = { id: `node-${depth}`, title: '知识', evidenceIds: ['claim-one'], citations: [{ refId: 'cite-1' }], children: [] }
      for (let level = depth - 1; level > 0; level -= 1) node = { ...node, id: `node-${level}`, children: [node] }
      return { draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, payload: { title: '层级', nodes: [node] } }
    }
    expect(() => hydrateArtifactReferenceDraft('outline', outline(20), catalog)).not.toThrow()
    expectCode(() => hydrateArtifactReferenceDraft('outline', outline(40), catalog), 'capacity_exceeded')
  })
  it('fails a too-large UTF-8 draft before hydration without exposing source text in errors', () => {
    const draft = draftFor('summary')
    draft.payload.overview = { ...text('overview'), text: '秘'.repeat(700_000) }
    let error: unknown
    try { hydrateArtifactReferenceDraft('summary', draft, createArtifactReferenceCatalog(graphFor())) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ArtifactReferenceDraftError)
    expect((error as Error).message).not.toContain('秘')
    expect((error as ArtifactReferenceDraftError).code).toBe('capacity_exceeded')
  })
})

describe('compact Outline input for the next Artifact', () => {
  it('preserves nested IDs, titles and parent order while removing repeated source quote payloads', () => {
    const catalog = createArtifactReferenceCatalog(graphFor())
    const outline = outlineArtifactSchema.parse(hydrateArtifactReferenceDraft('outline', draftFor('outline'), catalog))
    expect(compactArtifactOutline(outline, catalog)).toEqual(payloadFor('outline'))
    expect(JSON.stringify(compactArtifactOutline(outline, catalog))).not.toContain('"quote"')
  })
  it('supports omitted legacy quotes only when remaining identity fields match unambiguously', () => {
    const graph = graphFor()
    let catalog = createArtifactReferenceCatalog(graph)
    const outline = outlineArtifactSchema.parse(hydrateArtifactReferenceDraft('outline', draftFor('outline'), catalog))
    const source = outline.nodes[0].citations[0]
    if (source.provenance === 'source') delete source.quote
    expect(() => compactArtifactOutline(outline, catalog)).not.toThrow()
    graph.claims[1].citations = [{ ...citation, quote: '不同引文' }]
    graph.learningObjectives[0].evidenceIds = ['claim-one', 'claim-two']
    catalog = createArtifactReferenceCatalog(graph)
    outline.nodes[0].evidenceIds = ['objective-one']
    expectCode(() => compactArtifactOutline(outline, catalog), 'reference_not_supported')
  })
})
