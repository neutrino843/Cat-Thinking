import { createHash } from 'node:crypto'
import { analysisRequestSchema, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import type { JobStore } from '../../src/domain/jobStore.js'
import { RunService } from '../../src/domain/runService.js'
import type { ModelProvider, ModelRequest, ModelTaskRole } from '../../src/providers/modelProvider.js'
import { encodeFixtureArtifactOutput, type FixtureCitation, type FixtureOutline, type FixtureOutlineNode } from './artifactReferenceFixture.js'

// Synthetic, public-domain fixture. Never load customer content or credentials here.
export const FIXTURE_TENANT = 'synthetic-tenant'
export const FIXTURE_TEXT = 'Photosynthesis converts light into stored chemical energy.'
export const fixtureHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const fixtureRequest = (key: string, artifacts: readonly ArtifactKind[] = ['summary', 'outline', 'mindmap', 'quiz', 'knowledge'], quizQuestionCount = 1) => analysisRequestSchema.parse({
  version: 1, requestKey: fixtureHash(key), docId: 'synthetic-document',
  manifest: { version: 1, sources: [{ version: 1, sourceId: 'synthetic-source', kind: 'text', extractor: 'synthetic-v1',
    contentHash: fixtureHash(FIXTURE_TEXT), charCount: FIXTURE_TEXT.length, byteCount: FIXTURE_TEXT.length }] },
  artifacts, options: { locale: 'en-US', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount, externalKnowledge: false },
})
export const prepareFixtureRun = async (store: JobStore, key: string, now: () => number = Date.now, artifacts?: readonly ArtifactKind[], quizQuestionCount = 1) => {
  const service = new RunService({ store, retentionSeconds: 3600, now })
  const created = await service.createRun(FIXTURE_TENANT, fixtureRequest(key, artifacts, quizQuestionCount))
  await service.uploadSource(FIXTURE_TENANT, created.run.id, {
    version: 1, sourceId: 'synthetic-source', contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT),
    partIndex: 0, partCount: 1, start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT,
  })
  await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
  return { service, runId: created.run.id }
}

export class FakeAnalysisProvider implements ModelProvider {
  readonly id = 'synthetic-provider'
  readonly modelId = 'synthetic-model'
  readonly profileVersion = 'synthetic-v1'
  readonly capabilities = { apiStyle: 'responses' as const, structuredOutputs: true as const, reportsUsage: true as const,
    supportsAbort: true as const, maxInputCharacters: 1_000_000, maxOutputTokens: 32_000 }
  readonly calls: ModelRequest[] = []
  override?: (request: ModelRequest, signal: AbortSignal) => Promise<string> | string
  isReady() { return true }
  async generate(request: ModelRequest, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason
    this.calls.push(request)
    const outputText = this.override ? await this.override(request, signal) : this.output(request)
    return { outputText, usage: { inputTokens: 20, outputTokens: 10 } }
  }
  output(request: ModelRequest): string {
    if (request.role === 'repair') {
      const repair = JSON.parse(request.userPrompt) as { task: string; original?: string; originalInput?: string }
      const roles: Readonly<Record<string, ModelTaskRole>> = { 'evidence-map': 'evidence-map',
        summary: 'artifact-summary', outline: 'artifact-outline', mindmap: 'artifact-mindmap',
        quiz: 'artifact-quiz', knowledge: 'artifact-knowledge' }
      const role = roles[repair.task]
      if (!role) throw new Error('unsupported synthetic repair task')
      const original = repair.originalInput ?? repair.original
      if (!original) throw new Error('synthetic repair requires its original input')
      return this.output({ ...request, role, userPrompt: original })
    }
    if (request.role === 'evidence-map') {
      if (request.output.name === 'evidence_map_v3') {
        const envelope = JSON.parse(request.userPrompt.slice(request.userPrompt.indexOf('\n') + 1)) as {
          excerpts: { excerptId: string; text: string }[] }
        const excerpt = envelope.excerpts[0]
        if (!excerpt) throw new Error('synthetic fixture requires a provided excerpt')
        return JSON.stringify({ claims: [{ id: 'claim-1', kind: 'fact', statement: excerpt.text,
          conceptIds: [], citations: [{ excerptId: excerpt.excerptId }] }], terms: [], learningObjectives: [] })
      }
      if (request.output.name === 'evidence_map_v2') {
        const envelope = JSON.parse(request.userPrompt.slice(request.userPrompt.indexOf('\n') + 1)) as { sourceText: string }
        const quote = envelope.sourceText.slice(0, 100)
        return JSON.stringify({ claims: [{ id: 'claim-1', kind: 'fact', statement: quote,
          conceptIds: [], citations: [{ quote, prefix: '', suffix: envelope.sourceText.slice(quote.length, quote.length + 100) }] }], terms: [], learningObjectives: [] })
      }
      const citation = { start: 0, end: FIXTURE_TEXT.length }
      return JSON.stringify({ claims: [{ id: 'claim-1', kind: 'fact', statement: FIXTURE_TEXT, conceptIds: [], citations: [citation] }], terms: [], learningObjectives: [] })
    }
    if (!request.role.startsWith('artifact-')) throw new Error('unsupported synthetic provider role')
    const data = JSON.parse(request.userPrompt) as { evidence: { claims: { id: string; citations: FixtureCitation[] }[] }; outline?: FixtureOutline;
      options?: { quizQuestionCount?: number } }
    const claim = data.evidence.claims[0]
    if (!claim) throw new Error('synthetic fixture requires one claim')
    const grounded = { evidenceIds: [claim.id], citations: claim.citations }
    const entry = { id: 'grounded-text', text: FIXTURE_TEXT, ...grounded }
    const mappedNodes: { id: string; parentId: string; text: string; evidenceIds: string[]; citations: FixtureCitation[] }[] = []
    const mapOutline = (nodes: FixtureOutlineNode[], parentId: string) => {
      for (const node of nodes) {
        mappedNodes.push({ id: node.id, parentId, text: node.title, evidenceIds: node.evidenceIds, citations: node.citations })
        mapOutline(node.children, node.id)
      }
    }
    if (data.outline) mapOutline(data.outline.nodes, 'map-root')
    const questionCount = data.options?.quizQuestionCount ?? 1
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 100) throw new Error('invalid synthetic quiz count')
    const questions = Array.from({ length: questionCount }, (_unused, index) => {
      const base = { id: `question-${index + 1}`, prompt: FIXTURE_TEXT, explanation: FIXTURE_TEXT, difficulty: 'easy', ...grounded }
      if (index % 3 === 0) return { ...base, type: 'true-false', answer: true }
      if (index % 3 === 1) return { ...base, type: 'multiple-choice', options: ['Light energy conversion', 'No energy conversion'], answerIndex: 0 }
      return { ...base, type: 'short-answer', answer: FIXTURE_TEXT, rubric: ['Mentions light energy and stored chemical energy'] }
    })
    const payloads = {
      summary: { overview: entry, keyPoints: [{ ...entry, id: 'key-point' }], confusions: [] },
      outline: { title: 'Photosynthesis', nodes: [{ id: 'root', title: 'Energy conversion', ...grounded, children: [] }] },
      mindmap: { title: 'Photosynthesis', nodes: data.outline
        ? [{ id: 'map-root', parentId: null, text: data.outline.title, ...grounded }, ...mappedNodes]
        : [{ id: 'root', parentId: null, text: 'Energy conversion', ...grounded }], relations: [] },
      quiz: { title: 'Photosynthesis', questions },
      knowledge: { items: [{ id: 'knowledge-1', title: 'Energy', explanation: FIXTURE_TEXT, relationship: 'application', provenance: 'source', ...grounded }] },
    }
    const kind = request.role.replace('artifact-', '') as ArtifactKind
    if (!Object.hasOwn(payloads, kind)) throw new Error('unsupported synthetic artifact role')
    return encodeFixtureArtifactOutput(request, kind, payloads[kind])
  }
}
