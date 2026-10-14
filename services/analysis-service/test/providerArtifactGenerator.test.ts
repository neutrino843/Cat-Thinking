import { describe, expect, it, vi } from 'vitest'
import { type CitationV1, type MindMapArtifactV1, type OutlineArtifactV1, type OutlineNodeV1 } from '@cat-thinking/analysis-contracts'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { createStableInvocationId } from '../src/providers/invocationId.js'
import { planArtifactBudget } from '../src/domain/artifactBudget.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { ARTIFACT_PROMPT_VERSION, KNOWLEDGE_GROUNDING_POLICY_VERSION, MINDMAP_HIERARCHY_PROMPT_VERSION,
  MAX_OUTLINE_SECTION_CHARACTERS, MAX_OUTLINE_SOURCE_SECTIONS,
  OUTLINE_HIERARCHY_PROMPT_VERSION, artifactPrompt, repairPrompt } from '../src/providers/artifactPrompts.js'
import { ArtifactValidationError, validateGeneratedArtifact } from '../src/domain/artifactValidator.js'
import { EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION } from '../src/providers/evidenceRepairPrompt.js'

const prepare = async (key: string) => {
  const store = new InMemoryJobStore()
  const { service, runId } = await prepareFixtureRun(store, key)
  const provider = new FakeAnalysisProvider()
  const runtime = createAnalysisProviderRuntime({ store, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3, artifactProtocol: 'legacy' })
  await runtime.evidence.runOnce(FIXTURE_TENANT, runId, 'evidence-owner', new AbortController().signal)
  const run = (await store.getRun(FIXTURE_TENANT, runId))!
  const graph = (await store.getEvidenceGraph(FIXTURE_TENANT, runId))!
  const input = { tenantId: FIXTURE_TENANT, run, attempt: 1, runId, docId: run.docId, kind: 'summary' as const,
    options: run.request.options, budget: planArtifactBudget('summary', run.request.options), graph }
  return { store, service, runId, provider, runtime, input }
}

describe('Provider artifact adapters', () => {
  const hierarchyFixture = async (key: string) => {
    const f = await prepare(key)
    const claim = f.input.graph.claims[0]!
    const support = { evidenceIds: [claim.id], citations: claim.citations }
    const outline: OutlineArtifactV1 = { title: 'Energy conversion', nodes: [{
      id: 'mechanism', title: 'Mechanism', ...support, children: [{
        id: 'input', title: 'Light input', ...support, children: [{
          id: 'storage', title: 'Stored chemical energy', ...support, children: [],
        }],
      }],
    }] }
    const map: MindMapArtifactV1 = { title: outline.title, nodes: [
      { id: 'document-root', parentId: null, text: outline.title, ...support },
      { id: 'mechanism', parentId: 'document-root', text: 'Mechanism', ...support },
      { id: 'input', parentId: 'document-root', text: 'Light input', note: 'Supported input', ...support },
      { id: 'storage', parentId: 'document-root', text: 'Stored chemical energy', ...support },
    ], relations: [] }
    const input = { ...f.input, kind: 'mindmap' as const, outline, budget: planArtifactBudget('mindmap', f.input.options) }
    return { ...f, input, map }
  }

  const ungroundOutlineNodes = (nodes: readonly OutlineNodeV1[]): OutlineNodeV1[] => nodes.map((node) => ({
    ...node, evidenceIds: [], citations: [], children: ungroundOutlineNodes(node.children),
  }))

  const omitQuote = (citation: CitationV1): CitationV1 => {
    if (citation.provenance !== 'source') return citation
    const omitted = { ...citation }
    delete omitted.quote
    return omitted
  }
  const summaryPayload = (evidenceId: string, citation: CitationV1) => {
    const entry = { id: 'overview', text: 'Source-grounded energy conversion', evidenceIds: [evidenceId], citations: [citation] }
    return { overview: entry, keyPoints: [{ ...entry, id: 'key-point' }], confusions: [] }
  }

  it.each(['claim', 'term', 'objective'] as const)('accepts omission of a verified v2 quote supported by a %s without an extra repair', async (kind) => {
    const f = await prepare(`optional-citation-quote-${kind}`)
    const claim = f.input.graph.claims[0]!
    const citation = claim.citations[0]!
    if (citation.provenance !== 'source' || citation.quote === undefined) throw new Error('expected quoted v2 source citation')
    const evidenceId = kind === 'claim' ? claim.id : `quoted-${kind}`
    const graph = { ...f.input.graph,
      terms: kind === 'term' ? [...f.input.graph.terms, { id: evidenceId, term: 'Energy', definition: claim.statement, citations: [citation] }]
        : f.input.graph.terms,
      learningObjectives: kind === 'objective' ? [...f.input.graph.learningObjectives,
        { id: evidenceId, text: 'Understand energy conversion', evidenceIds: [claim.id] }] : f.input.graph.learningObjectives,
    }
    f.provider.override = () => JSON.stringify(summaryPayload(evidenceId, omitQuote(citation)))
    const result = await f.runtime.artifactGenerator.generate({ ...f.input, graph }, new AbortController().signal)
    if (result.artifact.kind !== 'summary') throw new Error('expected Summary artifact')
    expect(result.artifact.payload.overview.citations).toEqual([omitQuote(citation)])
    expect(result.artifact.payload.overview.citations[0]).not.toHaveProperty('quote')
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-summary'])
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 0 })
  })

  it('accepts optional quote omission in new deep Outline and MindMap nodes while preserving exact hierarchy', async () => {
    const f = await hierarchyFixture('optional-quote-deep-hierarchy')
    const withoutQuotes = (node: OutlineNodeV1): OutlineNodeV1 => ({ ...node,
      citations: node.citations.map(omitQuote), children: node.children.map(withoutQuotes) })
    const outline = { ...f.input.outline, nodes: f.input.outline.nodes.map(withoutQuotes) }
    const map = { ...f.map, nodes: f.map.nodes.map((node) => ({ ...node, citations: node.citations.map(omitQuote) })) }
    f.provider.override = (request) => JSON.stringify(request.role === 'artifact-outline' ? outline : map)
    const generatedOutline = await f.runtime.artifactGenerator.generate({ ...f.input, kind: 'outline', outline: undefined,
      budget: planArtifactBudget('outline', f.input.options) }, new AbortController().signal)
    if (generatedOutline.artifact.kind !== 'outline') throw new Error('expected Outline artifact')
    const result = await f.runtime.artifactGenerator.generate({ ...f.input, outline: generatedOutline.artifact.payload }, new AbortController().signal)
    if (result.artifact.kind !== 'mindmap') throw new Error('expected MindMap artifact')
    expect(result.artifact.payload.nodes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['document-root', null], ['mechanism', 'document-root'], ['input', 'mechanism'], ['storage', 'input'],
    ])
    expect(result.artifact.payload.nodes.flatMap(({ citations }) => citations).every((citation) => !('quote' in citation))).toBe(true)
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-outline', 'artifact-mindmap'])
    expect(artifactPrompt('outline').system).toContain('You may omit the optional quote')
    expect(artifactPrompt('mindmap').system).toContain('verified quote verbatim')
  })

  it.each(['wrong-quote', 'wrong-source', 'start', 'end', 'page', 'omit-page', 'locator', 'omit-locator'] as const)(
    'keeps %s identity strict when allowing quote omission', async (change) => {
      const f = await prepare(`optional-quote-strict-${change}`)
      const claim = f.input.graph.claims[0]!
      const source = claim.citations[0]!
      if (source.provenance !== 'source' || source.quote === undefined) throw new Error('expected quoted v2 source citation')
      const verified = { ...source, page: 1, locator: 'Verified section' }
      const changed = { ...verified }
      delete changed.quote
      if (change === 'wrong-quote') changed.quote = 'A different unverified quote'
      if (change === 'wrong-source') changed.sourceId = 'another-valid-source'
      if (change === 'start') changed.start += 1
      if (change === 'end') changed.end -= 1
      if (change === 'page') changed.page = 2
      if (change === 'omit-page') delete (changed as { page?: number }).page
      if (change === 'locator') changed.locator = 'Another section'
      if (change === 'omit-locator') delete (changed as { locator?: string }).locator
      const graph = { ...f.input.graph, claims: f.input.graph.claims.map((entry) => entry.id === claim.id
        ? { ...entry, citations: [verified] } : entry) }
      const snapshots = f.input.run.request.manifest.sources.map((entry) => ({ ...entry, pageCount: 2 }))
      const run = { ...f.input.run, request: { ...f.input.run.request, manifest: { ...f.input.run.request.manifest,
        sources: [...snapshots, { ...snapshots[0]!, sourceId: 'another-valid-source' }] } } }
      const envelope = { version: 1, schemaVersion: 1, id: 'citation-identity-artifact', runId: f.runId, docId: f.input.docId,
        kind: 'summary', sourceContentHashes: graph.sourceContentHashes, createdAt: 1, updatedAt: 1,
        payload: summaryPayload(claim.id, changed) }
      try {
        validateGeneratedArtifact({ artifact: envelope, expectedKind: 'summary', run, graph })
        throw new Error('changed citation identity was accepted')
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactValidationError)
        if (!(error instanceof ArtifactValidationError)) throw error
        expect(error.issues).toContainEqual(expect.objectContaining({ code: 'citation_unverified',
          message: 'source citation is not backed by the referenced evidence' }))
      }
    },
  )

  it('does not accept an invented quote against a legacy v1 graph that supplied none', async () => {
    const f = await prepare('legacy-citation-no-invented-quote')
    const claim = f.input.graph.claims[0]!
    const source = claim.citations[0]!
    if (source.provenance !== 'source') throw new Error('expected source citation')
    const legacyCitation = { ...source }
    delete legacyCitation.quote
    const graph = { ...f.input.graph, promptVersion: 'evidence-map-v1',
      claims: f.input.graph.claims.map((entry) => entry.id === claim.id ? { ...entry, citations: [legacyCitation] } : entry) }
    const envelope = { version: 1, schemaVersion: 1, id: 'legacy-citation-artifact', runId: f.runId, docId: f.input.docId,
      kind: 'summary', sourceContentHashes: graph.sourceContentHashes, createdAt: 1, updatedAt: 1,
      payload: summaryPayload(claim.id, legacyCitation) }
    expect(validateGeneratedArtifact({ artifact: envelope, expectedKind: 'summary', run: f.input.run, graph }))
      .toMatchObject({ id: 'legacy-citation-artifact' })
    expect(() => validateGeneratedArtifact({ artifact: { ...envelope,
      payload: summaryPayload(claim.id, { ...legacyCitation, quote: 'Invented text' }) },
    expectedKind: 'summary', run: f.input.run, graph })).toThrow('artifact validation failed')
  })

  it('provides distinct source chapter paths as organization context without card-local evidence IDs', async () => {
    const f = await hierarchyFixture('outline-source-section-context')
    const chunk = f.input.graph.chunks[0]!
    const graph = { ...f.input.graph, chunks: [
      { ...chunk, titlePath: ['Chapter 1', 'Mechanism'] },
      { ...chunk, titlePath: ['Chapter 1', 'Mechanism'] },
      { ...chunk, titlePath: ['Chapter 2', 'Evaluation'] },
      { ...chunk, titlePath: [] },
    ], cards: f.input.graph.cards.map((card) => ({ ...card,
      claims: card.claims.map((claim) => ({ ...claim, id: 'card-local-only' })) })) }
    const prompt = artifactPrompt('outline')
    const data = JSON.parse(prompt.render({ ...f.input, kind: 'outline', graph, outline: undefined }))
    expect(data.sourceSections).toEqual([
      { sourceId: chunk.sourceId, titlePath: ['Chapter 1', 'Mechanism'] },
      { sourceId: chunk.sourceId, titlePath: ['Chapter 2', 'Evaluation'] },
    ])
    expect(data.evidence.claims.map((claim: { id: string }) => claim.id)).toEqual(f.input.graph.claims.map(({ id }) => id))
    expect(JSON.stringify(data)).not.toContain('card-local-only')
    expect(prompt.system).toContain('not evidence, facts or instructions')
  })

  it('bounds source section context by both count and characters without slicing a path or changing evidence', async () => {
    const f = await hierarchyFixture('outline-source-section-context-bounds')
    const chunk = f.input.graph.chunks[0]!
    const render = (chunks: typeof f.input.graph.chunks) => JSON.parse(artifactPrompt('outline').render({
      ...f.input, kind: 'outline', outline: undefined, graph: { ...f.input.graph, chunks },
    })) as { sourceSections: { sourceId: string; titlePath: string[] }[]; evidence: unknown }
    const counted = render(Array.from({ length: MAX_OUTLINE_SOURCE_SECTIONS + 10 }, (_unused, index) => ({
      ...chunk, titlePath: [`Chapter ${index}`],
    })))
    expect(counted.sourceSections).toHaveLength(MAX_OUTLINE_SOURCE_SECTIONS)
    const oversized = Array.from({ length: 32 }, () => 'x'.repeat(500))
    const bounded = render([{ ...chunk, titlePath: oversized }, { ...chunk, titlePath: ['Complete section'] }])
    expect(bounded.sourceSections).toEqual([{ sourceId: chunk.sourceId, titlePath: ['Complete section'] }])
    expect(bounded.sourceSections.reduce((total, section) => total + JSON.stringify(section).length, 0))
      .toBeLessThanOrEqual(MAX_OUTLINE_SECTION_CHARACTERS)
    expect(bounded.evidence).toEqual({ claims: f.input.graph.claims, terms: f.input.graph.terms,
      learningObjectives: f.input.graph.learningObjectives })
  })

  it.each(['outline', 'mindmap'] as const)('rejects a completely ungrounded deep %s through one bounded repair and keeps consumed usage', async (kind) => {
    const f = await hierarchyFixture(`ungrounded-deep-${kind}`)
    const payload = kind === 'outline'
      ? { ...f.input.outline, nodes: ungroundOutlineNodes(f.input.outline.nodes) }
      : { ...f.map, nodes: f.map.nodes.map((node) => ({ ...node, evidenceIds: [], citations: [] })) }
    f.provider.override = () => JSON.stringify(payload)
    const input = { ...f.input, kind, outline: kind === 'mindmap' ? f.input.outline : undefined,
      budget: planArtifactBudget(kind, f.input.options) }
    await expect(f.runtime.artifactGenerator.generate(input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual([`artifact-${kind}`, 'repair'])
    const repair = JSON.parse(f.provider.calls[2]!.userPrompt)
    const issues = JSON.parse(repair.failure) as { code: string; path: string }[]
    expect(issues.filter(({ code }) => code === 'evidence_missing')).toHaveLength(3)
    expect(issues.filter(({ code }) => code === 'citation_unverified')).toHaveLength(3)
    expect(f.provider.calls[2]!.maxOutputTokens).toBe(input.budget.maxOutputTokens)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.runId, kind)).toBeUndefined()
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 3,
      unresolvedCount: 0, usage: { inputTokens: 60, outputTokens: 30 } })
  })

  it.each(['outline', 'mindmap'] as const)('rejects a %s node whose citation is not supported by its otherwise valid evidence ID', async (kind) => {
    const f = await hierarchyFixture(`mismatched-node-support-${kind}`)
    const source = f.input.graph.claims[0]!.citations[0]!
    if (source.provenance !== 'source' || source.quote === undefined) throw new Error('expected quoted source fixture citation')
    const mismatch = { ...source, start: source.start + 1, quote: source.quote.slice(1) }
    const payload = kind === 'outline'
      ? { ...f.input.outline, nodes: [{ ...f.input.outline.nodes[0]!, citations: [mismatch] }] }
      : { ...f.map, nodes: f.map.nodes.map((node) => node.id === 'storage' ? { ...node, citations: [mismatch] } : node) }
    const artifact = { version: 1, schemaVersion: 1, id: 'invalid-node-support', runId: f.runId,
      docId: f.input.docId, kind, sourceContentHashes: f.input.graph.sourceContentHashes, createdAt: 1, updatedAt: 1, payload }
    try {
      validateGeneratedArtifact({ artifact, expectedKind: kind, run: f.input.run, graph: f.input.graph,
        outline: f.input.outline, enforceNodeGrounding: true })
      throw new Error('unsupported citation was accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError)
      if (!(error instanceof ArtifactValidationError)) throw error
      expect(error.issues).toContainEqual(expect.objectContaining({ code: 'citation_unverified',
        message: 'source citation is not backed by the referenced evidence' }))
    }
  })

  it.each(['outline', 'mindmap'] as const)('rejects a %s node with a source citation but an unknown evidence ID', async (kind) => {
    const f = await hierarchyFixture(`unknown-node-support-${kind}`)
    const payload = kind === 'outline'
      ? { ...f.input.outline, nodes: [{ ...f.input.outline.nodes[0]!, evidenceIds: ['not-provided'] }] }
      : { ...f.map, nodes: f.map.nodes.map((node) => node.id === 'storage' ? { ...node, evidenceIds: ['not-provided'] } : node) }
    const artifact = { version: 1, schemaVersion: 1, id: 'invalid-evidence-support', runId: f.runId,
      docId: f.input.docId, kind, sourceContentHashes: f.input.graph.sourceContentHashes, createdAt: 1, updatedAt: 1, payload }
    expect(() => validateGeneratedArtifact({ artifact, expectedKind: kind, run: f.input.run,
      graph: f.input.graph, outline: f.input.outline, enforceNodeGrounding: true }))
      .toThrow('artifact validation failed')
  })

  it('allows a plain document title root while requiring each individual knowledge node to be grounded', async () => {
    const f = await hierarchyFixture('mindmap-title-root-grounding')
    const payload = { ...f.map, nodes: f.map.nodes.map((node) => node.parentId === null
      ? { ...node, evidenceIds: [], citations: [] } : node) }
    f.provider.override = () => JSON.stringify(payload)
    const result = await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    if (result.artifact.kind !== 'mindmap') throw new Error('expected MindMap artifact')
    expect(result.artifact.payload.nodes).toHaveLength(4)
    expect(result.artifact.payload.nodes[0]).toMatchObject({ text: f.map.title, evidenceIds: [], citations: [] })
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-mindmap'])
    const ungroundedLeaf = { ...result.artifact, payload: { ...result.artifact.payload,
      nodes: result.artifact.payload.nodes.map((node) => node.id === 'storage' ? { ...node, evidenceIds: [], citations: [] } : node) } }
    expect(() => validateGeneratedArtifact({ artifact: ungroundedLeaf, expectedKind: 'mindmap', run: f.input.run,
      graph: f.input.graph, outline: f.input.outline, enforceNodeGrounding: true })).toThrow('artifact validation failed')
    const rootClaim = { ...result.artifact, payload: { ...result.artifact.payload,
      nodes: result.artifact.payload.nodes.map((node) => node.parentId === null ? { ...node, text: 'An unsupported assertion' } : node) } }
    expect(() => validateGeneratedArtifact({ artifact: rootClaim, expectedKind: 'mindmap', run: f.input.run,
      graph: f.input.graph, outline: f.input.outline, enforceNodeGrounding: true })).toThrow('artifact validation failed')
    const rootNote = { ...result.artifact, payload: { ...result.artifact.payload,
      nodes: result.artifact.payload.nodes.map((node) => node.parentId === null ? { ...node, note: 'An unsupported root note' } : node) } }
    expect(() => validateGeneratedArtifact({ artifact: rootNote, expectedKind: 'mindmap', run: f.input.run,
      graph: f.input.graph, outline: f.input.outline, enforceNodeGrounding: true })).toThrow('artifact validation failed')
  })

  it.each(['outline', 'mindmap'] as const)('retains stored v1 %s reads but enforces node support under a persisted v2 route', async (kind) => {
    const f = await hierarchyFixture(`legacy-node-grounding-${kind}`)
    const payload = kind === 'outline'
      ? { ...f.input.outline, nodes: ungroundOutlineNodes(f.input.outline.nodes) }
      : { ...f.map, nodes: f.map.nodes.map((node) => ({ ...node, evidenceIds: [], citations: [] })) }
    const artifact = { version: 1, schemaVersion: 1, id: 'legacy-support-artifact', runId: f.runId,
      docId: f.input.docId, kind, sourceContentHashes: f.input.graph.sourceContentHashes, createdAt: 1, updatedAt: 1, payload }
    const base = { artifact, expectedKind: kind, run: f.input.run, graph: f.input.graph, outline: f.input.outline }
    expect(validateGeneratedArtifact(base)).toMatchObject({ id: 'legacy-support-artifact' })
    const run = { ...f.input.run, providerRoutes: [...f.input.run.providerRoutes, {
      providerId: f.provider.id, modelId: f.provider.modelId, profileVersion: f.provider.profileVersion,
      promptVersion: kind === 'outline' ? OUTLINE_HIERARCHY_PROMPT_VERSION : MINDMAP_HIERARCHY_PROMPT_VERSION,
    }] }
    expect(() => validateGeneratedArtifact({ ...base, run })).toThrow('artifact validation failed')
  })

  it('uses a distinct hierarchy prompt and deterministically preserves a deep Outline without another paid repair', async () => {
    const f = await hierarchyFixture('mindmap-preserve-hierarchy')
    f.provider.override = () => JSON.stringify(f.map)
    const result = await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    if (result.artifact.kind !== 'mindmap') throw new Error('expected MindMap artifact')
    expect(result.route.promptVersion).toBe(MINDMAP_HIERARCHY_PROMPT_VERSION)
    expect(artifactPrompt('outline').version).toBe(OUTLINE_HIERARCHY_PROMPT_VERSION)
    expect(artifactPrompt('summary').version).toBe(ARTIFACT_PROMPT_VERSION)
    expect(result.artifact.payload.nodes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['document-root', null], ['mechanism', 'document-root'], ['input', 'mechanism'], ['storage', 'input'],
    ])
    expect(result.artifact.payload.nodes[2]!.note).toBe('Supported input')
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-mindmap'])
    const prompt = JSON.parse(f.provider.calls[1]!.userPrompt)
    expect(prompt.outlineHierarchy).toEqual([
      { id: 'mechanism', parentOutlineId: null, title: 'Mechanism' },
      { id: 'input', parentOutlineId: 'mechanism', title: 'Light input' },
      { id: 'storage', parentOutlineId: 'input', title: 'Stored chemical energy' },
    ])
  })

  it('repairs an ID mismatch once using actionable hierarchy failures rather than guessing titles', async () => {
    const f = await hierarchyFixture('mindmap-repair-identity')
    const wrong = { ...f.map, nodes: f.map.nodes.map((node) => node.id === 'input' ? { ...node, id: 'renamed-input' } : node) }
    f.provider.override = (request) => JSON.stringify(request.role === 'repair' ? f.map : wrong)
    const result = await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    expect(result.artifact.kind).toBe('mindmap')
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-mindmap', 'repair'])
    const repair = JSON.parse(f.provider.calls[2]!.userPrompt)
    expect(repair.failure).toContain('hierarchy_invalid')
    expect(repair.failure).toContain('preserve its exact ID')
    expect(f.provider.calls[2]!.maxOutputTokens).toBe(f.input.budget.maxOutputTokens)
  })

  it('keeps relation grounding validation after deterministic reparenting and retains failed usage', async () => {
    const f = await hierarchyFixture('mindmap-relation-grounding')
    f.map.relations = [{ id: 'unsupported-relation', from: 'input', to: 'storage', label: 'causes',
      evidenceIds: ['unprovided-evidence'], citations: f.input.graph.claims[0]!.citations }]
    f.provider.override = () => JSON.stringify(f.map)
    await expect(f.runtime.artifactGenerator.generate(f.input, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: 'artifact_output_invalid', retryable: false })
    expect(f.provider.calls.slice(1).map(({ role }) => role)).toEqual(['artifact-mindmap', 'repair'])
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.runId, 'mindmap')).toBeUndefined()
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 3,
      unresolvedCount: 0, usage: { inputTokens: 60, outputTokens: 30 } })
  })

  it('requires source support for a new hierarchy cross relation and preserves a supported connection', async () => {
    const f = await hierarchyFixture('mindmap-source-supported-relation')
    const relation = { id: 'conversion', from: 'input', to: 'storage', label: 'converted to',
      evidenceIds: [f.input.graph.claims[0]!.id], citations: f.input.graph.claims[0]!.citations }
    f.provider.override = () => JSON.stringify({ ...f.map, relations: [relation] })
    const result = await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    if (result.artifact.kind !== 'mindmap') throw new Error('expected MindMap artifact')
    expect(result.artifact.payload.relations).toEqual([relation])
    const ungrounded = { ...result.artifact, payload: { ...result.artifact.payload, relations: [{ ...relation, evidenceIds: [], citations: [] }] } }
    expect(() => validateGeneratedArtifact({ artifact: ungrounded, expectedKind: 'mindmap', run: f.input.run,
      graph: f.input.graph, outline: f.input.outline, enforceOutlineHierarchy: true })).toThrow('artifact validation failed')
  })

  it('preserves stored v1 result validation while applying the new policy to new generation', async () => {
    const f = await hierarchyFixture('mindmap-legacy-result')
    const artifact = { version: 1, schemaVersion: 1, id: 'legacy-artifact', runId: f.runId, docId: f.input.docId,
      kind: 'mindmap', sourceContentHashes: f.input.graph.sourceContentHashes, createdAt: 1, updatedAt: 1, payload: f.map }
    const input = { artifact, expectedKind: 'mindmap' as const, run: f.input.run, graph: f.input.graph, outline: f.input.outline }
    expect(validateGeneratedArtifact(input)).toMatchObject({ id: 'legacy-artifact' })
    expect(() => validateGeneratedArtifact({ ...input, enforceOutlineHierarchy: true })).toThrow('artifact validation failed')
  })
  it('caps both generation and repair at the selected provider per-call output limit', async () => {
    const f = await prepare('provider-output-limit')
    f.provider.capabilities.maxOutputTokens = 4096
    const runtime = createAnalysisProviderRuntime({ store: f.store, provider: f.provider, broker: f.service.broker,
      leaseMs: 1000, estimateCostMicros: () => 3 })
    f.provider.override = (request) => request.role === 'repair' ? f.provider.output(request) : 'synthetic-invalid-output'
    const result = await runtime.artifactGenerator.generate({ ...f.input, budget: { ...f.input.budget, maxOutputTokens: 5000 } }, new AbortController().signal)
    expect(result.artifact.kind).toBe('summary')
    expect(f.provider.calls.slice(1).map((call) => call.maxOutputTokens)).toEqual([4096, 4096])
  })
  it.each([5, 10, 20, 100])('generates %i questions with all three types through the complete Quiz pipeline', async (questionCount) => {
    const store = new InMemoryJobStore()
    const prepared = await prepareFixtureRun(store, `quiz-${questionCount}`, Date.now, ['quiz'], questionCount)
    const provider = new FakeAnalysisProvider()
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 1000, estimateCostMicros: () => 1 })
    await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'quiz-evidence', new AbortController().signal)
    expect((await runtime.artifacts.runOnce(FIXTURE_TENANT, prepared.runId, 'quiz-artifact', new AbortController().signal)).run.status).toBe('succeeded')
    const artifact = await prepared.service.getArtifact(FIXTURE_TENANT, prepared.runId, 'quiz')
    if (artifact.kind !== 'quiz') throw new Error('expected Quiz artifact')
    expect(artifact.payload.questions).toHaveLength(questionCount)
    expect(new Set(artifact.payload.questions.map((question) => question.type))).toEqual(new Set(['true-false', 'multiple-choice', 'short-answer']))
    expect(provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'artifact-quiz'])
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 0 })
  })

  it('requires grounded inference under a distinct Knowledge policy and repairs once using that policy', async () => {
    const f = await prepare('grounded-inference-policy')
    const claim = f.input.graph.claims[0]!
    const item = { id: 'inference-1', title: 'Derived application', explanation: 'A synthetic inference grounded in the source.',
      relationship: 'application', provenance: 'inference', evidenceIds: [claim.id],
      citations: [...claim.citations, { version: 1, provenance: 'inference', label: 'Derived from the cited source' }] }
    f.provider.override = (request) => JSON.stringify({ items: [request.role === 'repair' ? item : {
      ...item, evidenceIds: [], citations: [{ version: 1, provenance: 'inference', label: 'unsupported model inference' }],
    }] })
    const result = await f.runtime.artifactGenerator.generate({ ...f.input, kind: 'knowledge', budget: planArtifactBudget('knowledge', f.input.options) }, new AbortController().signal)
    expect(result.artifact.kind).toBe('knowledge')
    expect(f.provider.calls.slice(1).map((call) => call.role)).toEqual(['artifact-knowledge', 'repair'])
    expect(result.route.promptVersion).toBe(KNOWLEDGE_GROUNDING_POLICY_VERSION)
    expect((await f.store.getProviderInvocation(FIXTURE_TENANT, f.provider.calls[1]!.invocationId))?.promptVersion).toBe(KNOWLEDGE_GROUNDING_POLICY_VERSION)
    expect(artifactPrompt('knowledge').version).not.toBe(artifactPrompt('summary').version)
    expect(artifactPrompt('knowledge').system).toContain('at least one supplied evidence ID')
    expect(repairPrompt.system).toContain('supporting source citation')
  })

  it('does not enter repair or send another transport after an ambiguous Artifact invocation', async () => {
    const f = await prepare('unknown-artifact-no-repair')
    f.provider.override = () => { throw new ProviderGatewayError({ providerId: f.provider.id, kind: 'outcome_unknown', retryable: false, safeCode: 'response_lost' }) }
    await expect(f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ kind: 'outcome_unknown', retryable: false })
    expect(f.provider.calls.slice(1).map((call) => call.role)).toEqual(['artifact-summary'])
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 1 })
  })

  it('repairs Evidence JSON in a separate invocation and validates it through the pipeline', async () => {
    const store = new InMemoryJobStore()
    const { service, runId } = await prepareFixtureRun(store, 'evidence-repair', Date.now, ['summary'])
    const provider = new FakeAnalysisProvider()
    provider.override = (request) => request.role === 'evidence-map' ? 'malformed-evidence' : provider.output(request)
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    expect((await runtime.evidence.runOnce(FIXTURE_TENANT, runId, 'worker', new AbortController().signal)).outcome).toBe('completed')
    expect(provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(provider.calls[1]?.maxOutputTokens).toBe(provider.calls[0]!.maxOutputTokens)
    expect((await store.getProviderInvocation(FIXTURE_TENANT, provider.calls[1]!.invocationId))?.promptVersion).toBe(EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION)
    expect((await store.getRunLedgerUsage(FIXTURE_TENANT, runId))?.usage.inputTokens).toBe(40)
  })
  it('retains both fully consumed Evidence usages and stops after one repair', async () => {
    const store = new InMemoryJobStore()
    const prepared = await prepareFixtureRun(store, 'evidence-output-cap', Date.now, ['summary'])
    const provider = new FakeAnalysisProvider()
    vi.spyOn(provider, 'generate').mockImplementation(async (request) => {
      provider.calls.push(request)
      return { outputText: 'synthetic-malformed-output', usage: { inputTokens: 20, outputTokens: request.maxOutputTokens } }
    })
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: prepared.service.broker, leaseMs: 1000, estimateCostMicros: () => 3 })
    expect(await runtime.evidence.runOnce(FIXTURE_TENANT, prepared.runId, 'cap-map', new AbortController().signal))
      .toMatchObject({ outcome: 'failed', run: { error: { retryable: false } } })
    expect(provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair'])
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, prepared.runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 0,
      usage: { inputTokens: 40, outputTokens: provider.calls[0]!.maxOutputTokens * 2 } })
  })
  it('persists five validated artifacts through DAG and ledger without repeat calls', async () => {
    const f = await prepare('five-artifacts')
    expect((await f.runtime.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'artifact-owner', new AbortController().signal)).run.status).toBe('succeeded')
    expect((await f.store.listArtifactDescriptors(FIXTURE_TENANT, f.runId))?.length).toBe(5)
    expect(f.provider.calls.map((call) => call.role)).toEqual(['evidence-map', 'artifact-summary', 'artifact-outline', 'artifact-quiz', 'artifact-knowledge', 'artifact-mindmap'])
    const usage = await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)
    expect(usage).toMatchObject({ invocationCount: 6, unresolvedCount: 0,
      estimatedInputTokens: expect.any(Number), reservedOutputTokens: expect.any(Number),
      usage: { inputTokens: 120, outputTokens: 60, estimatedCostMicros: 18, currency: 'USD' } })
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).usage).toEqual(usage?.usage)
    await f.runtime.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'restart-owner', new AbortController().signal)
    expect(f.provider.calls.length).toBe(6)
    expect(await f.store.getRunLedgerUsage('other-tenant', f.runId)).toBeUndefined()
  })
  it('commits a near-cap repaired Outline and unblocks MindMap without replaying the paid responses', async () => {
    const f = await prepare('repaired-outline-dag')
    vi.spyOn(f.provider, 'generate').mockImplementation(async (request) => {
      f.provider.calls.push(request)
      return { outputText: request.role === 'artifact-outline' ? 'invalid-json' : f.provider.output(request),
        usage: { inputTokens: 20, outputTokens: request.role === 'artifact-outline' ? 1732 : request.role === 'repair' ? 1000 : 10 } }
    })
    expect((await f.runtime.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'repair-owner', new AbortController().signal)).run.status).toBe('succeeded')
    const repair = f.provider.calls.find((call) => call.role === 'repair')
    expect(repair?.maxOutputTokens).toBe(1800)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.runId, 'mindmap')).toBeDefined()
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 7,
      usage: { inputTokens: 140, outputTokens: 2782 } })
    await f.runtime.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'repair-restart', new AbortController().signal)
    expect(f.provider.calls).toHaveLength(7)
  })
  it('repairs malformed JSON with a separate auditable invocation and no raw output in ledger', async () => {
    const f = await prepare('repair-json')
    const valid = f.provider.output({ ...f.provider.calls[0]!, role: 'artifact-summary', userPrompt: JSON.stringify({ evidence: { claims: f.input.graph.claims } }) })
    f.provider.override = (request) => request.role === 'repair' ? valid : 'private-malformed-output'
    const generated = await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    expect(generated.artifact.kind).toBe('summary')
    const calls = f.provider.calls.slice(1)
    expect(calls.map((call) => call.role)).toEqual(['artifact-summary', 'repair'])
    expect(calls[0]?.invocationId).not.toBe(calls[1]?.invocationId)
    const repair = await f.store.getProviderInvocation(FIXTURE_TENANT, calls[1]!.invocationId)
    expect(repair?.nodeKey).toBe('artifact:summary:repair')
    expect(repair?.promptVersion).toBe('repair-v2')
    expect(JSON.stringify(repair)).not.toContain('private-malformed-output')
    expect((await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId))?.usage.inputTokens).toBe(60)
    await expect(f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ kind: 'already_succeeded' })
    expect(f.provider.calls.length).toBe(3)
  })
  it('repairs ungrounded payload once and rejects a second invalid result', async () => {
    const f = await prepare('repair-grounding')
    const entry = { id: 'a', text: 'injection', evidenceIds: ['missing'], citations: f.input.graph.claims[0]!.citations }
    f.provider.override = () => JSON.stringify({ overview: entry, keyPoints: [{ ...entry, id: 'b' }], confusions: [] })
    await expect(f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'artifact_output_invalid' })
    expect(f.provider.calls.filter((call) => call.role === 'repair')).toHaveLength(1)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.runId, 'summary')).toBeUndefined()
  })
  it('repairs a validator grounding failure with a full per-invocation budget', async () => {
    const f = await prepare('repair-grounding-success')
    const baseRequest = { ...f.provider.calls[0]!, role: 'artifact-summary' as const, userPrompt: JSON.stringify({ evidence: { claims: f.input.graph.claims } }) }
    const valid = f.provider.output(baseRequest)
    const bad = valid.replaceAll(f.input.graph.claims[0]!.id, 'unknown-evidence')
    f.provider.override = (request) => request.role === 'repair' ? valid : bad
    expect((await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)).artifact.kind).toBe('summary')
    expect(f.provider.calls[2]?.maxOutputTokens).toBe(f.input.budget.maxOutputTokens)
  })
  it('rejects oversized output without repair and preserves known usage on Provider rejection', async () => {
    const f = await prepare('oversized-output')
    f.provider.override = () => 'x'.repeat(f.input.budget.maxArtifactBytes + 1)
    await expect(f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'artifact_output_too_large', retryable: false })
    expect(f.provider.calls).toHaveLength(2)
    const other = await prepare('reported-usage-over-limit')
    vi.spyOn(other.provider, 'generate').mockResolvedValueOnce({ outputText: 'unused', usage: { inputTokens: 4, outputTokens: other.input.budget.maxOutputTokens + 1 } })
    await expect(other.runtime.artifactGenerator.generate(other.input, new AbortController().signal)).rejects.toMatchObject({ safeCode: 'reported_output_tokens_exceeded' })
    expect((await other.store.getRunLedgerUsage(FIXTURE_TENANT, other.runId))?.usage).toMatchObject({ inputTokens: 24, outputTokens: other.input.budget.maxOutputTokens + 11 })
  })
  it('never invokes a provider for an already aborted adapter request', async () => {
    const f = await prepare('aborted-artifact')
    const controller = new AbortController()
    controller.abort()
    await expect(f.runtime.artifactGenerator.generate(f.input, controller.signal)).rejects.toMatchObject({ safeCode: 'caller_aborted' })
    expect(f.provider.calls).toHaveLength(1)
  })
  it('rejects inconsistent identity and missing Outline before any billable invocation', async () => {
    const f = await prepare('invalid-scheduled-context')
    await expect(f.runtime.artifactGenerator.generate({ ...f.input, docId: 'other-document' }, new AbortController().signal)).rejects.toMatchObject({ name: 'ArtifactValidationError' })
    await expect(f.runtime.artifactGenerator.generate({ ...f.input, kind: 'mindmap' }, new AbortController().signal)).rejects.toMatchObject({ name: 'ArtifactValidationError' })
    expect(f.provider.calls).toHaveLength(1)
  })
  it('accounts successful generation before artifact commit and retains unknown reservations', async () => {
    const f = await prepare('usage-crash-window')
    await f.runtime.artifactGenerator.generate(f.input, new AbortController().signal)
    expect(await f.store.getArtifact(FIXTURE_TENANT, f.runId, 'summary')).toBeUndefined()
    expect((await f.service.getRun(FIXTURE_TENANT, f.runId)).usage.inputTokens).toBe(40)
    const id = createStableInvocationId({ runId: f.runId, nodeKey: 'crash', runAttempt: 1, role: 'repair' })
    const reservation = { tenantId: FIXTURE_TENANT, runId: f.runId, invocationId: id, nodeKey: 'crash', runAttempt: 1, role: 'repair' as const,
      providerId: f.provider.id, modelId: f.provider.modelId, profileVersion: f.provider.profileVersion, promptVersion: 'repair-v1',
      estimatedInputTokens: 2, reservedOutputTokens: 2, estimatedCostMicros: 7, maxRunEstimatedTokens: 100000, maxRunEstimatedCostMicros: 1000, staleAfterMs: 10, now: Date.now() }
    await f.store.reserveProviderInvocation(reservation)
    await f.store.reserveProviderInvocation({ ...reservation, now: reservation.now + 11 })
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 3, unresolvedCount: 1, usage: { inputTokens: 40, estimatedCostMicros: 13 } })
  })
})
