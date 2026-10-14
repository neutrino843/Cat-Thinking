import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_KINDS, collectArtifactCitations } from '@cat-thinking/analysis-contracts'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import {
  verifyPersonalLearningPipeline, PERSONAL_LEARNING_VERIFICATION_LIMITS, PERSONAL_LEARNING_VERIFICATION_SAMPLE,
  PERSONAL_VERIFICATION_LIMITS, type PersonalLearningVerificationResult,
} from '../src/operations/personalProviderVerification.js'
import type { ModelProvider, ModelRequest } from '../src/providers/modelProvider.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { MemoryPersonalProfileStore, personalFixtureSettings } from './fixtures/personalProviderFixture.js'

const prepare = async () => {
  const store = new InMemoryJobStore()
  const profiles = new MemoryPersonalProfileStore(store)
  await profiles.save(0, personalFixtureSettings())
  await profiles.setCheck(1, 'ready')
  await profiles.setEnabled(2, true)
  const state = await profiles.readState()
  const fake = new FakeAnalysisProvider()
  const calls: ModelRequest[] = []
  let override: ((request: ModelRequest, signal: AbortSignal) => string | Promise<string>) | undefined
  const createProvider = (snapshot: { id: string }): ModelProvider => ({
    id: fake.id, modelId: fake.modelId, profileVersion: snapshot.id, capabilities: fake.capabilities,
    isReady: () => true,
    generate: async (request, signal) => {
      calls.push(request)
      return { outputText: override ? await override(request, signal) : fake.output(request),
        usage: { inputTokens: 20, outputTokens: 10 } }
    },
  })
  return { store, profiles, fake, calls, state, createProvider,
    override: (value: typeof override) => { override = value } }
}
type Fixture = Awaited<ReturnType<typeof prepare>>
const expectOnlyOwnContentCleared = async (f: Fixture, result: PersonalLearningVerificationResult) => {
  expect(result.cleanupComplete).toBe(true)
  const run = (await f.store.getRun(result.tenantId!, result.runId!))!
  expect(run.request.artifacts).toEqual(ARTIFACT_KINDS)
  expect(run.request.options.quizQuestionCount).toBe(5)
  expect(await f.store.getSourceContent(result.tenantId!, result.runId!, run.request.manifest.sources[0]!.sourceId)).toBeUndefined()
  expect(await f.store.getEvidenceGraph(result.tenantId!, result.runId!)).toBeUndefined()
  for (const kind of ARTIFACT_KINDS) expect(await f.store.getArtifact(result.tenantId!, result.runId!, kind)).toBeUndefined()
  expect(await f.store.getRunLedgerUsage(result.tenantId!, result.runId!)).toMatchObject({
    invocationCount: result.invocationCount, unresolvedCount: result.unresolvedCount,
  })
}

describe('separate bounded five-artifact learning verification', () => {
  it('validates all five artifacts in six calls while preserving profile, old work and the old three-request gate', async () => {
    const f = await prepare()
    const old = await prepareFixtureRun(f.store, 'unrelated-old-learning-run')
    const oldRun = await f.store.getRun(FIXTURE_TENANT, old.runId)
    const oldSource = await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')
    const discover = vi.spyOn(f.store, 'listDispatchableRuns')
    const personalDiscover = vi.spyOn(f.profiles, 'listDispatchableRuns')
    const expired = vi.spyOn(f.store, 'listExpiredRuns')
    const deleted = vi.spyOn(f.store, 'deleteContent')
    const mutators = [vi.spyOn(f.profiles, 'save'), vi.spyOn(f.profiles, 'setCheck'),
      vi.spyOn(f.profiles, 'setEnabled'), vi.spyOn(f.profiles, 'clear'), vi.spyOn(f.profiles, 'revokeHistoricSecrets')]
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ kind: 'personal-learning-pipeline-verification', version: 1,
      outcome: 'passed', callsUsed: 6, limit: 8, evidenceValidated: true, notProductionAttestation: true,
      pricingKnown: false, profileStateUnchanged: true, invocationCount: 6, unresolvedCount: 0,
      usage: { inputTokens: 120, outputTokens: 60 }, failures: [] })
    expect(Object.keys(result.artifacts).sort()).toEqual([...ARTIFACT_KINDS].sort())
    expect(result.artifacts.quiz?.questions).toHaveLength(5)
    expect(f.calls.map(({ role }) => role)).toEqual([
      'evidence-map', 'artifact-summary', 'artifact-outline', 'artifact-quiz', 'artifact-knowledge', 'artifact-mindmap',
    ])
    expect(f.calls.every(({ maxOutputTokens }) => maxOutputTokens <= 4096)).toBe(true)
    expect(PERSONAL_LEARNING_VERIFICATION_SAMPLE.length).toBeGreaterThanOrEqual(1000)
    expect(PERSONAL_LEARNING_VERIFICATION_SAMPLE.length).toBeLessThanOrEqual(2000)
    expect(PERSONAL_VERIFICATION_LIMITS).toEqual({ requests: 3, outputTokens: 4096, deadlineMs: 120000 })
    expect(PERSONAL_LEARNING_VERIFICATION_LIMITS).toEqual({ requests: 8, outputTokens: 4096, deadlineMs: 180000 })
    const evidencePrompt = JSON.parse(f.calls[0]!.userPrompt.slice(f.calls[0]!.userPrompt.indexOf('\n') + 1))
    expect(evidencePrompt.excerpts.map(({ text }: { text: string }) => text).join('')).toBe(PERSONAL_LEARNING_VERIFICATION_SAMPLE)
    const run = (await f.store.getRun(result.tenantId!, result.runId!))!
    for (const kind of ARTIFACT_KINDS) {
      const payload = result.artifacts[kind]!
      const citations = collectArtifactCitations({ version: 1, schemaVersion: 1, id: 'receipt-artifact',
        runId: result.runId!, docId: run.docId, kind, payload, sourceContentHashes: run.request.manifest.sources.map(({ contentHash }) => contentHash),
        createdAt: 1, updatedAt: 1 } as Parameters<typeof collectArtifactCitations>[0])
      for (const citation of citations) if (citation.provenance === 'source') {
        expect(citation.quote).toBe(PERSONAL_LEARNING_VERIFICATION_SAMPLE.slice(citation.start, citation.end))
      }
    }
    expect(await f.profiles.readState()).toEqual(f.state)
    expect(await f.store.getRun(FIXTURE_TENANT, old.runId)).toEqual(oldRun)
    expect(await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')).toEqual(oldSource)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, old.runId)).toMatchObject({ invocationCount: 0 })
    expect(discover).not.toHaveBeenCalled()
    expect(personalDiscover).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
    expect(deleted.mock.calls).toEqual([[result.tenantId, result.runId]])
    for (const mutator of mutators) expect(mutator).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('synthetic-personal-key')
    expect(JSON.stringify(result)).not.toContain('http://127.0.0.1:9876')
    await expectOnlyOwnContentCleared(f, result)
  })

  it('counts two independent repairs within the same eight-attempt authorization and completes all five', async () => {
    const f = await prepare()
    f.override((request) => ['artifact-summary', 'artifact-outline'].includes(request.role) ? 'invalid-json' : f.fake.output(request))
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'passed', callsUsed: 8, invocationCount: 8, limit: 8, unresolvedCount: 0,
      usage: { inputTokens: 160, outputTokens: 80 } })
    expect(f.calls.filter(({ role }) => role === 'repair')).toHaveLength(2)
    expect(Object.keys(result.artifacts)).toHaveLength(5)
    for (const repair of f.calls.filter(({ role }) => role === 'repair')) {
      const task = JSON.parse(repair.userPrompt).task
      const generation = f.calls.find(({ role }) => role === `artifact-${task}`)!
      expect(repair.maxOutputTokens).toBe(generation.maxOutputTokens - 10)
    }
    await expectOnlyOwnContentCleared(f, result)
  })

  it('stops before a ninth transport when three repairs consume the available calls', async () => {
    const f = await prepare()
    f.override((request) => ['artifact-summary', 'artifact-outline', 'artifact-quiz'].includes(request.role)
      ? 'invalid-json' : f.fake.output(request))
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'partial', callsUsed: 8, limit: 8, invocationCount: 8, unresolvedCount: 0 })
    expect(f.calls).toHaveLength(8)
    expect(result.artifacts.mindmap).toBeUndefined()
    expect(result.failures).toContainEqual({ stage: 'mindmap', code: 'budget_exceeded', retryable: false })
    await expectOnlyOwnContentCleared(f, result)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)('honors a smaller explicit limit of %i without inheriting old authorization', async (requestLimit) => {
    const f = await prepare()
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles,
      createProvider: f.createProvider, requestLimit })
    expect(result.limit).toBe(requestLimit)
    expect(result.callsUsed).toBe(Math.min(6, requestLimit))
    expect(f.calls).toHaveLength(Math.min(6, requestLimit))
    expect(result.outcome).toBe(requestLimit >= 6 ? 'passed' : 'partial')
    expect(result.invocationCount).toBe(Math.min(6, requestLimit))
    await expectOnlyOwnContentCleared(f, result)
  })

  it('rejects out-of-range, fractional and non-finite limits before provider construction or any store mutation', async () => {
    const f = await prepare()
    const createProvider = vi.fn(f.createProvider)
    const createRun = vi.spyOn(f.profiles, 'createRun')
    const readState = vi.spyOn(f.profiles, 'readState')
    for (const requestLimit of [0, -1, 9, 1.5, NaN, Infinity]) await expect(verifyPersonalLearningPipeline({
      store: f.store, profiles: f.profiles, createProvider, requestLimit: requestLimit as 1,
    })).rejects.toThrow('request limit')
    for (const deadlineMs of [0, -1, 180001, 1.5, NaN, Infinity]) await expect(verifyPersonalLearningPipeline({
      store: f.store, profiles: f.profiles, createProvider, deadlineMs,
    })).rejects.toThrow('deadline')
    expect(createProvider).not.toHaveBeenCalled()
    expect(createRun).not.toHaveBeenCalled()
    expect(readState).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
  })

  it('preserves one unknown paid outcome without repair, repeat, or unsafe provider detail in the receipt', async () => {
    const f = await prepare()
    f.override(() => { throw new ProviderGatewayError({ providerId: f.fake.id, kind: 'outcome_unknown',
      acceptance: 'accepted', retryable: false, safeCode: 'private_provider_response_detail' }) })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', callsUsed: 1, invocationCount: 1, unresolvedCount: 1,
      evidenceValidated: false, artifacts: {}, failures: [{ stage: 'evidence', retryable: false }] })
    expect(f.calls.map(({ role }) => role)).toEqual(['evidence-map'])
    expect(JSON.stringify(result)).not.toContain('private_provider_response_detail')
    await expectOnlyOwnContentCleared(f, result)
  })

  it('stops when the captured profile changes and preserves earlier user work and the invocation audit', async () => {
    const f = await prepare()
    const old = await prepareFixtureRun(f.store, 'old-on-profile-change')
    const original = await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')
    f.override(async (request) => {
      await f.profiles.setEnabled(f.state.revision, false)
      return f.fake.output(request)
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'profile_changed', callsUsed: 1,
      profileStateUnchanged: false, invocationCount: 1 })
    expect(f.calls).toHaveLength(1)
    expect((await f.profiles.readState()).enabled).toBe(false)
    expect(await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')).toEqual(original)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, old.runId)).toMatchObject({ invocationCount: 0 })
    await expectOnlyOwnContentCleared(f, result)
  })

  it('reports partial when cleanup fails even after all five artifacts passed validation', async () => {
    const f = await prepare()
    vi.spyOn(f.store, 'deleteContent').mockRejectedValue(new Error('private_cleanup_error'))
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'partial', reason: 'operation_failed', callsUsed: 6,
      cleanupComplete: false, profileStateUnchanged: true, invocationCount: 6, unresolvedCount: 0 })
    expect(Object.keys(result.artifacts)).toHaveLength(5)
    expect(JSON.stringify(result)).not.toContain('private_cleanup_error')
  })

  it('does not report success when Evidence disappears before final collection', async () => {
    const f = await prepare()
    const getGraph = f.store.getEvidenceGraph.bind(f.store)
    let completedReads = 0
    vi.spyOn(f.store, 'getEvidenceGraph').mockImplementation(async (tenantId, runId) => {
      const graph = await getGraph(tenantId, runId)
      const run = await f.store.getRun(tenantId, runId)
      if (graph && run?.status === 'succeeded' && ++completedReads > 1) return undefined
      return graph
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'partial', reason: 'operation_failed', callsUsed: 6,
      evidenceValidated: false, artifacts: {}, profileStateUnchanged: true })
    await expectOnlyOwnContentCleared(f, result)
  })

  it('checks a profile change during final cleanup rather than reporting a stale passed state', async () => {
    const f = await prepare()
    const deleteContent = f.store.deleteContent.bind(f.store)
    vi.spyOn(f.store, 'deleteContent').mockImplementation(async (tenantId, runId) => {
      const result = await deleteContent(tenantId, runId)
      await f.profiles.setEnabled(f.state.revision, false)
      return result
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'partial', reason: 'profile_changed', callsUsed: 6,
      cleanupComplete: true, profileStateUnchanged: false })
    expect((await f.profiles.readState()).enabled).toBe(false)
    await expectOnlyOwnContentCleared(f, result)
  })

  it.each(['revoked', 'settings-changed'] as const)('closes the original immutable snapshot gate when %s without trusting unchanged state metadata', async (scenario) => {
    const f = await prepare()
    f.override((request) => {
      const snapshot = f.profiles.snapshots.get(f.state.profileId!)!
      f.profiles.snapshots.set(snapshot.id, scenario === 'revoked' ? { ...snapshot, revoked: true }
        : { ...snapshot, settings: { ...snapshot.settings, baseUrl: 'http://127.0.0.1:9880/v1/' } })
      return f.fake.output(request)
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'profile_changed', callsUsed: 1,
      profileStateUnchanged: false, invocationCount: 1 })
    expect(f.calls).toHaveLength(1)
    expect(await f.profiles.readState()).toEqual(f.state)
    await expectOnlyOwnContentCleared(f, result)
  })

  it.each(['api-key', 'endpoint', 'escaped-key'] as const)('does not leak a %s in otherwise valid model output', async (scenario) => {
    const f = await prepare()
    let privateText = scenario === 'endpoint' ? personalFixtureSettings().baseUrl : personalFixtureSettings().apiKey!
    if (scenario === 'escaped-key') {
      privateText = 'synthetic"private\\key-not-real'
      await f.profiles.save(f.state.revision, { ...personalFixtureSettings(), apiKey: privateText })
      await f.profiles.setCheck(f.state.revision + 1, 'ready')
      await f.profiles.setEnabled(f.state.revision + 2, true)
    }
    f.override((request) => {
      const output = JSON.parse(f.fake.output(request))
      if (request.role === 'artifact-summary') output.payload.overview.text = privateText
      return JSON.stringify(output)
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'result_not_safe', callsUsed: 6, artifacts: {} })
    expect(JSON.stringify(result)).not.toContain(privateText)
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(privateText).slice(1, -1))
    await expectOnlyOwnContentCleared(f, result)
  })

  it('applies strict artifact validation again before emitting a receipt and still cleans the sample on rejection', async () => {
    const f = await prepare()
    const getArtifact = f.store.getArtifact.bind(f.store)
    vi.spyOn(f.store, 'getArtifact').mockImplementation(async (tenantId, runId, kind) => {
      const stored = await getArtifact(tenantId, runId, kind)
      if (stored?.artifact.kind !== 'summary') return stored
      return { ...stored, artifact: { ...stored.artifact, payload: { ...stored.artifact.payload,
        overview: { ...stored.artifact.payload.overview, citations: [{ version: 1, provenance: 'source',
          sourceId: 'invented-source', start: 0, end: 1, quote: 'invented' }] } } } }
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'operation_failed', artifacts: {}, callsUsed: 6 })
    expect(JSON.stringify(result)).not.toContain('invented-source')
    await expectOnlyOwnContentCleared(f, result)
  })

  it.each(['mindmap', 'quiz'] as const)('rechecks stored %s structural requirements before claiming five-artifact success', async (kind) => {
    const f = await prepare()
    const getArtifact = f.store.getArtifact.bind(f.store)
    vi.spyOn(f.store, 'getArtifact').mockImplementation(async (tenantId, runId, requested) => {
      const stored = await getArtifact(tenantId, runId, requested)
      if (kind === 'quiz' && stored?.artifact.kind === 'quiz') return { ...stored, artifact: { ...stored.artifact,
        payload: { ...stored.artifact.payload, questions: stored.artifact.payload.questions.slice(0, 4) } } }
      if (kind === 'mindmap' && stored?.artifact.kind === 'mindmap') return { ...stored, artifact: { ...stored.artifact,
        payload: { ...stored.artifact.payload, nodes: stored.artifact.payload.nodes.map((node) => node.parentId === null
          ? node : { ...node, text: 'Changed Outline identity' }) } } }
      return stored
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'operation_failed', callsUsed: 6, artifacts: {} })
    await expectOnlyOwnContentCleared(f, result)
  })

  it('enforces the generation deadline even when transport ignores abort and retains its unknown reservation', async () => {
    const f = await prepare()
    f.override(() => new Promise<string>(() => undefined))
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles, createProvider: f.createProvider, deadlineMs: 100 })
    expect(result).toMatchObject({ outcome: 'timed_out', reason: 'deadline_exceeded', callsUsed: 1,
      invocationCount: 1, unresolvedCount: 1, profileStateUnchanged: true })
    expect(f.calls).toHaveLength(1)
    await expectOnlyOwnContentCleared(f, result)
  })

  it('respects caller cancellation and never resumes the aborted transport', async () => {
    const f = await prepare()
    const controller = new AbortController()
    f.override(() => {
      controller.abort()
      return new Promise<string>(() => undefined)
    })
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles,
      createProvider: f.createProvider, signal: controller.signal })
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'interrupted', callsUsed: 1,
      invocationCount: 1, unresolvedCount: 1 })
    expect(f.calls).toHaveLength(1)
    await expectOnlyOwnContentCleared(f, result)
  })

  it('honors an already canceled learning request before constructing a Provider or creating a run', async () => {
    const f = await prepare()
    const controller = new AbortController()
    controller.abort()
    const createProvider = vi.fn(f.createProvider)
    const createRun = vi.spyOn(f.profiles, 'createRun')
    const result = await verifyPersonalLearningPipeline({ store: f.store, profiles: f.profiles,
      createProvider, signal: controller.signal })
    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'interrupted', callsUsed: 0,
      invocationCount: 0, cleanupComplete: true, profileStateUnchanged: true })
    expect(createProvider).not.toHaveBeenCalled()
    expect(createRun).not.toHaveBeenCalled()
    expect(result.runId).toBeUndefined()
  })
})
