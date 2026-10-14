import {
  evidenceGraphSchema, mindMapArtifactEnvelopeSchema, quizArtifactEnvelopeSchema,
  type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { deriveKnowledgePracticeLinks, KnowledgePracticeLinkError } from './knowledgePracticeLinks'

const hash = 'a'.repeat(64)
const citation: SourceCitationV1 = { version: 1, provenance: 'source', sourceId: 'public-source',
  start: 0, end: 4, quote: '知识事实', page: 1, locator: '第一节' }
const nextCitation: SourceCitationV1 = { ...citation, start: 10, end: 14 }
const fixture = () => {
  const envelope = { version: 1, schemaVersion: 1, runId: 'public-run', docId: 'public-doc',
    sourceContentHashes: [hash], createdAt: 1, updatedAt: 1 }
  const mindmap = mindMapArtifactEnvelopeSchema.parse({ ...envelope, id: 'map-artifact', kind: 'mindmap', payload: {
    title: '知识联系', nodes: [
      { id: 'document-root', parentId: null, text: '知识联系', evidenceIds: [], citations: [] },
      { id: 'energy', parentId: 'document-root', text: '同名知识', evidenceIds: ['claim-energy'], citations: [citation] },
      { id: 'other', parentId: 'document-root', text: '同名知识', evidenceIds: ['claim-other'], citations: [nextCitation] },
    ], relations: [],
  } })
  const baseQuestion = { prompt: '同名知识', explanation: '请复核原文', difficulty: 'easy', type: 'true-false', answer: true }
  const quiz = quizArtifactEnvelopeSchema.parse({ ...envelope, id: 'quiz-artifact', kind: 'quiz', payload: {
    title: '知识自测', questions: [
      { ...baseQuestion, id: 'question-energy', evidenceIds: ['claim-energy'], citations: [citation] },
      { ...baseQuestion, id: 'question-other', evidenceIds: ['claim-other'], citations: [nextCitation] },
      { ...baseQuestion, id: 'same-title-unrelated', evidenceIds: ['claim-separate'], citations: [citation] },
    ],
  } })
  const graph = evidenceGraphSchema.parse({
    version: 1, runId: 'public-run', graphHash: hash, chunkPlanHash: hash, sourceContentHashes: [hash],
    policyVersion: 'public-policy', promptVersion: 'public-evidence', generatorProfile: 'fake-public',
    chunks: [{ version: 1, chunkId: 'public-chunk', chunkHash: hash, sourceId: 'public-source', start: 0, end: 50,
      titlePath: [], estimatedTokens: 25, ordinal: 0, total: 1, overlapBefore: 0, overlapAfter: 0 }],
    cards: [{ version: 1, chunkId: 'public-chunk', chunkHash: hash, sourceId: 'public-source', titlePath: [],
      claims: [{ id: 'public-card-claim', kind: 'fact', statement: '知识事实', conceptIds: [], citations: [citation] }],
      terms: [], learningObjectives: [] }],
    claims: [
      { id: 'claim-energy', kind: 'fact', statement: '知识事实', conceptIds: [], citations: [citation] },
      { id: 'claim-other', kind: 'fact', statement: '知识事实', conceptIds: [], citations: [nextCitation] },
      { id: 'claim-separate', kind: 'fact', statement: '知识事实', conceptIds: [], citations: [citation] },
    ], terms: [], learningObjectives: [{ id: 'objective-energy', text: '理解事实', evidenceIds: ['claim-energy'] }],
    coverage: { input: 1, analysis: 1, citation: 1, chunksCompleted: 1, chunksFailed: 0, chunksTotal: 1 },
    missingChunkIds: [], createdAt: 1,
  })
  return { mindmap, quiz, graph }
}
const expectCode = (run: () => unknown, code: KnowledgePracticeLinkError['code']) => {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(KnowledgePracticeLinkError)
    expect((error as KnowledgePracticeLinkError).code).toBe(code)
    return
  }
  throw new Error(`expected knowledge link error ${code}`)
}

describe('same-run knowledge and practice links', () => {
  it('links exact evidence and citation support, never matching equal titles or inferring links for a parent', () => {
    const f = fixture()
    const before = JSON.stringify(f)
    const result = deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz })
    expect(result.links).toEqual([
      { nodeId: 'energy', questionId: 'question-energy', sharedEvidenceIds: ['claim-energy'], sourceCitations: [citation] },
      { nodeId: 'other', questionId: 'question-other', sharedEvidenceIds: ['claim-other'], sourceCitations: [nextCitation] },
    ])
    expect(result.links.some((link) => link.nodeId === 'document-root' || link.questionId === 'same-title-unrelated')).toBe(false)
    expect(result).toMatchObject({ version: 1, docId: 'public-doc', runId: 'public-run',
      mindmapArtifactId: 'map-artifact', quizArtifactId: 'quiz-artifact' })
    expect(result).not.toHaveProperty('mastery')
    expect(JSON.stringify(f)).toBe(before)
    expect(Object.isFrozen(result.links[0].sourceCitations[0])).toBe(true)
  })
  it('allows many precise questions for one node and keeps the original artifact node ID', () => {
    const f = fixture()
    f.quiz.payload.questions.push({ ...f.quiz.payload.questions[0], id: 'second-energy' })
    const links = deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links
    expect(links.filter((link) => link.nodeId === 'energy').map((link) => link.questionId)).toEqual(['question-energy', 'second-energy'])
  })
  it.each(['page', 'locator', 'quote', 'range', 'sourceId'])('does not guess when the shared evidence citation %s differs', (field) => {
    const f = fixture()
    const changed = f.quiz.payload.questions[0].citations[0]
    if (changed.provenance !== 'source') throw new Error('public source required')
    if (field === 'page') changed.page = 2
    if (field === 'locator') changed.locator = '第二节'
    if (field === 'quote') changed.quote = '另一事实'
    if (field === 'range') { changed.start = 10; changed.end = 14 }
    if (field === 'sourceId') changed.sourceId = 'another-source'
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links.some((link) => link.nodeId === 'energy')).toBe(false)
  })
  it('accepts optional quote omission while preserving the known exact quote and metadata', () => {
    const f = fixture()
    const changed = f.quiz.payload.questions[0].citations[0]
    if (changed.provenance === 'source') delete changed.quote
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }).links[0].sourceCitations).toEqual([citation])
  })
  it('does not choose between contradictory quoted citations hidden behind an omitted quote', () => {
    const f = fixture()
    f.mindmap.payload.nodes[1].citations.push({ ...citation, quote: '相反内容' })
    const changed = f.quiz.payload.questions[0].citations[0]
    if (changed.provenance === 'source') delete changed.quote
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links.some((link) => link.nodeId === 'energy')).toBe(false)
  })
  it.each(['docId', 'runId', 'sourceHash', 'missingSourceHash', 'artifactId'])('rejects identity mismatch %s without changing input', (field) => {
    const f = fixture()
    if (field === 'docId') f.quiz.docId = 'other-doc'
    if (field === 'runId') f.quiz.runId = 'other-run'
    if (field === 'sourceHash') f.quiz.sourceContentHashes = ['b'.repeat(64)]
    if (field === 'missingSourceHash') f.quiz.sourceContentHashes = [hash, hash]
    if (field === 'artifactId') f.quiz.id = f.mindmap.id
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }), 'identity_mismatch')
  })
  it('compares source hashes as a sorted multiset, preserving legitimate identical-content source multiplicity', () => {
    const f = fixture()
    f.mindmap.sourceContentHashes = [hash, 'b'.repeat(64), hash]
    f.quiz.sourceContentHashes = [hash, hash, 'b'.repeat(64)]
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).sourceContentHashes).toEqual([hash, hash, 'b'.repeat(64)])
    f.quiz.sourceContentHashes = [hash, 'b'.repeat(64)]
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }), 'identity_mismatch')
  })
  it.each(['duplicate-node', 'duplicate-question', 'cycle', 'missing-parent', 'future-version', 'private-draft', 'wrong-kind'])(
    'rejects malformed or unsupported contracts: %s', (scenario) => {
      const f = fixture()
      let mindmap: unknown = f.mindmap
      let quiz: unknown = f.quiz
      if (scenario === 'duplicate-node') f.mindmap.payload.nodes.push({ ...f.mindmap.payload.nodes[1] })
      if (scenario === 'duplicate-question') f.quiz.payload.questions.push({ ...f.quiz.payload.questions[0] })
      if (scenario === 'cycle') f.mindmap.payload.nodes[1].parentId = 'energy'
      if (scenario === 'missing-parent') f.mindmap.payload.nodes[1].parentId = 'missing'
      if (scenario === 'future-version') quiz = { ...f.quiz, schemaVersion: 2 }
      if (scenario === 'private-draft') quiz = { draftVersion: 'artifact-source-refs-v1', payload: f.quiz.payload }
      if (scenario === 'wrong-kind') mindmap = { ...f.mindmap, kind: 'outline' }
      expectCode(() => deriveKnowledgePracticeLinks({ mindmap, quiz }), 'invalid_artifact')
    })
  it('rejects repeated evidence IDs and unsupported inference/external citations', () => {
    let f = fixture()
    f.quiz.payload.questions[0].evidenceIds.push('claim-energy')
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }), 'duplicate_evidence')
    for (const citation of [{ version: 1 as const, provenance: 'inference' as const, label: '猜测' },
      { version: 1 as const, provenance: 'external' as const, externalSourceId: 'website' }]) {
      f = fixture()
      f.quiz.payload.questions[0].citations = [citation]
      expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }), 'unsupported_citation')
    }
  })
  it('links only existing IDs after nodes are reordered or moved, and never recreates a removed node', () => {
    const f = fixture()
    f.mindmap.payload.nodes[2].parentId = 'energy'
    f.mindmap.payload.nodes.reverse()
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links.map((link) => link.nodeId)).toEqual(['other', 'energy'])
    f.mindmap.payload.nodes = f.mindmap.payload.nodes.filter((node) => node.id !== 'other')
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links.map((link) => link.nodeId)).toEqual(['energy'])
  })
  it('returns no automatic relationship when evidence IDs do not intersect', () => {
    const f = fixture()
    f.quiz.payload.questions = [f.quiz.payload.questions[2]]
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links).toEqual([])
  })
})

describe('optional verified Graph authority and bounds', () => {
  it('checks the same run and graph-backed citations when authority is supplied', () => {
    const f = fixture()
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }).links).toHaveLength(2)
    f.graph.runId = 'different-run'
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }), 'identity_mismatch')
  })
  it('rejects unknown Graph evidence instead of treating the union of Artifact IDs as authority', () => {
    const f = fixture()
    f.mindmap.payload.nodes[1].evidenceIds = ['unknown-claim']
    f.quiz.payload.questions[0].evidenceIds = ['unknown-claim']
    // Without Graph, source/task validation is the caller's prerequisite, not a
    // proof manufactured by collecting IDs from these two inputs.
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }).links.some((link) => link.nodeId === 'energy')).toBe(true)
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }), 'unknown_evidence')
  })
  it('rejects citations unsupported by the entry evidence IDs even when the source appears elsewhere in Graph', () => {
    const f = fixture()
    f.quiz.payload.questions[0].citations = [nextCitation]
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }), 'unsupported_citation')
  })
  it('does not link common citation support that belongs only to unrelated evidence IDs', () => {
    const f = fixture()
    f.mindmap.payload.nodes[1].evidenceIds = ['claim-energy', 'claim-other']
    f.mindmap.payload.nodes[1].citations = [nextCitation]
    f.quiz.payload.questions[0].evidenceIds = ['claim-energy', 'claim-other']
    f.quiz.payload.questions[0].citations = [nextCitation]
    // Remove the evidence that actually supports the common citation from the
    // question intersection while preserving validity of each complete entry.
    f.graph.claims.push({ id: 'claim-different', kind: 'fact', statement: '知识事实', conceptIds: [], citations: [nextCitation] })
    f.quiz.payload.questions[0].evidenceIds = ['claim-energy', 'claim-different']
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }).links
      .some((link) => link.nodeId === 'energy' && link.questionId === 'question-energy')).toBe(false)
  })
  it('allows explicit learning-objective support inherited from its existing evidence', () => {
    const f = fixture()
    f.mindmap.payload.nodes[1].evidenceIds = ['objective-energy']
    f.quiz.payload.questions[0].evidenceIds = ['objective-energy']
    expect(deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }).links[0].sharedEvidenceIds)
      .toEqual(['objective-energy'])
  })
  it('rejects globally duplicated Graph IDs and unknown objective dependencies', () => {
    const f = fixture()
    f.graph.terms = [{ id: 'claim-energy', term: '知识', citations: [citation] }]
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }), 'invalid_graph')
    f.graph.terms = []
    f.graph.learningObjectives[0].evidenceIds = ['missing']
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz, verifiedGraph: f.graph }), 'invalid_graph')
  })
  it('rejects JSON prototype keys, cycles and getters without executing untrusted accessors', () => {
    const f = fixture()
    const prototype = JSON.parse(JSON.stringify(f.mindmap).replace('"payload":{', '"payload":{"__proto__":{},'))
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: prototype, quiz: f.quiz }), 'invalid_artifact')
    let invoked = false
    const accessor = { ...f.mindmap, get payload() { invoked = true; return f.mindmap.payload } }
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: accessor, quiz: f.quiz }), 'invalid_artifact')
    expect(invoked).toBe(false)
    const cyclic = { ...f.mindmap } as Record<string, unknown>
    cyclic.payload = cyclic
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: cyclic, quiz: f.quiz }), 'invalid_artifact')
  })
  it('fails dense output atomically instead of returning a truncated selection', () => {
    const f = fixture()
    const template = f.mindmap.payload.nodes[1]
    f.mindmap.payload.nodes = [f.mindmap.payload.nodes[0], ...Array.from({ length: 101 }, (_, index) => ({
      ...template, id: `node-${index}`,
    }))]
    const question = f.quiz.payload.questions[0]
    f.quiz.payload.questions = Array.from({ length: 100 }, (_, index) => ({ ...question, id: `question-${index}` }))
    expectCode(() => deriveKnowledgePracticeLinks({ mindmap: f.mindmap, quiz: f.quiz }), 'capacity_exceeded')
  })
})
