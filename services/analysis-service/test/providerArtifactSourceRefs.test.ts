import { describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_KINDS, QUALITY_PROFILES, type ArtifactKind, type CitationV1, type OutlineArtifactV1,
} from '@cat-thinking/analysis-contracts'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { planArtifactBudget } from '../src/domain/artifactBudget.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { ProviderArtifactGenerator, type ArtifactAdapterRoute } from '../src/providers/providerArtifactGenerator.js'
import { DEFAULT_PROVIDER_INVOCATION_POLICY, ProviderInvocationCoordinator, type ProviderInvocationPolicy } from '../src/providers/providerInvocationCoordinator.js'
import { ProviderRouter } from '../src/providers/providerRouter.js'
import { PromptRegistry } from '../src/providers/promptRegistry.js'
import {
  artifactPrompt, artifactSourceReferencePrompt, artifactSourceReferenceRepairPrompt, repairPrompt,
  ARTIFACT_REFERENCE_DRAFT_VERSION, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION, ARTIFACT_SOURCE_REFERENCE_VERSIONS,
  LEARNING_COVERAGE_GUIDANCE, QUIZ_FAIR_SCORING_GUIDANCE,
} from '../src/providers/artifactPrompts.js'
import { createArtifactReferenceCatalog } from '../src/providers/artifactReferenceDraft.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'

const prepare = async (key: string, legacy = false, policy: Partial<ProviderInvocationPolicy> = {}) => {
  const store = new InMemoryJobStore()
  const { service, runId } = await prepareFixtureRun(store, `source-refs-${key}`)
  const provider = new FakeAnalysisProvider()
  const runtime = createAnalysisProviderRuntime({ store, provider, broker: service.broker,
    leaseMs: 1000, estimateCostMicros: () => 3 })
  await runtime.evidence.runOnce(FIXTURE_TENANT, runId, 'evidence-owner', new AbortController().signal)
  const run = (await store.getRun(FIXTURE_TENANT, runId))!
  const graph = (await store.getEvidenceGraph(FIXTURE_TENANT, runId))!
  const artifactDefinitions = ARTIFACT_KINDS.map(legacy ? artifactPrompt : artifactSourceReferencePrompt)
  const repair = legacy ? repairPrompt : artifactSourceReferenceRepairPrompt
  const definitions = [...artifactDefinitions, repair]
  const prompts = new PromptRegistry()
  for (const definition of artifactDefinitions) prompts.register(definition)
  prompts.register(repair)
  const route = (promptVersion: string) => ({ providerId: provider.id, modelId: provider.modelId,
    profileVersion: provider.profileVersion, promptVersion })
  const coordinator = new ProviderInvocationCoordinator({ ledger: store, estimateCostMicros: () => 3,
    policy: { ...DEFAULT_PROVIDER_INVOCATION_POLICY, ...policy },
    router: new ProviderRouter([provider], definitions.map((definition) => ({
      id: `${definition.id}.${definition.version}`, ...route(definition.version), promptId: definition.id,
      roles: [definition.role], qualityProfiles: QUALITY_PROFILES, priority: 0,
    }))) })
  const routes = Object.fromEntries(ARTIFACT_KINDS.map((kind) => {
    const definition = (legacy ? artifactPrompt : artifactSourceReferencePrompt)(kind)
    return [kind, { promptId: definition.id, route: route(definition.version) }]
  })) as Record<ArtifactKind, ArtifactAdapterRoute>
  const generatorOptions = { coordinator, prompts, routes,
    repair: { promptId: repair.id, route: route(repair.version) }, maxOutputTokens: 4096 }
  const generator = new ProviderArtifactGenerator(generatorOptions)
  const input = { tenantId: FIXTURE_TENANT, run, attempt: 1, runId, docId: run.docId, kind: 'summary' as ArtifactKind,
    options: run.request.options, budget: planArtifactBudget('summary', run.request.options), graph }
  const claim = graph.claims[0]!
  const support = { evidenceIds: [claim.id], citations: [{ refId: createArtifactReferenceCatalog(graph).references[0]!.refId }] }
  return { store, service, provider, input, support, generator, generatorOptions }
}

type Fixture = Awaited<ReturnType<typeof prepare>>
const summary = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  overview: { id: 'overview', text: FIXTURE_TEXT, ...f.support, ...overrides },
  keyPoints: [{ id: 'key-point', text: FIXTURE_TEXT, ...f.support }], confusions: [],
})
const wrap = (payload: unknown) => JSON.stringify({ draftVersion: ARTIFACT_REFERENCE_DRAFT_VERSION, payload })
const groundedOutline = (f: Fixture): OutlineArtifactV1 => ({ title: 'Energy conversion', nodes: [{
  id: 'mechanism', title: 'Mechanism', evidenceIds: [f.input.graph.claims[0]!.id],
  citations: f.input.graph.claims[0]!.citations, children: [{
    id: 'light', title: 'Light energy', evidenceIds: [f.input.graph.claims[0]!.id],
    citations: f.input.graph.claims[0]!.citations, children: [{
      id: 'stored', title: 'Stored chemical energy', evidenceIds: [f.input.graph.claims[0]!.id],
      citations: f.input.graph.claims[0]!.citations, children: [],
    }],
  }],
}] })

describe('Artifact source reference adapters', () => {
  it.each(['source-hash', 'selection-range', 'request-options'] as const)('rejects a mismatched %s scheduling context before any Artifact invocation', async (mismatch) => {
    const f = await prepare(`preflight-${mismatch}`)
    const graph = structuredClone(f.input.graph)
    let options = f.input.options
    if (mismatch === 'source-hash') graph.sourceContentHashes[0] = 'f'.repeat(64)
    if (mismatch === 'selection-range') graph.chunks[0].end = f.input.run.request.manifest.sources[0].charCount + 1
    if (mismatch === 'request-options') options = { ...options, quizQuestionCount: options.quizQuestionCount + 1 }
    const baseline = await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)
    await expect(f.generator.generate({ ...f.input, graph, options }, new AbortController().signal)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'identity_invalid' })],
    })
    expect(f.provider.calls).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toEqual(baseline)
  })
  it.each(ARTIFACT_KINDS)('hydrates %s references into exact Artifact V1 citations', async (kind) => {
    const f = await prepare(`all-${kind}`)
    const grounded = f.support
    const payloads = {
      summary: summary(f),
      outline: { title: 'Energy conversion', nodes: [{ id: 'concept', title: 'Light energy', ...grounded, children: [] }] },
      mindmap: { title: 'Energy conversion', nodes: [
        { id: 'document-root', parentId: null, text: 'Energy conversion', evidenceIds: [], citations: [] },
        { id: 'mechanism', parentId: 'document-root', text: 'Mechanism', ...grounded },
        { id: 'light', parentId: 'mechanism', text: 'Light energy', ...grounded },
        { id: 'stored', parentId: 'light', text: 'Stored chemical energy', ...grounded },
      ], relations: [{ id: 'conversion', from: 'light', to: 'stored', label: 'converted into', ...grounded }] },
      quiz: { title: 'Light energy', questions: [{ id: 'question', type: 'true-false', prompt: FIXTURE_TEXT,
        answer: true, explanation: FIXTURE_TEXT, difficulty: 'easy', ...grounded }] },
      knowledge: { items: [{ id: 'knowledge', title: 'Energy', explanation: FIXTURE_TEXT,
        relationship: 'application', provenance: 'source', ...grounded }] },
    }
    f.provider.override = () => wrap(payloads[kind])
    const input = { ...f.input, kind, budget: planArtifactBudget(kind, f.input.options),
      ...(kind === 'mindmap' ? { outline: groundedOutline(f) } : {}) }
    const result = await f.generator.generate(input, new AbortController().signal)
    expect(result.artifact.kind).toBe(kind)
    expect(result.route.promptVersion).toBe(ARTIFACT_SOURCE_REFERENCE_VERSIONS[kind])
    const payloadText = JSON.stringify(result.artifact.payload)
    expect(payloadText).not.toContain('refId')
    expect(payloadText).toContain(JSON.stringify(f.input.graph.claims[0]!.citations[0]!))
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    expect(f.provider.calls[1]!.output.name).toBe(`artifact_${kind}_source_refs_v1`)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({
      invocationCount: 2, unresolvedCount: 0, usage: { inputTokens: 40, outputTokens: 20, estimatedCostMicros: 6 },
    })
  })

  it('renders verified quotes once in the catalog and preserves evidence and outline identities', async () => {
    const f = await prepare('compact-prompt')
    const claim = f.input.graph.claims[0]!
    const graph = { ...f.input.graph, claims: [claim, { ...claim, id: 'second-claim' }] }
    const input = { ...f.input, graph, kind: 'mindmap' as const, outline: groundedOutline(f) }
    const rendered = artifactSourceReferencePrompt('mindmap').render(input)
    const data = JSON.parse(rendered)
    expect(data.referenceCatalog).toHaveLength(1)
    expect(data.referenceCatalog[0]).toEqual({ refId: 'cite-1', sourceId: claim.citations[0]!.provenance === 'source' ? claim.citations[0]!.sourceId : undefined, quote: claim.citations[0]!.provenance === 'source' ? claim.citations[0]!.quote : undefined })
    expect(data.referenceCatalog[0]).not.toHaveProperty('start')
    expect(data.referenceCatalog[0]).not.toHaveProperty('citation')
    expect(data.outputGuidance.revision).toBe('coverage-and-fair-rubric-v2')
    expect(data.evidence.claims.map((entry: { citations: unknown[] }) => entry.citations)).toEqual([
      [{ refId: 'cite-1' }], [{ refId: 'cite-1' }],
    ])
    expect(data.outline.nodes[0].citations).toEqual([{ refId: 'cite-1' }])
    expect(data.outlineHierarchy).toEqual([
      { id: 'mechanism', parentOutlineId: null, title: 'Mechanism' },
      { id: 'light', parentOutlineId: 'mechanism', title: 'Light energy' },
      { id: 'stored', parentOutlineId: 'light', title: 'Stored chemical energy' },
    ])
    expect((rendered.match(/"quote"/gu) ?? [])).toHaveLength(1)
    expect(artifactSourceReferencePrompt('mindmap').system).toContain('untrusted data')
    expect(artifactSourceReferenceRepairPrompt.system).toContain('untrusted data')
  })

  it('delivers coverage and stem-aligned scoring policies through both quiz protocol families', async () => {
    const f = await prepare('fair-scoring-policies')
    const input = { ...f.input, kind: 'quiz' as const }
    for (const prompt of [artifactPrompt('quiz'), artifactSourceReferencePrompt('quiz')]) {
      expect(prompt.system).toContain(QUIZ_FAIR_SCORING_GUIDANCE)
      expect(prompt.system).toContain('untrusted data')
    }
    const data = JSON.parse(artifactSourceReferencePrompt('quiz').render(input))
    expect(data.outputGuidance.coverage).toBe(LEARNING_COVERAGE_GUIDANCE)
    expect(data.outputGuidance.shortAnswers).toContain('Do not pad to a fixed count')
    expect(data.budget).toEqual(input.budget)
    expect(data.evidence).toEqual(createArtifactReferenceCatalog(input.graph).evidence)
  })

  it('accepts provider-encoded optional nulls while retaining strict unknown-key rejection', async () => {
    const f = await prepare('optional-nulls')
    f.provider.override = () => wrap({ ...summary(f), conclusion: null })
    const result = await f.generator.generate(f.input, new AbortController().signal)
    expect(result.artifact.payload).not.toHaveProperty('conclusion')
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    const other = await prepare('unknown-null-key')
    other.provider.override = () => wrap({ ...summary(other), inventedKey: null })
    await expect(other.generator.generate(other.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(other.provider.calls.slice(1)).toHaveLength(2)
  })

  it('repairs one unknown reference in an independent invocation with a full per-call budget', async () => {
    const f = await prepare('repair-unknown-reference')
    f.provider.override = (request) => wrap(summary(f, request.role === 'repair' ? {} : { citations: [{ refId: 'cite-999' }] }))
    const result = await f.generator.generate({ ...f.input, budget: { ...f.input.budget, maxOutputTokens: 5000 } }, new AbortController().signal)
    expect(result.artifact.kind).toBe('summary')
    const calls = f.provider.calls.slice(1)
    expect(calls.map(({ role }) => role)).toEqual(['artifact-summary', 'repair'])
    expect(calls[0]!.invocationId).not.toBe(calls[1]!.invocationId)
    expect(calls[1]!.maxOutputTokens).toBe(4096)
    expect(result.invocationCount).toBe(2)
    expect(JSON.parse(calls[1]!.userPrompt).failure).toBe('reference_not_found')
    const repair = await f.store.getProviderInvocation(FIXTURE_TENANT, calls[1]!.invocationId)
    expect(repair).toMatchObject({ nodeKey: 'artifact:summary:repair', promptVersion: ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION })
    expect(JSON.stringify(repair)).not.toContain('cite-999')
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 20, estimatedCostMicros: 6 })
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({
      invocationCount: 3, unresolvedCount: 0, usage: { inputTokens: 60, outputTokens: 30, estimatedCostMicros: 9 },
    })
  })

  it('retains both known usages and stops after one invalid repair without storing an artifact', async () => {
    const f = await prepare('repair-fails')
    f.provider.override = () => wrap(summary(f, { citations: [{ refId: 'cite-999' }] }))
    await expect(f.generator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_reference_not_found', retryable: false })
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-summary', 'repair'])
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.input.runId, 'summary')).toBeUndefined()
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 3,
      unresolvedCount: 0, usage: { inputTokens: 60, outputTokens: 30 } })
  })
  it('reproduces the 1732/1800 truncation trap and gives the single repair enough room', async () => {
    const f = await prepare('near-cap-repair')
    vi.spyOn(f.provider, 'generate').mockImplementation(async (request) => {
      f.provider.calls.push(request)
      const repairing = request.role === 'repair'
      return { outputText: wrap(summary(f, repairing ? {} : { citations: [{ refId: 'cite-999' }] })),
        usage: { inputTokens: 20, outputTokens: repairing ? 1000 : 1732 } }
    })
    const result = await f.generator.generate({ ...f.input, budget: { ...f.input.budget, maxOutputTokens: 1800 } }, new AbortController().signal)
    expect(f.provider.calls.slice(1).map(({ maxOutputTokens }) => maxOutputTokens)).toEqual([1800, 1800])
    expect(result).toMatchObject({ invocationCount: 2, usage: { inputTokens: 40, outputTokens: 2732 } })
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 3,
      usage: { inputTokens: 60, outputTokens: 2742 } })
  })
  it('refuses repair before dispatch when the run invocation budget is already consumed', async () => {
    const f = await prepare('repair-run-budget', false, { maxRunInvocations: 2 })
    f.provider.override = () => wrap(summary(f, { citations: [{ refId: 'cite-999' }] }))
    await expect(f.generator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'budget_exceeded', safeCode: 'run_invocations_budget_exceeded' })
    expect(f.provider.calls.map(({ role }) => role)).toEqual(['evidence-map', 'artifact-summary'])
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 2,
      usage: { inputTokens: 40, outputTokens: 20 } })
  })

  it.each([
    { refId: 'cite-1', start: 0 },
    { refId: 'cite-1', sourceId: 'different-source' },
    { refId: 'cite-1', quote: 'invented quote' },
    { version: 1, provenance: 'source', sourceId: 'synthetic-source', start: 0, end: FIXTURE_TEXT.length },
  ])('rejects numeric or model-authored citation fields instead of ignoring them: %j', async (citation) => {
    const f = await prepare(`strict-citation-${JSON.stringify(citation)}`)
    f.provider.override = () => wrap(summary(f, { citations: [citation] }))
    await expect(f.generator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(2)
  })

  it.each(['wrong-version', 'missing-wrapper', 'extra-envelope'] as const)('rejects %s without silently changing protocols', async (scenario) => {
    const f = await prepare(scenario)
    const payload = summary(f)
    f.provider.override = () => scenario === 'missing-wrapper' ? JSON.stringify(payload) : JSON.stringify({
      draftVersion: scenario === 'wrong-version' ? 'artifact-source-refs-v99' : ARTIFACT_REFERENCE_DRAFT_VERSION,
      payload, ...(scenario === 'extra-envelope' ? { runId: f.input.runId } : {}),
    })
    await expect(f.generator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(2)
  })

  it('retains the strict Evidence ID validator after hydrating valid catalog references', async () => {
    const f = await prepare('unknown-evidence')
    f.provider.override = () => wrap(summary(f, { evidenceIds: ['unknown-evidence'] }))
    await expect(f.generator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(2)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.input.runId, 'summary')).toBeUndefined()
  })

  it('requires each Outline parent to have its own source support even when its child is grounded', async () => {
    const f = await prepare('outline-unsupported-parent')
    f.provider.override = () => wrap({ title: 'Energy conversion', nodes: [{ id: 'parent', title: 'Mechanism',
      evidenceIds: [], citations: [], children: [{ id: 'child', title: 'Light energy', ...f.support, children: [] }] }] })
    await expect(f.generator.generate({ ...f.input, kind: 'outline',
      budget: planArtifactBudget('outline', f.input.options) }, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-outline', 'repair'])
    const failures = JSON.parse(JSON.parse(f.provider.calls[2]!.userPrompt).failure)
    expect(failures.map(({ code }: { code: string }) => code)).toEqual(['evidence_missing', 'citation_unverified'])
  })

  it('normalizes a complete flattened map only from exact Outline identities and keeps supported relations', async () => {
    const f = await prepare('hierarchy')
    const outline = groundedOutline(f)
    const nodes = [
      { id: 'document-root', parentId: null, text: outline.title, evidenceIds: [], citations: [] },
      { id: 'mechanism', parentId: 'document-root', text: 'Mechanism', ...f.support },
      { id: 'light', parentId: 'document-root', text: 'Light energy', note: 'Input energy', ...f.support },
      { id: 'stored', parentId: 'document-root', text: 'Stored chemical energy', ...f.support },
    ]
    f.provider.override = () => wrap({ title: outline.title, nodes,
      relations: [{ id: 'conversion', from: 'light', to: 'stored', label: 'converted into', ...f.support }] })
    const result = await f.generator.generate({ ...f.input, kind: 'mindmap', outline,
      budget: planArtifactBudget('mindmap', f.input.options) }, new AbortController().signal)
    if (result.artifact.kind !== 'mindmap') throw new Error('expected MindMap')
    expect(result.artifact.payload.nodes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['document-root', null], ['mechanism', 'document-root'], ['light', 'mechanism'], ['stored', 'light'],
    ])
    expect(result.artifact.payload.nodes[2]!.note).toBe('Input energy')
    expect(result.artifact.payload.relations[0]!.citations).toEqual(f.input.graph.claims[0]!.citations)
    expect(f.provider.calls.slice(1)).toHaveLength(1)
  })

  it('preserves an explicitly labeled, source-supported inference as an inference', async () => {
    const f = await prepare('inference')
    f.provider.override = () => wrap({ items: [{ id: 'inference', title: 'Energy use', explanation: 'Derived from this source.',
      relationship: 'application', provenance: 'inference', evidenceIds: f.support.evidenceIds,
      citations: [...f.support.citations, { provenance: 'inference', label: 'Derived from the cited source' }] }] })
    const result = await f.generator.generate({ ...f.input, kind: 'knowledge',
      budget: planArtifactBudget('knowledge', f.input.options) }, new AbortController().signal)
    if (result.artifact.kind !== 'knowledge') throw new Error('expected Knowledge')
    expect(result.artifact.payload.items[0]!.provenance).toBe('inference')
    expect(result.artifact.payload.items[0]!.citations).toEqual([...f.input.graph.claims[0]!.citations,
      { version: 1, provenance: 'inference', label: 'Derived from the cited source' }])
  })

  it('rejects an inference with no supporting source or explicit label and does not invent grounding', async () => {
    const f = await prepare('unsupported-inference')
    f.provider.override = () => wrap({ items: [{ id: 'inference', title: 'Unsupported', explanation: 'Not in the source.',
      relationship: 'application', provenance: 'inference', evidenceIds: [], citations: [{ provenance: 'inference' }] }] })
    await expect(f.generator.generate({ ...f.input, kind: 'knowledge',
      budget: planArtifactBudget('knowledge', f.input.options) }, new AbortController().signal))
      .rejects.toMatchObject({ retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(2)
  })

  it('does not repair oversized output and retains the original known usage', async () => {
    const f = await prepare('too-large')
    f.provider.override = () => 'x'.repeat(f.input.budget.maxArtifactBytes + 1)
    await expect(f.generator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_too_large', retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({
      invocationCount: 2, unresolvedCount: 0, usage: { inputTokens: 40, outputTokens: 20 },
    })
  })

  it('enforces the persisted artifact byte budget after expanding references without allocating a repair', async () => {
    const f = await prepare('hydrated-artifact-byte-limit')
    const output = wrap(summary(f))
    f.provider.override = () => output
    await expect(f.generator.generate({ ...f.input,
      budget: { ...f.input.budget, maxArtifactBytes: Buffer.byteLength(output, 'utf8') + 1 },
    }, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'artifact_output_too_large', retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.input.runId, 'summary')).toBeUndefined()
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 2,
      unresolvedCount: 0, usage: { inputTokens: 40, outputTokens: 20 } })
  })

  it('allows exactly one full-budget repair after consuming the per-call output cap', async () => {
    const f = await prepare('output-budget-exhausted')
    vi.spyOn(f.provider, 'generate').mockImplementation(async (request) => {
      f.provider.calls.push(request)
      return { outputText: 'invalid-json', usage: { inputTokens: 20, outputTokens: request.maxOutputTokens } }
    })
    await expect(f.generator.generate({ ...f.input, budget: { ...f.input.budget, maxOutputTokens: 5000 } }, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1).map(({ maxOutputTokens }) => maxOutputTokens)).toEqual([4096, 4096])
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({
      invocationCount: 3, unresolvedCount: 0, usage: { inputTokens: 60, outputTokens: 8202 },
    })
  })

  it('does not repair or replay an accepted invocation with an unknown outcome', async () => {
    const f = await prepare('unknown-outcome')
    f.provider.override = () => { throw new ProviderGatewayError({ providerId: f.provider.id,
      kind: 'outcome_unknown', acceptance: 'accepted', retryable: false, safeCode: 'public-response-lost' }) }
    await expect(f.generator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ kind: 'outcome_unknown' })
    await expect(f.generator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ kind: 'outcome_unknown' })
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 1 })
  })

  it('checks cancellation before any billable artifact invocation', async () => {
    const f = await prepare('aborted')
    const controller = new AbortController()
    controller.abort()
    await expect(f.generator.generate(f.input, controller.signal)).rejects.toMatchObject({ safeCode: 'caller_aborted' })
    expect(f.provider.calls.slice(1)).toHaveLength(0)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 1 })
  })

  it('retains an accepted malformed response usage but skips repair after cancellation', async () => {
    const f = await prepare('abort-after-response')
    const controller = new AbortController()
    f.provider.override = () => {
      controller.abort()
      return 'invalid-json'
    }
    await expect(f.generator.generate(f.input, controller.signal)).rejects.toMatchObject({ safeCode: 'artifact_output_invalid' })
    expect(f.provider.calls.slice(1)).toHaveLength(1)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 2,
      unresolvedCount: 0, usage: { inputTokens: 40, outputTokens: 20 } })
  })

  it('rejects an invalid catalog before reserving an invocation or attempting repair', async () => {
    const f = await prepare('invalid-catalog')
    const input = { ...f.input, graph: { ...f.input.graph, claims: f.input.graph.claims.map((claim) => ({
      ...claim, citations: claim.citations.map((citation) => ({ ...citation, end: FIXTURE_TEXT.length + 1 })),
    })) } }
    await expect(f.generator.generate(input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_catalog_invalid', acceptance: 'not_accepted', retryable: false })
    expect(f.provider.calls.slice(1)).toHaveLength(0)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.input.runId)).toMatchObject({ invocationCount: 1 })
  })

  it('rejects unknown artifact versions and mismatched repair families before any provider call', async () => {
    const f = await prepare('wrong-routes')
    expect(() => new ProviderArtifactGenerator({ ...f.generatorOptions, routes: {
      ...f.generatorOptions.routes, summary: { promptId: 'artifact.summary', route: {
        ...f.generatorOptions.routes.summary.route, promptVersion: 'summary-future-v999',
      } },
    } })).toThrow('unsupported artifact prompt version')
    expect(() => new ProviderArtifactGenerator({ ...f.generatorOptions, repair: {
      ...f.generatorOptions.repair, route: { ...f.generatorOptions.repair.route, promptVersion: repairPrompt.version },
    } })).toThrow('does not match')
    const old = await prepare('legacy-wrong-repair', true)
    expect(() => new ProviderArtifactGenerator({ ...old.generatorOptions, repair: {
      ...old.generatorOptions.repair, route: { ...old.generatorOptions.repair.route,
        promptVersion: ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION },
    } })).toThrow('does not match')
    expect(f.provider.calls.slice(1)).toHaveLength(0)
    expect(old.provider.calls.slice(1)).toHaveLength(0)
  })

  it('keeps the stored legacy numeric citation protocol and its old output name', async () => {
    const f = await prepare('legacy', true)
    const support = { evidenceIds: f.support.evidenceIds, citations: f.input.graph.claims[0]!.citations as CitationV1[] }
    f.provider.override = () => JSON.stringify({ overview: { id: 'overview', text: FIXTURE_TEXT, ...support },
      keyPoints: [{ id: 'point', text: FIXTURE_TEXT, ...support }], confusions: [] })
    const result = await f.generator.generate(f.input, new AbortController().signal)
    expect(result.route.promptVersion).toBe(artifactPrompt('summary').version)
    expect(f.provider.calls[1]!.output.name).toBe('artifact_summary_v1')
    expect(result.artifact.payload).toMatchObject({ overview: { citations: support.citations } })
    expect(f.provider.calls.slice(1)).toHaveLength(1)
  })
})
