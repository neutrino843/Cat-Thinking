import { createHash } from 'node:crypto'
import { analysisRequestSchema, type EvidenceChunkV1 } from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { EvidencePipelineWorker } from '../src/domain/evidencePipelineWorker.js'
import { planEvidenceChunks } from '../src/domain/chunkPlanner.js'
import { RunService } from '../src/domain/runService.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { EVIDENCE_MAP_PROMPT_ID, EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION,
  evidenceQuoteMapPrompt } from '../src/providers/evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_ID, EVIDENCE_REPAIR_PROMPT_VERSION, evidenceRepairPrompt } from '../src/providers/evidenceRepairPrompt.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/providers/modelProvider.js'
import { ProviderEvidenceGenerator } from '../src/providers/providerEvidenceGenerator.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { ProviderInvocationCoordinator } from '../src/providers/providerInvocationCoordinator.js'
import { ProviderRouter } from '../src/providers/providerRouter.js'
import { PromptRegistry } from '../src/providers/promptRegistry.js'

const tenantId = 'public-quote-tenant'
const sourceId = 'public-quote-source'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const output = (quote: string, prefix = '', suffix = '') => JSON.stringify({
  claims: [{ id: 'claim', kind: 'fact', statement: 'A public source fact.', conceptIds: ['term'], citations: [{ quote, prefix, suffix }] }],
  terms: [{ id: 'term', term: 'public concept', citations: [{ quote, prefix, suffix }] }],
  learningObjectives: [{ id: 'objective', text: 'Understand the public fact.', evidenceIds: ['claim', 'term'] }],
})

class QuoteFake implements ModelProvider {
  readonly id = 'quote-fake-provider'
  readonly modelId = 'quote-fake-model'
  readonly profileVersion = 'quote-fake-profile'
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

const prepare = async (text: string, respond: QuoteFake['respond'], selectedRange?: { start: number; end: number }) => {
  const store = new InMemoryJobStore()
  const service = new RunService({ store, retentionSeconds: 3600 })
  const created = await service.createRun(tenantId, analysisRequestSchema.parse({
    version: 1, requestKey: hash(text), docId: 'public-quote-doc',
    manifest: { version: 1, sources: [{ version: 1, sourceId, kind: 'text', extractor: 'public-fixture-v1',
      contentHash: hash(text), charCount: text.length, byteCount: new TextEncoder().encode(text).byteLength,
      ...(selectedRange ? { selectedRange } : {}) }] },
    artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard',
      quizQuestionCount: 1, externalKnowledge: false },
  }))
  await service.uploadSource(tenantId, created.run.id, { version: 1, sourceId, contentHash: hash(text), partHash: hash(text),
    partIndex: 0, partCount: 1, start: 0, end: text.length, totalChars: text.length, text })
  await service.startRun(tenantId, created.run.id, created.run.revision)
  const provider = new QuoteFake(respond)
  const route = (promptVersion: string) => ({ providerId: provider.id, modelId: provider.modelId, profileVersion: provider.profileVersion, promptVersion })
  const coordinator = new ProviderInvocationCoordinator({ ledger: store, estimateCostMicros: () => 1,
    router: new ProviderRouter([provider], [
      { id: EVIDENCE_MAP_PROMPT_ID, ...route(EVIDENCE_QUOTE_PROMPT_VERSION), promptId: EVIDENCE_MAP_PROMPT_ID,
        roles: ['evidence-map'], qualityProfiles: ['standard'], priority: 0 },
      { id: EVIDENCE_REPAIR_PROMPT_ID, ...route(EVIDENCE_REPAIR_PROMPT_VERSION), promptId: EVIDENCE_REPAIR_PROMPT_ID,
        roles: ['repair'], qualityProfiles: ['standard'], priority: 0 },
    ]),
  })
  const generator = new ProviderEvidenceGenerator({ coordinator, prompts: new PromptRegistry([evidenceQuoteMapPrompt, evidenceRepairPrompt]),
    promptId: EVIDENCE_MAP_PROMPT_ID, route: route(EVIDENCE_QUOTE_PROMPT_VERSION), maxOutputTokens: 512,
    repair: { promptId: EVIDENCE_REPAIR_PROMPT_ID, route: route(EVIDENCE_REPAIR_PROMPT_VERSION) } })
  const worker = new EvidencePipelineWorker({ store, generator, broker: service.broker, leaseMs: 1000 })
  const run = () => worker.runOnce(tenantId, created.run.id, 'quote-worker', new AbortController().signal)
  return { store, service, provider, generator, run, runId: created.run.id, route }
}
const response = (outputText: string, outputTokens = 20): ModelResponse => ({ outputText, usage: { inputTokens: 30, outputTokens } })

describe('exact Evidence quotation adapter', () => {
  it('locates verbatim UTF-16 quotes inside a selected nonzero range and persists them through the existing validator', async () => {
    const text = 'Excluded introduction.\r\n🌱 光合作用\r\n光能转化为化学能。\r\nExcluded ending.'
    const quote = '🌱 光合作用\r\n光能转化为化学能。'
    const start = text.indexOf('🌱')
    const f = await prepare(text, () => response(output(quote)), { start, end: start + quote.length })
    const result = await f.run()
    expect(result.outcome).toBe('completed')
    const graph = await f.store.getEvidenceGraph(tenantId, f.runId)
    expect(graph?.promptVersion).toBe(EVIDENCE_QUOTE_PROMPT_VERSION)
    expect(graph?.cards[0]?.claims[0]?.citations).toEqual([{ version: 1, provenance: 'source', sourceId, start, end: start + quote.length, quote }])
    expect(f.provider.calls[0]?.output.name).toBe('evidence_map_v2')
    expect(f.provider.calls[0]?.systemPrompt).toContain('Never count character offsets')
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 0,
      usage: { inputTokens: 30, outputTokens: 20 } })
    expect((await f.run()).outcome).toBe('already_complete')
    expect(f.provider.calls).toHaveLength(1)
  })

  it('repairs an ambiguous repeated quote once using adjacent context, a distinct invocation and only the remaining output budget', async () => {
    const text = 'first: fact. second: fact.'
    const f = await prepare(text, (_request, call) => response(call === 1 ? output('fact.') : output('fact.', 'second: ')))
    expect((await f.run()).outcome).toBe('completed')
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(f.provider.calls[1]?.maxOutputTokens).toBe(492)
    expect(f.provider.calls[1]?.invocationId).not.toBe(f.provider.calls[0]?.invocationId)
    const repairInput = JSON.parse(f.provider.calls[1]!.userPrompt)
    expect(repairInput).toMatchObject({ task: 'evidence-map', validationFailure: 'quote_ambiguous' })
    expect(repairInput.originalInput).toContain(text)
    const repair = await f.store.getProviderInvocation(tenantId, f.provider.calls[1]!.invocationId)
    expect(repair).toMatchObject({ role: 'repair', promptVersion: EVIDENCE_REPAIR_PROMPT_VERSION, status: 'succeeded' })
    expect(JSON.stringify(repair)).not.toContain(text)
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.cards[0]?.claims[0]?.citations[0]?.start).toBe(text.lastIndexOf('fact.'))
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 0,
      usage: { inputTokens: 60, outputTokens: 40 } })
  })

  it('selects repeated text using exact suffix context and stays inside the requested chunk', async () => {
    const text = 'excluded fact.a | fact.a and fact.b | excluded fact.b'
    const start = text.indexOf('|') + 2
    const end = text.lastIndexOf('|') - 1
    const f = await prepare(text, () => response(output('fact', '', '.b')), { start, end })
    expect((await f.run()).outcome).toBe('completed')
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.cards[0]?.claims[0]?.citations[0]).toMatchObject({
      start: text.indexOf('fact.b'), end: text.indexOf('fact.b') + 4, quote: 'fact',
    })
    expect(f.provider.calls).toHaveLength(1)
  })

  it.each([
    { text: 'aaaa', quote: 'aa', prefix: '', suffix: '', code: 'quote_ambiguous' },
    { text: 'first: fact. second: fact.', quote: 'fact.', prefix: 'invented context', suffix: '', code: 'quote_not_found' },
    { text: 'line one\r\nline two', quote: 'line one\nline two', prefix: '', suffix: '', code: 'quote_not_found' },
    { text: 'public fact', quote: 'public fact', prefix: 'outside', suffix: '', code: 'quote_not_found' },
  ])('rejects $code after at most one repair without persisting a card', async ({ text, quote, prefix, suffix, code }) => {
    const f = await prepare(text, () => response(output(quote, prefix, suffix)))
    expect(await f.run()).toMatchObject({ outcome: 'failed', run: { error: { code: 'provider_rejected', retryable: false,
      details: { providerCode: `evidence_${code}` } } } })
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(await f.store.getEvidenceGraph(tenantId, f.runId)).toBeUndefined()
    expect(await f.store.listEvidenceCards(tenantId, f.runId)).toEqual([])
  })

  it.each(['missing-reference', 'duplicate-id'])('repairs a $s semantic failure before the unchanged pipeline validator', async (failure) => {
    const valid = output('public fact')
    const bad = failure === 'missing-reference' ? valid.replace('"conceptIds":["term"]', '"conceptIds":["absent"]')
      : valid.replace('"id":"term"', '"id":"claim"')
    const f = await prepare('public fact', (_request, call) => response(call === 1 ? bad : valid))
    expect((await f.run()).outcome).toBe('completed')
    expect(f.provider.calls).toHaveLength(2)
    expect(JSON.parse(f.provider.calls[1]!.userPrompt).validationFailure).toBe(failure === 'missing-reference' ? 'reference_missing' : 'contract_invalid')
  })

  it('does not silently accept legacy numeric spans as v2 quotes', async () => {
    const legacy = JSON.stringify({ claims: [{ id: 'claim', kind: 'fact', statement: 'public fact', conceptIds: [],
      citations: [{ start: 0, end: 11 }] }], terms: [], learningObjectives: [] })
    const f = await prepare('public fact', () => response(legacy))
    expect(await f.run()).toMatchObject({ outcome: 'failed', run: { error: { details: { providerCode: 'evidence_schema_invalid' } } } })
    expect(f.provider.calls).toHaveLength(2)
  })

  it('keeps usage for a fully consumed invalid response and never allocates a repair beyond the cap', async () => {
    const f = await prepare('public fact', () => response('truncated synthetic output', 512))
    expect((await f.run()).outcome).toBe('failed')
    expect(f.provider.calls).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1,
      usage: { inputTokens: 30, outputTokens: 512 } })
  })

  it('does not repair or repeat an invocation whose remote outcome is unknown', async () => {
    const f = await prepare('public fact', () => { throw new ProviderGatewayError({ providerId: 'quote-fake-provider',
      kind: 'outcome_unknown', retryable: false, safeCode: 'synthetic_response_lost' }) })
    expect((await f.run()).outcome).toBe('failed')
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map'])
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 1 })
    await f.run()
    expect(f.provider.calls).toHaveLength(1)
  })

  it('preserves a known first response and an unknown repair without replaying either billable invocation', async () => {
    const f = await prepare('public fact', (_request, call) => {
      if (call === 1) return response(output('not in the source'))
      throw new ProviderGatewayError({ providerId: 'quote-fake-provider', kind: 'outcome_unknown',
        retryable: false, safeCode: 'synthetic_repair_lost' })
    })
    expect((await f.run()).outcome).toBe('failed')
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 1,
      usage: { inputTokens: 30, outputTokens: 20 } })
    expect(await f.store.getEvidenceGraph(tenantId, f.runId)).toBeUndefined()
    await f.run()
    expect(f.provider.calls).toHaveLength(2)
  })

  it('rejects mismatched chunk text before a billable request', async () => {
    const f = await prepare('public fact', () => response(output('public fact')))
    const chunk: EvidenceChunkV1 = { version: 1, chunkId: 'public-chunk', chunkHash: hash('public fact'), sourceId,
      start: 0, end: 11, titlePath: [], estimatedTokens: 10, ordinal: 0, total: 1, overlapBefore: 0, overlapAfter: 0 }
    await expect(f.generator.map({ tenantId, runId: f.runId, docId: 'public-quote-doc', locale: 'zh-CN', qualityProfile: 'standard',
      chunk, text: 'different text' }, new AbortController().signal)).rejects.toThrow('text length')
    expect(f.provider.calls).toHaveLength(0)
  })

  it('resumes a persisted v1 route with strict legacy offsets without upgrading or paying twice', async () => {
    const f = await prepare('public fact', (request) => response(JSON.stringify({
      claims: [{ id: 'legacy-claim', kind: 'fact', statement: 'public fact', conceptIds: [],
        citations: request.output.name === 'evidence_map_v1' ? [{ start: 0, end: 11 }] : [{ quote: 'public fact', prefix: '', suffix: '' }] }],
      terms: [], learningObjectives: [],
    })))
    const current = (await f.store.getRun(tenantId, f.runId))!
    await f.store.transitionRun(tenantId, f.runId, current.revision, (run, sequence) => ({ run: {
      ...run, revision: run.revision + 1, status: 'mapping', stage: 'mapping', providerRoutes: [f.route(EVIDENCE_MAP_PROMPT_VERSION)],
    }, event: { version: 1, type: 'stage.started', eventId: 'legacy-stage-event', runId: run.id, runRevision: run.revision + 1,
      sequence, createdAt: Date.now(), stage: 'mapping' } }))
    const runtime = createAnalysisProviderRuntime({ store: f.store, provider: f.provider, broker: f.service.broker,
      leaseMs: 1000, estimateCostMicros: () => 1 })
    expect((await runtime.evidence.runOnce(tenantId, f.runId, 'legacy-worker', new AbortController().signal)).outcome).toBe('completed')
    expect(f.provider.calls[0]?.output.name).toBe('evidence_map_v1')
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.promptVersion).toBe(EVIDENCE_MAP_PROMPT_VERSION)
    expect((await runtime.evidence.runOnce(tenantId, f.runId, 'legacy-restart', new AbortController().signal)).outcome).toBe('already_complete')
    expect(f.provider.calls).toHaveLength(1)
  })

  it('strictly validates legacy numeric ranges and repairs a bad range without switching its schema', async () => {
    const f = await prepare('public fact', (_request, call) => response(JSON.stringify({
      claims: [{ id: 'legacy-claim', kind: 'fact', statement: 'public fact', conceptIds: [],
        citations: [{ start: 0, end: call === 1 ? 20 : 11 }] }], terms: [], learningObjectives: [],
    })))
    const runtime = createAnalysisProviderRuntime({ store: f.store, provider: f.provider, broker: f.service.broker,
      leaseMs: 1000, estimateCostMicros: () => 1 })
    const worker = new EvidencePipelineWorker({ store: f.store, generator: runtime.legacyEvidenceGenerator,
      broker: f.service.broker, leaseMs: 1000 })
    expect((await worker.runOnce(tenantId, f.runId, 'strict-legacy-worker', new AbortController().signal)).outcome).toBe('completed')
    expect(f.provider.calls.map((call) => call.output.name)).toEqual(['evidence_map_v1', 'evidence_map_v1'])
    expect(JSON.parse(f.provider.calls[1]!.userPrompt).validationFailure).toBe('citation_range_invalid')
    expect((await f.store.getEvidenceGraph(tenantId, f.runId))?.cards[0]?.claims[0]?.citations[0]).toMatchObject({ start: 0, end: 11 })
  })

  it('keeps a successful legacy invocation paid once when its card was not committed before a restart', async () => {
    const f = await prepare('public fact', () => response(JSON.stringify({
      claims: [{ id: 'legacy-claim', kind: 'fact', statement: 'public fact', conceptIds: [], citations: [{ start: 0, end: 11 }] }],
      terms: [], learningObjectives: [],
    })))
    const current = (await f.store.getRun(tenantId, f.runId))!
    await f.store.transitionRun(tenantId, f.runId, current.revision, (run, sequence) => ({ run: {
      ...run, revision: run.revision + 1, status: 'mapping', stage: 'mapping', providerRoutes: [f.route(EVIDENCE_MAP_PROMPT_VERSION)],
    }, event: { version: 1, type: 'stage.started', eventId: 'legacy-crash-stage', runId: run.id, runRevision: run.revision + 1,
      sequence, createdAt: Date.now(), stage: 'mapping' } }))
    const makeRuntime = () => createAnalysisProviderRuntime({ store: f.store, provider: f.provider, broker: f.service.broker,
      leaseMs: 1000, estimateCostMicros: () => 1 })
    const chunk = planEvidenceChunks([{ snapshot: current.request.manifest.sources[0]!, text: 'public fact' }])[0]!
    await makeRuntime().legacyEvidenceGenerator.map({ tenantId, runId: f.runId, docId: current.docId, locale: 'zh-CN',
      qualityProfile: 'standard', chunk, text: 'public fact' }, new AbortController().signal)
    expect(await f.store.listEvidenceCards(tenantId, f.runId)).toEqual([])
    const result = await makeRuntime().evidence.runOnce(tenantId, f.runId, 'legacy-crash-recovery', new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'failed', run: { error: { retryable: false,
      details: { reason: 'invocation_already_succeeded' } } } })
    expect(f.provider.calls).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(tenantId, f.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 0,
      usage: { inputTokens: 30, outputTokens: 20 } })
  })

  it.each([[EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION], ['evidence-map-future']])(
    'stops mixed or unsupported persisted Evidence routes %j before changing or charging the run', async (...versions) => {
    const f = await prepare('public fact', () => response(output('public fact')))
    const current = (await f.store.getRun(tenantId, f.runId))!
    await f.store.transitionRun(tenantId, f.runId, current.revision, (run, sequence) => ({ run: {
      ...run, revision: run.revision + 1, status: 'mapping', stage: 'mapping', providerRoutes: versions.map(f.route),
    }, event: { version: 1, type: 'stage.started', eventId: 'mixed-stage-event', runId: run.id, runRevision: run.revision + 1,
      sequence, createdAt: Date.now(), stage: 'mapping' } }))
    const before = await f.store.getRun(tenantId, f.runId)
    const runtime = createAnalysisProviderRuntime({ store: f.store, provider: f.provider, broker: f.service.broker,
      leaseMs: 1000, estimateCostMicros: () => 1 })
    expect(await runtime.evidence.runOnce(tenantId, f.runId, 'mixed-worker', new AbortController().signal)).toEqual({ outcome: 'stopped', reason: 'unsupported_execution_version', run: before })
    expect(f.provider.calls).toHaveLength(0)
    expect(await f.store.getRun(tenantId, f.runId)).toEqual(before)
  })
})
