import { describe, expect, it, vi } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import type { JobStore } from '../src/domain/jobStore.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { verifyPersonalProvider, PERSONAL_VERIFICATION_SAMPLE } from '../src/operations/personalProviderVerification.js'
import type { ModelProvider, ModelRequest } from '../src/providers/modelProvider.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
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
  let override: ((request: ModelRequest, signal: AbortSignal) => Promise<string> | string) | undefined
  const createProvider = (snapshot: { id: string }): ModelProvider => ({
    id: fake.id, modelId: fake.modelId, profileVersion: snapshot.id, capabilities: fake.capabilities,
    isReady: () => true,
    generate: async (request, signal) => {
      calls.push(request)
      const outputText = override ? await override(request, signal) : fake.output(request)
      return { outputText, usage: { inputTokens: 20, outputTokens: 10 } }
    },
  })
  return { store, profiles, state, fake, calls, createProvider,
    override: (value: typeof override) => { override = value } }
}

const expectOwnContentCleared = async (f: Awaited<ReturnType<typeof prepare>>, result: Awaited<ReturnType<typeof verifyPersonalProvider>>) => {
  expect(result.cleanupComplete).toBe(true)
  const run = await f.store.getRun(result.tenantId!, result.runId!)
  expect(run).toBeDefined()
  const source = run!.request.manifest.sources[0]!
  expect(await f.store.getSourceContent(result.tenantId!, result.runId!, source.sourceId)).toBeUndefined()
  expect(await f.store.getEvidenceGraph(result.tenantId!, result.runId!)).toBeUndefined()
  expect(await f.store.getArtifact(result.tenantId!, result.runId!, 'summary')).toBeUndefined()
  expect(await f.store.getRunLedgerUsage(result.tenantId!, result.runId!)).toMatchObject({ invocationCount: result.invocationCount })
}

describe('bounded personal public-sample verification', () => {
  it('uses exactly Evidence + Summary + Outline through dispatcher and ledger while preserving profile state and an old queued user run', async () => {
    const f = await prepare()
    const old = await prepareFixtureRun(f.store, 'old-user-queued')
    const oldRun = await f.store.getRun(FIXTURE_TENANT, old.runId)
    const oldSource = await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')
    const boundStore = new Proxy(f.store, { get(target, property) {
      if (property === 'createRun') return f.profiles.createRun.bind(f.profiles)
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as JobStore
    const oldService = new RunService({ store: boundStore, retentionSeconds: 3600, providerProfileMode: 'personal' })
    const oldBound = await oldService.createRun(FIXTURE_TENANT, { ...fixtureRequest('old-personal-user-queued', ['summary']),
      providerProfileId: f.state.profileId })
    await oldService.uploadSource(FIXTURE_TENANT, oldBound.run.id, { version: 1, sourceId: 'synthetic-source',
      contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
      start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
    await oldService.startRun(FIXTURE_TENANT, oldBound.run.id, oldBound.run.revision)
    const beforeBound = await f.store.getRun(FIXTURE_TENANT, oldBound.run.id)
    const genericDiscovery = vi.spyOn(f.store, 'listDispatchableRuns')
    const personalDiscovery = vi.spyOn(f.profiles, 'listDispatchableRuns')
    const deletedContent = vi.spyOn(f.store, 'deleteContent')
    const forbidden = [vi.spyOn(f.profiles, 'save'), vi.spyOn(f.profiles, 'setCheck'), vi.spyOn(f.profiles, 'setEnabled'),
      vi.spyOn(f.profiles, 'clear'), vi.spyOn(f.profiles, 'revokeHistoricSecrets')]
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'passed', notProductionAttestation: true, callsUsed: 3, limit: 3,
      profileStateUnchanged: true, invocationCount: 3, unresolvedCount: 0, pricingKnown: false,
      usage: { inputTokens: 60, outputTokens: 30 }, artifacts: { summary: { overview: expect.any(Object) }, outline: { nodes: expect.any(Array) } }, failures: [] })
    expect(f.calls.map((call) => call.role)).toEqual(['evidence-map', 'artifact-summary', 'artifact-outline'])
    expect(f.calls.every((call) => call.maxOutputTokens <= 4096)).toBe(true)
    const envelope = JSON.parse(f.calls[0]!.userPrompt.slice(f.calls[0]!.userPrompt.indexOf('\n') + 1)) as {
      sourceText?: string; excerpts?: { text: string }[]
    }
    expect(envelope.excerpts?.map(({ text }) => text).join('') ?? envelope.sourceText).toBe(PERSONAL_VERIFICATION_SAMPLE)
    expect(await f.profiles.readState()).toEqual(f.state)
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled()
    expect(await f.store.getRun(FIXTURE_TENANT, old.runId)).toEqual(oldRun)
    expect(await f.store.getSourceContent(FIXTURE_TENANT, old.runId, 'synthetic-source')).toEqual(oldSource)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, old.runId)).toMatchObject({ invocationCount: 0 })
    expect(await f.store.getRun(FIXTURE_TENANT, oldBound.run.id)).toEqual(beforeBound)
    expect(await f.store.getSourceContent(FIXTURE_TENANT, oldBound.run.id, 'synthetic-source')).toEqual(oldSource)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, oldBound.run.id)).toMatchObject({ invocationCount: 0 })
    expect(genericDiscovery).not.toHaveBeenCalled()
    expect(personalDiscovery).not.toHaveBeenCalled()
    expect(deletedContent.mock.calls).toEqual([[result.tenantId, result.runId]])
    expect(JSON.stringify(result)).not.toContain('synthetic-personal-key')
    expect(JSON.stringify(result)).not.toContain('http://127.0.0.1:9876')
    await expectOwnContentCleared(f, result)
  })

  it('counts independent repair against the same three-request cap and never reports an ungenerated Outline as passed', async () => {
    const f = await prepare()
    f.override((request) => request.role === 'evidence-map' ? 'synthetic-invalid-evidence' : f.fake.output(request))
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'partial', callsUsed: 3, limit: 3, invocationCount: 3, unresolvedCount: 0,
      profileStateUnchanged: true, failures: [{ stage: 'outline', code: 'budget_exceeded', retryable: false }] })
    expect(f.calls.map((call) => call.role)).toEqual(['evidence-map', 'repair', 'artifact-summary'])
    expect(f.calls[1]!.maxOutputTokens).toBe(f.calls[0]!.maxOutputTokens)
    expect(result.artifacts.summary).toBeDefined()
    expect(result.artifacts.outline).toBeUndefined()
    expect(await f.profiles.readState()).toEqual(f.state)
    await expectOwnContentCleared(f, result)
  })

  it('starts disabled with zero generation requests and never enables the existing connection', async () => {
    const f = await prepare()
    await f.profiles.setEnabled(f.state.revision, false)
    const paused = await f.profiles.readState()
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'profile_not_enabled', callsUsed: 0,
      invocationCount: 0, cleanupComplete: true, profileStateUnchanged: true })
    expect(result.runId).toBeUndefined()
    expect(f.calls).toEqual([])
    expect(await f.profiles.readState()).toEqual(paused)
  })

  it('limits a remaining one-request authorization to Evidence and reports the rest as unverified', async () => {
    const f = await prepare()
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider, requestLimit: 1 })
    expect(result).toMatchObject({ outcome: 'partial', limit: 1, callsUsed: 1, invocationCount: 1,
      evidenceValidated: true, artifacts: {}, unresolvedCount: 0, profileStateUnchanged: true })
    expect(f.calls.map((call) => call.role)).toEqual(['evidence-map'])
    await expectOwnContentCleared(f, result)
  })

  it('cannot add a repair beyond a remaining single request', async () => {
    const f = await prepare()
    f.override(() => 'synthetic-invalid-evidence')
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider, requestLimit: 1 })
    expect(result).toMatchObject({ outcome: 'failed', limit: 1, callsUsed: 1, invocationCount: 1,
      evidenceValidated: false, artifacts: {}, unresolvedCount: 0 })
    expect(f.calls).toHaveLength(1)
    await expectOwnContentCleared(f, result)
  })

  it('closes generation after the captured profile is paused and cleans only its own sample', async () => {
    const f = await prepare()
    f.override(async (request) => {
      await f.profiles.setEnabled(f.state.revision, false)
      return f.fake.output(request)
    })
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'profile_changed', callsUsed: 1, profileStateUnchanged: false })
    expect(f.calls.map((call) => call.role)).toEqual(['evidence-map'])
    expect((await f.profiles.readState()).enabled).toBe(false)
    await expectOwnContentCleared(f, result)
  })

  it('preserves an unknown invoice outcome without repair, replay or raw response in the result', async () => {
    const f = await prepare()
    f.override(() => { throw new ProviderGatewayError({ providerId: f.fake.id, kind: 'outcome_unknown',
      retryable: false, safeCode: 'synthetic_lost_response' }) })
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', callsUsed: 1, invocationCount: 1, unresolvedCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 }, profileStateUnchanged: true, artifacts: {},
      failures: [{ stage: 'evidence', retryable: false }] })
    expect(f.calls.map((call) => call.role)).toEqual(['evidence-map'])
    expect(JSON.stringify(result)).not.toContain('synthetic_lost_response')
    await expectOwnContentCleared(f, result)
  })

  it('enforces a deadline even if a fake transport does not respond to abort and retains its unknown reservation', async () => {
    const f = await prepare()
    f.override(() => new Promise<string>(() => undefined))
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider, deadlineMs: 100 })
    expect(result).toMatchObject({ outcome: 'timed_out', reason: 'deadline_exceeded', callsUsed: 1,
      invocationCount: 1, unresolvedCount: 1, profileStateUnchanged: true })
    expect(f.calls).toHaveLength(1)
    await expectOwnContentCleared(f, result)
  })

  it('rejects invalid deadline bounds before provider construction or any store mutation', async () => {
    const f = await prepare()
    for (const deadlineMs of [0, -1, 120001, Infinity]) await expect(verifyPersonalProvider({
      store: f.store, profiles: f.profiles, createProvider: f.createProvider, deadlineMs,
    })).rejects.toThrow('deadline')
    expect(await f.profiles.readState()).toEqual(f.state)
    expect(f.calls).toEqual([])
    expect(await f.profiles.listBoundActiveRuns()).toEqual([])
  })

  it('rejects invalid remaining request limits before any provider call or run creation', async () => {
    const f = await prepare()
    for (const requestLimit of [0, -1, 4, Infinity]) await expect(verifyPersonalProvider({
      store: f.store, profiles: f.profiles, createProvider: f.createProvider, requestLimit: requestLimit as 1,
    })).rejects.toThrow('request limit')
    expect(f.calls).toEqual([])
    expect(await f.profiles.readState()).toEqual(f.state)
    expect(await f.profiles.listBoundActiveRuns()).toEqual([])
  })

  it('does not leak secret-bearing text even when it occurs in an otherwise schema-valid artifact', async () => {
    const f = await prepare()
    f.override((request) => request.role === 'artifact-summary'
      ? f.fake.output(request).replace('Photosynthesis converts light into stored chemical energy.', 'synthetic-personal-key-not-real')
      : f.fake.output(request))
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'result_not_safe', callsUsed: 3, artifacts: {} })
    expect(JSON.stringify(result)).not.toContain('synthetic-personal-key')
    await expectOwnContentCleared(f, result)
  })

  it('checks unescaped artifact strings so quotes and backslashes in a private key cannot evade redaction', async () => {
    const f = await prepare()
    const privateKey = 'synthetic"private\\key-not-real'
    await f.profiles.save(f.state.revision, { ...personalFixtureSettings(), apiKey: privateKey })
    await f.profiles.setCheck(f.state.revision + 1, 'ready')
    await f.profiles.setEnabled(f.state.revision + 2, true)
    f.override((request) => {
      const output = JSON.parse(f.fake.output(request))
      if (request.role === 'artifact-summary') (output.payload ?? output).overview.text = privateKey
      return JSON.stringify(output)
    })
    const result = await verifyPersonalProvider({ store: f.store, profiles: f.profiles, createProvider: f.createProvider })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'result_not_safe', callsUsed: 3, artifacts: {} })
    expect(JSON.stringify(result)).not.toContain('private')
    await expectOwnContentCleared(f, result)
  })
})
