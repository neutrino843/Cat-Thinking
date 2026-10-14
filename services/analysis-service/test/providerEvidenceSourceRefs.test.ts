import { createHash } from 'node:crypto'
import { analysisRequestSchema, type EvidenceChunkV1 } from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { planEvidenceChunks } from '../src/domain/chunkPlanner.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION } from '../src/providers/evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION } from '../src/providers/evidenceRepairPrompt.js'
import { createEvidenceSourceExcerpts, EvidenceExcerptResolutionError, MAX_EVIDENCE_EXCERPTS,
  MAX_EVIDENCE_EXCERPT_CHARACTERS, MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS,
  resolveEvidenceSourceExcerpt } from '../src/providers/evidenceSourceExcerpts.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/providers/modelProvider.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'

const tenantId = 'public-source-ref-tenant'
const sourceId = 'public-source-ref-source'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceInput = (text: string, start = 0) => ({ tenantId, runId: 'public-source-ref-run', docId: 'public-source-ref-doc',
  locale: 'zh-CN', qualityProfile: 'standard' as const, text,
  chunk: { version: 1 as const, chunkId: 'public-source-ref-chunk', chunkHash: hash(text), sourceId, start, end: start + text.length,
    titlePath: [], estimatedTokens: text.length, ordinal: 0, total: 1, overlapBefore: 0, overlapAfter: 0 } })

const refOutput = (excerptId: string) => JSON.stringify({
  claims: [{ id: 'claim', kind: 'fact', statement: 'A public source fact.', conceptIds: ['term'], citations: [{ excerptId }] }],
  terms: [{ id: 'term', term: 'public concept', citations: [{ excerptId }] }],
  learningObjectives: [{ id: 'objective', text: 'Understand the public fact.', evidenceIds: ['claim', 'term'] }],
})
const response = (outputText: string, outputTokens = 20): ModelResponse => ({ outputText, usage: { inputTokens: 30, outputTokens } })
const inputEnvelope = (request: ModelRequest) => {
  const original = request.role === 'repair' ? JSON.parse(request.userPrompt).originalInput as string : request.userPrompt
  return JSON.parse(original.slice(original.indexOf('\n') + 1)) as { excerpts: { excerptId: string; text: string }[] }
}
class RefFake implements ModelProvider {
  readonly id = 'source-ref-fake-provider'
  readonly modelId = 'source-ref-fake-model'
  readonly profileVersion = 'source-ref-fake-profile'
  readonly capabilities = { apiStyle: 'responses' as const, structuredOutputs: true as const, reportsUsage: true as const,
    supportsAbort: true as const, maxInputCharacters: 100_000, maxOutputTokens: 8192 }
  readonly calls: ModelRequest[] = []
  constructor(readonly respond: (request: ModelRequest, call: number) => ModelResponse | never) {}
  isReady() { return true }
  async generate(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted()
    this.calls.push(request)
    return this.respond(request, this.calls.length)
  }
}
const prepare = async (text: string, respond: RefFake['respond'], selectedRange?: { start: number; end: number }) => {
  const store = new InMemoryJobStore()
  const service = new RunService({ store, retentionSeconds: 3600 })
  const created = await service.createRun(tenantId, analysisRequestSchema.parse({
    version: 1, requestKey: hash(text), docId: 'public-source-ref-doc',
    manifest: { version: 1, sources: [{ version: 1, sourceId, kind: 'text', extractor: 'public-fixture-v1', pageCount: 2,
      contentHash: hash(text), charCount: text.length, byteCount: new TextEncoder().encode(text).byteLength,
      ...(selectedRange ? { selectedRange } : {}),
      locators: [{ start: 0, end: Math.ceil(text.length / 2), page: 1, titlePath: ['Public first page'] },
        { start: Math.ceil(text.length / 2), end: text.length, page: 2, titlePath: ['Public second page'] }] }] },
    artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard',
      quizQuestionCount: 1, externalKnowledge: false },
  }))
  await service.uploadSource(tenantId, created.run.id, { version: 1, sourceId, contentHash: hash(text), partHash: hash(text),
    partIndex: 0, partCount: 1, start: 0, end: text.length, totalChars: text.length, text })
  await service.startRun(tenantId, created.run.id, created.run.revision)
  const provider = new RefFake(respond)
  const runtime = () => createAnalysisProviderRuntime({ store, provider, broker: service.broker, leaseMs: 1000,
    estimateCostMicros: () => 1 })
  const run = () => runtime().evidence.runOnce(tenantId, created.run.id, 'source-ref-worker', new AbortController().signal)
  const route = (promptVersion: string) => ({ providerId: provider.id, modelId: provider.modelId, profileVersion: provider.profileVersion, promptVersion })
  const persistRoutes = async (versions: string[]) => {
    const current = (await store.getRun(tenantId, created.run.id))!
    await store.transitionRun(tenantId, created.run.id, current.revision, (run, sequence) => ({ run: {
      ...run, revision: run.revision + 1, status: 'mapping', stage: 'mapping', providerRoutes: versions.map(route),
    }, event: { version: 1, type: 'stage.started', eventId: `persisted-stage-${versions.join('-')}`, runId: run.id,
      runRevision: run.revision + 1, sequence, createdAt: Date.now(), stage: 'mapping' } }))
  }
  return { store, service, provider, runtime, run, runId: created.run.id, persistRoutes }
}

describe('server-owned complete Evidence source excerpts', () => {
  it('preserves UTF-16 offsets, CRLF, whitespace and repeated sentences with distinct IDs', () => {
    const text = '标题\r\n  🌱 光合作用。\r\n重复事实。重复事实。\r\n'
    const input = sourceInput(text, 37)
    const excerpts = createEvidenceSourceExcerpts(input)
    expect(excerpts.map((excerpt) => excerpt.text).join('')).toBe(text)
    expect(excerpts.map((excerpt) => excerpt.excerptId)).toEqual(excerpts.map((_excerpt, index) => `excerpt-${index + 1}`))
    expect(excerpts[0]).toMatchObject({ start: 37, end: 41, text: '标题\r\n' })
    const repeated = excerpts.filter((excerpt) => excerpt.text === '重复事实。')
    expect(repeated).toHaveLength(2)
    expect(repeated[0]?.excerptId).not.toBe(repeated[1]?.excerptId)
    const citation = resolveEvidenceSourceExcerpt(input, excerpts, { excerptId: repeated[1]!.excerptId })
    expect(citation).toMatchObject({ start: 37 + text.lastIndexOf('重复事实。'), quote: '重复事实。' })
    expect(citation.page).toBeUndefined()
  })

  it.each(['a'.repeat(799) + '🌱' + 'b'.repeat(1500), 'a'.repeat(799) + '\r\n' + 'b'.repeat(1500)])(
    'never splits a surrogate pair or CRLF at the long-line limit', (text) => {
    const excerpts = createEvidenceSourceExcerpts(sourceInput(text))
    expect(excerpts.map((excerpt) => excerpt.text).join('')).toBe(text)
    for (const excerpt of excerpts) {
      expect(excerpt.text.length).toBeLessThanOrEqual(800)
      expect(excerpt.text).not.toMatch(/[\uD800-\uDBFF]$/u)
      expect(excerpt.text).not.toMatch(/^[\uDC00-\uDFFF]/u)
      expect(excerpt.text.endsWith('\r')).toBe(false)
      expect(excerpt.text.startsWith('\n')).toBe(false)
    }
  })

  it('bounds dense natural boundaries without omitting any source text', () => {
    const text = '。'.repeat(MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS)
    const excerpts = createEvidenceSourceExcerpts(sourceInput(text))
    expect(excerpts.length).toBeLessThanOrEqual(MAX_EVIDENCE_EXCERPTS)
    expect(excerpts.map((excerpt) => excerpt.text).join('')).toBe(text)
    expect(excerpts.every((excerpt) => excerpt.text.length <= MAX_EVIDENCE_EXCERPT_CHARACTERS)).toBe(true)
    expect(excerpts[0]?.start).toBe(0)
    expect(excerpts.at(-1)?.end).toBe(text.length)
  })

  it.each(['', 'a'.repeat(MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS + 1)])('rejects unrepresentable chunks rather than omitting text', (text) => {
    expect(() => createEvidenceSourceExcerpts(sourceInput(text))).toThrow(EvidenceExcerptResolutionError)
  })

  it('rejects mismatched input ranges and unknown IDs without fuzzy lookup or normalization', () => {
    const input = sourceInput('public fact')
    expect(() => createEvidenceSourceExcerpts({ ...input, text: 'other' })).toThrow('text length')
    const excerpts = createEvidenceSourceExcerpts(input)
    for (const excerptId of ['excerpt-01', ' excerpt-1', 'EXCERPT-1', 'excerpt-2', 'public fact']) {
      expect(() => resolveEvidenceSourceExcerpt(input, excerpts, { excerptId })).toThrow('excerpt_not_found')
    }
  })
})

describe('Evidence source-reference adapter and version isolation', () => {
  it('makes v3 the default, sends each selected source character once and persists exact verified citations', async () => {
    const text = 'Excluded introduction.\r\n标题\r\n🌱 光能转化为化学能。\r\n重复事实。重复事实。\r\nExcluded end.'
    const start = text.indexOf('标题')
    const end = text.indexOf('Excluded end.')
    const f = await prepare(text, (request) => {
      const excerpt = inputEnvelope(request).excerpts.find((item) => item.text === '🌱 光能转化为化学能。')!
      return response(refOutput(excerpt.excerptId))
    }, { start, end })
    expect((await f.run()).outcome).toBe('completed')
    const graph = await f.store.getEvidenceGraph(tenantId, f.runId)
    expect(graph?.promptVersion).toBe(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)
    const quote = '🌱 光能转化为化学能。'
    expect(graph?.cards[0]?.claims[0]?.citations).toEqual([{ version: 1, provenance: 'source', sourceId,
      start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote }])
    const call = f.provider.calls[0]!
    expect(call.output.name).toBe('evidence_map_v3')
    expect(call.systemPrompt).toContain('Do not copy quotation text')
    expect(inputEnvelope(call).excerpts.map((item) => item.text).join('')).toBe(text.slice(start, end))
    expect(call.userPrompt).not.toContain('Excluded introduction')
    expect(call.userPrompt).not.toContain('Excluded end')
    expect((await f.run()).outcome).toBe('already_complete')
    expect(f.provider.calls).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 0,
      usage: { inputTokens: 30, outputTokens: 20 } })
  })

  it('repairs an unknown excerpt ID with its own v2 repair invocation and remaining output budget', async () => {
    const f = await prepare('First public fact. Second public fact.', (request, call) => response(refOutput(
      call === 1 ? 'excerpt-not-provided' : inputEnvelope(request).excerpts[1]!.excerptId)))
    expect((await f.run()).outcome).toBe('completed')
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(f.provider.calls[1]?.invocationId).not.toBe(f.provider.calls[0]?.invocationId)
    expect(f.provider.calls[1]?.maxOutputTokens).toBe(4076)
    expect(JSON.parse(f.provider.calls[1]!.userPrompt)).toMatchObject({ task: 'evidence-map', validationFailure: 'excerpt_not_found' })
    const repair = await f.store.getProviderInvocation(tenantId, f.provider.calls[1]!.invocationId)
    expect(repair).toMatchObject({ role: 'repair', promptVersion: EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION, status: 'succeeded' })
    expect(JSON.stringify(repair)).not.toContain('Second public fact')
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.cards[0]?.claims[0]?.citations[0]?.quote).toBe(' Second public fact.')
  })

  it('rejects an unknown ID after exactly one repair without committing unsupported Evidence', async () => {
    const f = await prepare('public fact', () => response(refOutput('excerpt-not-provided')))
    expect(await f.run()).toMatchObject({ outcome: 'failed', run: { error: { details: { providerCode: 'evidence_excerpt_not_found' } } } })
    expect(f.provider.calls).toHaveLength(2)
    expect(await f.store.getEvidenceGraph(tenantId, f.runId)).toBeUndefined()
    expect(await f.store.listEvidenceCards(tenantId, f.runId)).toEqual([])
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 2,
      usage: { inputTokens: 60, outputTokens: 40 } })
  })

  it.each([{ quote: 'public fact', prefix: '', suffix: '' }, { start: 0, end: 11 }, { excerptId: 'excerpt-1', quote: 'public fact' }])(
    'rejects legacy or mixed citation shapes in v3 without relaxing the validator', async (citation) => {
    const invalid = refOutput('excerpt-1').replace('{"excerptId":"excerpt-1"}', JSON.stringify(citation))
    const f = await prepare('public fact', () => response(invalid))
    expect((await f.run()).outcome).toBe('failed')
    expect(f.provider.calls).toHaveLength(2)
    expect(await f.store.listEvidenceCards(tenantId, f.runId)).toEqual([])
  })

  it('does not allocate a repair after the Evidence output budget is exhausted', async () => {
    const f = await prepare('public fact', () => response('incomplete JSON', 4096))
    expect((await f.run()).outcome).toBe('failed')
    expect(f.provider.calls).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1,
      usage: { inputTokens: 30, outputTokens: 4096 } })
  })

  it('rejects over-capacity custom chunks before any invocation or usage reservation', async () => {
    const f = await prepare('public fact', () => response(refOutput('excerpt-1')))
    const input = sourceInput('a'.repeat(MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS + 1))
    await expect(f.runtime().evidenceGenerator.map({ ...input, runId: f.runId }, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'evidence_excerpt_capacity_exceeded', retryable: false, acceptance: 'not_accepted' })
    expect(f.provider.calls).toHaveLength(0)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 0 })
  })

  it('rejects mismatched v3 ranges before any invocation with a known nonretryable safe error', async () => {
    const f = await prepare('public fact', () => response(refOutput('excerpt-1')))
    await expect(f.runtime().evidenceGenerator.map({ ...sourceInput('public fact'), runId: f.runId, text: 'different text' }, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'evidence_excerpt_range_invalid', retryable: false, acceptance: 'not_accepted' })
    expect(f.provider.calls).toHaveLength(0)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 0 })
  })

  it('never repairs or replays an unknown remote outcome', async () => {
    const f = await prepare('public fact', () => { throw new ProviderGatewayError({ providerId: 'source-ref-fake-provider',
      kind: 'outcome_unknown', retryable: false, safeCode: 'synthetic_response_lost' }) })
    expect((await f.run()).outcome).toBe('failed')
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 1 })
    await f.run()
    expect(f.provider.calls).toHaveLength(1)
  })

  it.each([EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION])(
    'resumes persisted %s with its original output schema and legacy repair route', async (version) => {
    const f = await prepare('public fact', (_request, call) => response(JSON.stringify({
      claims: [{ id: 'claim', kind: 'fact', statement: 'public fact', conceptIds: [], citations: version === EVIDENCE_MAP_PROMPT_VERSION
        ? [{ start: 0, end: call === 1 ? 20 : 11 }] : [{ quote: call === 1 ? 'not in source' : 'public fact', prefix: '', suffix: '' }] }],
      terms: [], learningObjectives: [],
    })))
    await f.persistRoutes([version])
    expect((await f.run()).outcome).toBe('completed')
    expect(f.provider.calls.map((call) => call.output.name)).toEqual(Array(2).fill(version === EVIDENCE_MAP_PROMPT_VERSION ? 'evidence_map_v1' : 'evidence_map_v2'))
    expect(await f.store.getProviderInvocation(tenantId, f.provider.calls[1]!.invocationId))
      .toMatchObject({ promptVersion: EVIDENCE_REPAIR_PROMPT_VERSION })
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.promptVersion).toBe(version)
    expect((await f.run()).outcome).toBe('already_complete')
    expect(f.provider.calls).toHaveLength(2)
  })

  it.each([EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION])(
    'does not repay accepted %s output after a crash before card commit', async (version) => {
    const f = await prepare('public fact', (request) => response(version === EVIDENCE_SOURCE_REF_PROMPT_VERSION
      ? refOutput(inputEnvelope(request).excerpts[0]!.excerptId)
      : JSON.stringify({ claims: [{ id: 'claim', kind: 'fact', statement: 'public fact', conceptIds: [],
        citations: [{ quote: 'public fact', prefix: '', suffix: '' }] }], terms: [], learningObjectives: [] })))
    await f.persistRoutes([version])
    const current = (await f.store.getRun(tenantId, f.runId))!
    const chunk: EvidenceChunkV1 = planEvidenceChunks([{ snapshot: current.request.manifest.sources[0]!, text: 'public fact' }])[0]!
    const runtime = f.runtime()
    const generator = version === EVIDENCE_QUOTE_PROMPT_VERSION ? runtime.quoteEvidenceGenerator : runtime.sourceRefEvidenceGenerator
    await generator.map({ ...sourceInput('public fact'), runId: f.runId, chunk }, new AbortController().signal)
    expect(await f.store.listEvidenceCards(tenantId, f.runId)).toEqual([])
    expect(await f.run()).toMatchObject({ outcome: 'failed', run: { error: { details: { reason: 'invocation_already_succeeded' } } } })
    expect(f.provider.calls).toHaveLength(1)
  })

  it.each([
    [EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION],
    [EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION],
    ['evidence-source-ref-future'],
    [EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_REPAIR_PROMPT_VERSION],
    [EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION],
    [EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION],
  ])('stops mixed, future or mismatched persisted Evidence routes %j without changing the run', async (...versions) => {
    const f = await prepare('public fact', () => response(refOutput('excerpt-1')))
    await f.persistRoutes(versions)
    const before = await f.store.getRun(tenantId, f.runId)
    expect(await f.run()).toEqual({ outcome: 'stopped', reason: 'unsupported_execution_version', run: before })
    expect(await f.store.getRun(tenantId, f.runId)).toEqual(before)
    expect(f.provider.calls).toHaveLength(0)
  })
})
