import type { ArtifactKind } from '@cat-thinking/analysis-contracts'
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/providers/modelProvider.js'
import { ProviderGatewayError } from '../../src/providers/providerError.js'
import { encodeFixtureArtifactOutput, fixtureInferenceCitation, type FixtureCitation, type FixtureOutline, type FixtureOutlineNode } from './artifactReferenceFixture.js'

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** No network transport. Exists only in the separate test build. */
export class BrowserSyntheticProvider implements ModelProvider {
  readonly id = 'synthetic-browser-provider'
  readonly modelId = 'synthetic-browser-model'
  readonly profileVersion = 'synthetic-browser-v1'
  readonly capabilities = { apiStyle: 'responses' as const, structuredOutputs: true as const, reportsUsage: true as const,
    supportsAbort: true as const, maxInputCharacters: 1_000_000, maxOutputTokens: 32_000 }
  private readonly failedPartial = new Set<string>()
  isReady() { return true }
  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    signal.throwIfAborted()
    let prompt = request.userPrompt
    if (request.role === 'repair') {
      const variables = JSON.parse(prompt) as { original?: string; originalInput?: string }
      prompt = variables.originalInput ?? variables.original ?? ''
    }
    if (request.role === 'evidence-map' || request.role === 'repair' && prompt.startsWith('Map the following immutable chunk envelope')) {
      const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { sourceText?: string; range?: { start: number; end: number };
        excerpts?: { excerptId: string; text: string }[] }
      const sourceText = data.sourceText ?? data.excerpts?.map((excerpt) => excerpt.text).join('') ?? ''
      const end = sourceText.includes('fixture hierarchy') ? sourceText.length : Math.min(sourceText.length, 100)
      const quote = sourceText.slice(0, end)
      const invalid = sourceText.includes('fixture invalid evidence')
      if (request.output.name === 'evidence_map_v3') {
        const excerpts = data.excerpts?.filter((excerpt) => excerpt.text.trim()).slice(0, 24) ?? []
        await wait(150, signal)
        return { outputText: JSON.stringify({ claims: excerpts.map((excerpt, index) => ({
          id: `synthetic-claim-${index + 1}`, kind: 'fact', statement: excerpt.text.trim(), conceptIds: [],
          citations: [{ excerptId: invalid ? 'excerpt-not-provided' : excerpt.excerptId }],
        })), terms: [], learningObjectives: [] }), usage: { inputTokens: 20, outputTokens: 10 } }
      }
      const citations = request.output.name === 'evidence_map_v2'
          ? [{ quote: invalid ? 'Missing synthetic quote not present in source.' : quote,
            prefix: '', suffix: invalid ? '' : sourceText.slice(quote.length, quote.length + 100) }]
          : [{ start: data.range?.start, end: (data.range?.start ?? 0) + end }]
      await wait(150, signal)
      return { outputText: JSON.stringify({ claims: [{ id: 'synthetic-claim', kind: 'fact', statement: quote, conceptIds: [], citations }], terms: [], learningObjectives: [] }), usage: { inputTokens: 20, outputTokens: 10 } }
    }
    const data = JSON.parse(prompt) as { kind: ArtifactKind; options: { quizQuestionCount: number }; outline?: FixtureOutline;
      referenceCatalog?: unknown[];
      evidence: { claims: { id: string; statement: string; citations: FixtureCitation[] }[] } }
    if (request.role !== 'repair' && request.role !== `artifact-${data.kind}`) throw new Error('Unsupported synthetic artifact role')
    const scenario = data.evidence.claims.map((item) => item.statement).join('\n')
    const claim = data.evidence.claims.find((item) => item.statement.includes('Photosynthesis')) ?? data.evidence.claims[0]
    if (!claim) throw new Error('Synthetic evidence missing')
    await wait(scenario.includes('fixture slow') || scenario.includes('fixture unknown') ? 4_000 : 250, signal)
    // Compact IDs are local to a prompt: cite-1 in a different document is not the same source.
    const sourceIdentity = JSON.stringify(data.referenceCatalog ?? claim.citations)
    if (request.role === 'artifact-outline' && scenario.includes('fixture truncated outline')) {
      throw new ProviderGatewayError({ providerId: this.id, kind: 'rejected', retryable: false,
        acceptance: 'accepted', safeCode: 'finish_not_complete',
        usage: { inputTokens: 20, outputTokens: request.maxOutputTokens } })
    }
    if (request.role === 'artifact-outline' && scenario.includes('fixture partial') && !this.failedPartial.has(sourceIdentity)) {
      this.failedPartial.add(sourceIdentity)
      throw new ProviderGatewayError({ providerId: this.id, kind: 'unavailable', retryable: true, acceptance: 'not_accepted', safeCode: 'synthetic_partial_failure' })
    }
    const relatedClaims = scenario.includes('fixture hierarchy')
      ? data.evidence.claims.filter((item) => /Photosynthesis|Light reactions|Calvin cycle/u.test(item.statement)) : [claim]
    const support = relatedClaims.length ? relatedClaims : [claim]
    const grounded = { evidenceIds: support.map((item) => item.id), citations: support.flatMap((item) => item.citations) }
    const payload = (() => {
      switch (data.kind) {
        case 'summary': return { overview: { id: 'synthetic-overview', text: '合成摘要：' + claim.statement, ...grounded }, keyPoints: [{ id: 'synthetic-point', text: '合成要点：光能转化为化学能。', ...grounded }], confusions: [] }
        case 'outline': return scenario.includes('fixture hierarchy') ? { title: '光合作用知识结构', nodes: [
          { id: 'photosynthesis', title: '光合作用', ...grounded, children: [
            { id: 'light-stage', title: '光反应', ...grounded, children: [
              { id: 'carriers', title: 'ATP 和 NADPH', ...grounded, children: [] },
            ] },
            { id: 'fixation', title: '卡尔文循环', ...grounded, children: [
              { id: 'sugars', title: '固定二氧化碳并合成糖', ...grounded, children: [] },
            ] },
          ] },
        ] } : { title: '合成大纲：光合作用', nodes: [{ id: 'synthetic-energy', title: '能量转换', summary: claim.statement, ...grounded, children: [] }] }
        case 'mindmap': {
          if (scenario.includes('fixture hierarchy') && data.outline) {
            const nodes: { id: string; parentId: string; text: string; evidenceIds: string[]; citations: FixtureCitation[] }[] = []
            const collect = (items: FixtureOutlineNode[]) => { for (const node of items) {
              // Intentionally flattened: the adapter must restore the authoritative outline.
              nodes.push({ id: node.id, parentId: 'synthetic-root', text: node.title, evidenceIds: node.evidenceIds, citations: node.citations })
              collect(node.children)
            } }
            collect(data.outline.nodes)
            return { title: data.outline.title, nodes: [{ id: 'synthetic-root', parentId: null, text: data.outline.title, ...grounded }, ...nodes],
              relations: [{ id: 'energy-for-fixation', from: 'light-stage', to: 'fixation', label: '提供 ATP 和 NADPH', ...grounded }] }
          }
          return { title: '合成导图：光合作用', nodes: [
          { id: 'synthetic-root', parentId: null, text: '光合作用', ...grounded },
          { id: 'synthetic-energy', parentId: 'synthetic-root', text: '能量转换', note: '光能转化为化学能。' + claim.statement, ...grounded },
          ], relations: [{ id: 'synthetic-relation', from: 'synthetic-root', to: 'synthetic-energy', label: '能量转换', ...grounded }] }
        }
        case 'quiz': return { title: '合成测验：光合作用', questions: Array.from({ length: data.options.quizQuestionCount }, (_, index) => {
          const base = { id: `synthetic-question-${index + 1}`, prompt: `第 ${index + 1} 题：光合作用的能量转换`, explanation: '光能转化为化学能。', difficulty: 'easy' as const, ...grounded }
          if (index % 3 === 0) return { ...base, type: 'multiple-choice', options: ['光能转化为化学能', '化学能转化为声能'], answerIndex: 0 }
          if (index % 3 === 1) return { ...base, type: 'true-false', prompt: `第 ${index + 1} 题：光合作用将光能转化为化学能。`, answer: true }
          return { ...base, type: 'short-answer', answer: '光能转化为化学能。', rubric: ['指出光能是输入', '指出化学能是输出'] }
        }) }
        case 'knowledge': return { items: [
          { id: 'synthetic-source-knowledge', title: '原文知识：能量转换', explanation: claim.statement, relationship: 'prerequisite', provenance: 'source', ...grounded },
          { id: 'synthetic-inference-knowledge', title: '推断：从能量流向理解过程', explanation: '依据原文的能量转换，可以用能量流向整理学习步骤。', relationship: 'application', provenance: 'inference', evidenceIds: [claim.id], citations: [...claim.citations, fixtureInferenceCitation(request, data.kind, '基于能量转换证据的学习推断')] },
        ] }
        default: throw new Error('Unsupported synthetic artifact role')
      }
    })()
    return { outputText: encodeFixtureArtifactOutput(request, data.kind, payload), usage: { inputTokens: 20, outputTokens: 10 } }
  }
}
