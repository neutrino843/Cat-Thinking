import { describe, expect, it } from 'vitest'
import requestFixture from '../fixtures/analysis-request.valid.json'
import {
  analysisRequestSchema,
  analysisRunSchema,
  artifactEnvelopeSchema,
  collectArtifactCitations,
  coverageSchema,
  evidenceCardSchema,
  knowledgeArtifactEnvelopeSchema,
  mindMapArtifactEnvelopeSchema,
  outlineArtifactEnvelopeSchema,
  quizArtifactEnvelopeSchema,
  sourceManifestSchema,
  sourceReceiptSchema,
  uploadSourcePartSchema,
  validateArtifactAgainstManifest,
  validateMindMapGraph,
  validateOutlineGraph,
  type CitationV1,
  type OutlineNodeV1,
} from '../src'

const sourceCitation: CitationV1 = {
  version: 1,
  provenance: 'source',
  sourceId: 'source-photosynthesis',
  start: 10,
  end: 20,
  page: 1,
}

const envelopeBase = {
  version: 1,
  schemaVersion: 1,
  runId: 'run-1',
  docId: 'doc-foundations',
  sourceContentHashes: ['a'.repeat(64)],
  createdAt: 1791500000000,
  updatedAt: 1791500001000,
}

describe('all artifact contracts', () => {
  it('decodes a recursive outline and collects nested citations', () => {
    const artifact = outlineArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-outline',
      kind: 'outline',
      payload: {
        title: '光合作用',
        nodes: [
          {
            id: 'outline-root',
            title: '过程',
            evidenceIds: ['evidence-1'],
            citations: [sourceCitation],
            children: [
              {
                id: 'outline-child',
                title: '光反应',
                summary: '产生 ATP 与 NADPH',
                evidenceIds: ['evidence-2'],
                citations: [sourceCitation],
                children: [],
              },
            ],
          },
        ],
      },
    })

    expect(collectArtifactCitations(artifact)).toHaveLength(2)
  })

  it('reports duplicate outline ids and excessive depth', () => {
    let child: OutlineNodeV1 = {
      id: 'outline-34',
      title: 'deep node',
      evidenceIds: [] as string[],
      citations: [] as CitationV1[],
      children: [],
    }
    for (let index = 33; index >= 0; index -= 1) {
      child = {
        id: index === 0 ? 'outline-34' : `outline-${index}`,
        title: `node ${index}`,
        evidenceIds: [],
        citations: [],
        children: [child],
      }
    }
    const artifact = outlineArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-outline-invalid',
      kind: 'outline',
      payload: { title: 'deep outline', nodes: [child] },
    })
    const issues = validateOutlineGraph(artifact.payload)

    expect(issues.some((issue) => issue.message === 'outline node ids must be unique')).toBe(true)
    expect(issues.some((issue) => issue.message === 'outline depth exceeds 32')).toBe(true)
  })

  it('decodes every quiz shape and rejects duplicate ids and options', () => {
    const valid = quizArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-quiz',
      kind: 'quiz',
      payload: {
        title: '测验',
        questions: [
          {
            id: 'q-mc',
            type: 'multiple-choice',
            prompt: '主要场所？',
            options: ['叶绿体', '线粒体'],
            answerIndex: 0,
            explanation: '原文明确说明。',
            difficulty: 'easy',
            evidenceIds: ['evidence-1'],
            citations: [sourceCitation],
          },
          {
            id: 'q-tf',
            type: 'true-false',
            prompt: '光反应产生 ATP。',
            answer: true,
            explanation: '正确。',
            difficulty: 'medium',
            evidenceIds: ['evidence-2'],
            citations: [sourceCitation],
          },
          {
            id: 'q-short',
            type: 'short-answer',
            prompt: '说明两个阶段的关系。',
            answer: '光反应为碳反应提供能量和还原力。',
            rubric: ['提到 ATP', '提到 NADPH'],
            explanation: '按证据给分。',
            difficulty: 'hard',
            evidenceIds: ['evidence-3'],
            citations: [sourceCitation],
          },
        ],
      },
    })
    const duplicatedId = {
      ...valid,
      payload: { ...valid.payload, questions: [valid.payload.questions[0], valid.payload.questions[0]] },
    }
    const duplicatedOption = {
      ...valid,
      payload: {
        ...valid.payload,
        questions: [{ ...valid.payload.questions[0], options: ['相同', ' 相同 '] }],
      },
    }

    expect(collectArtifactCitations(valid)).toHaveLength(3)
    expect(quizArtifactEnvelopeSchema.safeParse(duplicatedId).success).toBe(false)
    expect(quizArtifactEnvelopeSchema.safeParse(duplicatedOption).success).toBe(false)
  })

  it('requires knowledge provenance to match one citation', () => {
    const source = knowledgeArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-knowledge',
      kind: 'knowledge',
      payload: {
        items: [
          {
            id: 'knowledge-1',
            title: '来源知识',
            explanation: '由原文直接支持。',
            relationship: 'extension',
            provenance: 'source',
            evidenceIds: ['evidence-1'],
            citations: [sourceCitation],
          },
          {
            id: 'knowledge-2',
            title: '推断',
            explanation: '根据来源推断。',
            relationship: 'application',
            provenance: 'inference',
            evidenceIds: [],
            citations: [{ version: 1, provenance: 'inference', label: '教学推断' }],
          },
          {
            id: 'knowledge-3',
            title: '外部知识',
            explanation: '来自受控外部来源。',
            relationship: 'analogy',
            provenance: 'external',
            evidenceIds: [],
            citations: [
              { version: 1, provenance: 'external', externalSourceId: 'external-1', label: '资料一' },
            ],
          },
        ],
      },
    })
    const mismatch = {
      ...source,
      payload: { items: [{ ...source.payload.items[0], provenance: 'external' }] },
    }

    expect(collectArtifactCitations(source)).toHaveLength(3)
    expect(knowledgeArtifactEnvelopeSchema.safeParse(mismatch).success).toBe(false)
  })

  it('decodes a valid map and reports orphan relations and excessive depth', () => {
    const nodes = Array.from({ length: 35 }, (_, index) => ({
      id: `node-${index}`,
      parentId: index === 0 ? null : `node-${index - 1}`,
      text: `节点 ${index}`,
      evidenceIds: [],
      citations: index === 0 ? [sourceCitation] : [],
    }))
    const artifact = mindMapArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-map',
      kind: 'mindmap',
      payload: {
        title: '导图',
        nodes,
        relations: [
          {
            id: 'relation-1',
            from: 'node-0',
            to: 'missing-node',
            evidenceIds: [],
            citations: [sourceCitation],
          },
        ],
      },
    })
    const issues = validateMindMapGraph(artifact.payload)

    expect(collectArtifactCitations(artifact)).toHaveLength(2)
    expect(issues.some((issue) => issue.message === 'relation endpoint does not exist')).toBe(true)
    expect(issues.some((issue) => issue.code === 'limit_exceeded')).toBe(true)
  })

  it('rejects duplicate map node and relation ids', () => {
    const result = mindMapArtifactEnvelopeSchema.safeParse({
      ...envelopeBase,
      id: 'artifact-map-duplicate',
      kind: 'mindmap',
      payload: {
        title: '导图',
        nodes: [
          { id: 'node-1', parentId: null, text: '根', evidenceIds: [], citations: [] },
          { id: 'node-1', parentId: null, text: '重复', evidenceIds: [], citations: [] },
        ],
        relations: [
          { id: 'relation-1', from: 'node-1', to: 'node-1', evidenceIds: [], citations: [] },
          { id: 'relation-1', from: 'node-1', to: 'node-1', evidenceIds: [], citations: [] },
        ],
      },
    })

    expect(result.success).toBe(false)
  })

  it('keeps the union strict for unsupported kinds', () => {
    expect(
      artifactEnvelopeSchema.safeParse({ ...envelopeBase, id: 'artifact-raw', kind: 'raw', payload: {} }).success,
    ).toBe(false)
  })
})

describe('evidence, source, run and cross-entity semantics', () => {
  it('validates evidence ids and rejects duplicates across evidence categories', () => {
    const base = {
      version: 1,
      chunkId: 'chunk-1',
      chunkHash: 'b'.repeat(64),
      sourceId: 'source-photosynthesis',
      titlePath: ['光合作用'],
      claims: [
        {
          id: 'evidence-1',
          kind: 'fact',
          statement: '叶绿体是主要场所。',
          conceptIds: ['concept-1'],
          citations: [sourceCitation],
        },
      ],
      terms: [
        {
          id: 'term-1',
          term: '叶绿体',
          definition: '细胞器',
          citations: [sourceCitation],
        },
      ],
      learningObjectives: [
        { id: 'objective-1', text: '解释光合作用场所', evidenceIds: ['evidence-1'] },
      ],
    }

    expect(evidenceCardSchema.safeParse(base).success).toBe(true)
    expect(
      evidenceCardSchema.safeParse({
        ...base,
        terms: [{ ...base.terms[0], id: 'evidence-1' }],
      }).success,
    ).toBe(false)
  })

  it('rejects malformed source manifests, upload parts and receipts', () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const duplicateManifest = {
      ...request.manifest,
      sources: [request.manifest.sources[0], request.manifest.sources[0]],
    }
    const invalidSelectedRange = {
      ...request.manifest.sources[0],
      selectedRange: { start: 0, end: 1201 },
    }
    const pdfWithoutPages = { ...request.manifest.sources[0], pageCount: undefined }

    expect(sourceManifestSchema.safeParse(duplicateManifest).success).toBe(false)
    expect(sourceManifestSchema.safeParse({ version: 1, sources: [invalidSelectedRange] }).success).toBe(false)
    expect(sourceManifestSchema.safeParse({ version: 1, sources: [pdfWithoutPages] }).success).toBe(false)
    expect(
      uploadSourcePartSchema.safeParse({
        version: 1,
        sourceId: 'source-1',
        contentHash: 'a'.repeat(64),
        partHash: 'b'.repeat(64),
        partIndex: 2,
        partCount: 2,
        start: 5,
        end: 3,
        totalChars: 4,
        text: 'bad',
      }).success,
    ).toBe(false)
    expect(
      sourceReceiptSchema.safeParse({
        version: 1,
        sourceId: 'source-1',
        receivedParts: 3,
        partCount: 2,
        complete: true,
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate requested artifacts and inconsistent run state', () => {
    const request = analysisRequestSchema.parse(requestFixture)
    expect(analysisRequestSchema.safeParse({ ...request, artifacts: ['summary', 'summary'] }).success).toBe(false)
    expect(
      coverageSchema.safeParse({
        input: 1,
        analysis: 0.5,
        chunksCompleted: 2,
        chunksFailed: 1,
        chunksTotal: 2,
      }).success,
    ).toBe(false)

    const artifactState = { status: 'pending', attempt: 0, updatedAt: 1791500000000 }
    const run = {
      version: 1,
      id: 'run-1',
      docId: request.docId,
      requestKey: request.requestKey,
      request,
      revision: 1,
      status: 'accepted',
      progress: 0,
      coverage: {
        input: 0,
        analysis: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksTotal: 0,
      },
      providerRoutes: [],
      artifactStates: {
        summary: artifactState,
        outline: artifactState,
        mindmap: artifactState,
        quiz: artifactState,
        knowledge: artifactState,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicros: 0,
        currency: 'CNY',
      },
      createdAt: 1791500000000,
      updatedAt: 1791500000000,
    }

    expect(analysisRunSchema.safeParse(run).success).toBe(true)
    expect(analysisRunSchema.safeParse({ ...run, docId: 'different-doc' }).success).toBe(false)
    expect(
      analysisRunSchema.safeParse({
        ...run,
        artifactStates: { ...run.artifactStates, knowledge: undefined },
      }).success,
    ).toBe(false)
  })

  it('reports missing sources and invalid pages for every artifact citation', () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const artifact = outlineArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-outline-invalid-citation',
      kind: 'outline',
      payload: {
        title: '大纲',
        nodes: [
          {
            id: 'outline-1',
            title: '节点',
            evidenceIds: [],
            citations: [
              { ...sourceCitation, sourceId: 'missing-source' },
              { ...sourceCitation, page: 99 },
              { version: 1, provenance: 'inference', label: '推断' },
            ],
            children: [],
          },
        ],
      },
    })
    const issues = validateArtifactAgainstManifest(artifact, request.manifest)

    expect(issues.some((issue) => issue.code === 'source_missing')).toBe(true)
    expect(issues.some((issue) => issue.code === 'page_invalid')).toBe(true)
  })

  it('reports missing map parents through the manifest validator', () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const artifact = mindMapArtifactEnvelopeSchema.parse({
      ...envelopeBase,
      id: 'artifact-map-orphan',
      kind: 'mindmap',
      payload: {
        title: '导图',
        nodes: [
          { id: 'root', parentId: null, text: '根', evidenceIds: [], citations: [] },
          { id: 'orphan', parentId: 'missing', text: '孤儿', evidenceIds: [], citations: [] },
        ],
        relations: [],
      },
    })

    expect(
      validateArtifactAgainstManifest(artifact, request.manifest).some(
        (issue) => issue.message === 'parent missing does not exist',
      ),
    ).toBe(true)
  })
})
