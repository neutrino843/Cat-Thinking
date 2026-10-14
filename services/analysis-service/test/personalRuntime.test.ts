import { afterEach, describe, expect, it } from 'vitest'
import { PersonalAnalysisRuntime } from '../src/personal/personalRuntime.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError } from '../src/personal/profileStore.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { ProviderConnectionError } from '../src/providers/providerConnection.js'
import { createEngineCapabilities } from '../src/domain/capabilities.js'
import { createPersonalFixtureFetch, MemoryPersonalProfileStore, personalFixtureConfig, personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest } from './fixtures/fakeAnalysisProvider.js'
import type { FetchImplementation } from '../src/providers/openAICompatibleProvider.js'

const active: PersonalAnalysisRuntime[] = []
afterEach(async () => { for (const runtime of active.splice(0)) await runtime.close() })
const fixture = (wrapFetch?: (fetch: FetchImplementation) => FetchImplementation) => {
  const store = new InMemoryJobStore()
  const profiles = new MemoryPersonalProfileStore(store)
  const transport = createPersonalFixtureFetch()
  const config = personalFixtureConfig()
  const runtime = new PersonalAnalysisRuntime({ config, store, profiles,
    fetchImplementation: wrapFetch ? wrapFetch(transport.fetchImplementation) : transport.fetchImplementation })
  active.push(runtime)
  return { store, profiles, transport, config, runtime }
}
const enable = async (runtime: PersonalAnalysisRuntime) => {
  const saved = await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
  const checked = await runtime.check(saved.revision)
  return runtime.enable(checked.revision)
}

const startPublicSummary = async (runtime: PersonalAnalysisRuntime, profileId: string, key: string) => {
  const created = await runtime.runService.createRun(FIXTURE_TENANT, { ...fixtureRequest(key, ['summary']), providerProfileId: profileId })
  await runtime.runService.uploadSource(FIXTURE_TENANT, created.run.id, {
    version: 1, sourceId: 'synthetic-source', contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT),
    partIndex: 0, partCount: 1, start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT,
  })
  await runtime.runService.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
  return created.run.id
}

describe('personal authorization and immutable provider settings', () => {
  it('verifies an enabled saved profile without dispatching, cancelling, changing settings or calling a provider', async () => {
    const { store, profiles, transport, config } = fixture()
    await profiles.save(0, personalFixtureSettings())
    await profiles.setCheck(1, 'ready')
    await profiles.setEnabled(2, true)
    const state = await profiles.readState()
    const verifier = new PersonalAnalysisRuntime({ config: { ...config, personalReadOnly: true }, store, profiles,
      fetchImplementation: transport.fetchImplementation })
    active.push(verifier)
    await verifier.initialize()
    expect(await verifier.status()).toMatchObject({ enabled: true, configured: true, acceptsRuns: false })
    expect((await verifier.availability()).personalAuthorized).toBe(false)
    const operations = [() => verifier.save({ ...personalFixtureSettings(), expectedRevision: 3 }),
      () => verifier.models(personalFixtureSettings()), () => verifier.check(3), () => verifier.enable(3),
      () => verifier.pause(3), () => verifier.clear(3)]
    for (const operation of operations) await expect(operation()).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
    expect(await profiles.readState()).toEqual(state)
    expect(transport.calls).toEqual([])
  })
  it('starts closed and never fabricates deployment smoke evidence', async () => {
    const { runtime, config, transport } = fixture()
    await runtime.initialize()
    expect(await runtime.status()).toMatchObject({ available: true, enabled: false, acceptsRuns: false, pricingKnown: false })
    const enabled = await enable(runtime)
    expect(enabled).toMatchObject({ enabled: true, acceptsRuns: true, pricingKnown: false })
    expect(transport.calls).toEqual([{ method: 'GET' }])
    const availability = await runtime.availability()
    expect(availability.liveSmokeReady).toBeUndefined()
    expect(availability.maxSelectedCharacters).toBe(100000)
    const personalCapabilities = createEngineCapabilities(config, availability)
    expect(personalCapabilities.acceptsRuns).toBe(true)
    expect(personalCapabilities.maxSelectedCharacters).toBe(100000)
    expect(personalCapabilities.maxSourceCharacters).toBe(2000000)
    const deploymentCapabilities = createEngineCapabilities({ ...config, operatingMode: 'deployment' }, availability)
    expect(deploymentCapabilities.acceptsRuns).toBe(false)
    expect(deploymentCapabilities.maxSelectedCharacters).toBeUndefined()
  })
  it('returns public metadata without credentials or masked key fragments', async () => {
    const { runtime, profiles } = fixture()
    const status = await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
    expect(status).toMatchObject({ revision: 1, hasApiKey: true, checkState: 'unchecked', enabled: false })
    expect(JSON.stringify(status)).not.toContain('synthetic-personal-key')
    expect(Object.keys(status)).not.toContain('apiKey')
    const before = await profiles.getSnapshot(profiles.state.profileId!)
    await runtime.save({ ...personalFixtureSettings('synthetic-model-b'), apiKey: undefined, expectedRevision: 1 })
    const next = await profiles.getSnapshot(profiles.state.profileId!)
    expect(next?.settings.apiKey).toBe(before?.settings.apiKey)
    expect(next?.id).not.toBe(before?.id)
    expect(before?.settings.modelId).toBe('synthetic-model')
  })
  it('refuses to forward a stored key to a changed endpoint', async () => {
    const { runtime } = fixture()
    await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
    await expect(runtime.save({ ...personalFixtureSettings(), baseUrl: 'https://api.example.com/v1', networkMode: 'public', apiKey: undefined,
      expectedRevision: 1 })).rejects.toMatchObject({ safeCode: 'credentials_required' })
    expect((await runtime.status()).revision).toBe(1)
  })
  it('allows model discovery before choosing a model without saving the key', async () => {
    const { runtime, profiles } = fixture()
    const models = await runtime.models({ ...personalFixtureSettings(), modelId: undefined })
    expect(models.models.map((model) => model.id)).toContain('synthetic-model-b')
    expect(profiles.snapshots.size).toBe(0)
    expect((await runtime.status()).configured).toBe(false)
  })
  it.each([401, 403, 429, 500])('keeps the entry closed on connection status %i', async (statusCode) => {
    const { runtime, transport } = fixture()
    transport.setModelStatus(statusCode)
    const saved = await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
    const checked = await runtime.check(saved.revision)
    expect(checked).toMatchObject({ checkState: 'failed', enabled: false, acceptsRuns: false })
    await expect(runtime.enable(checked.revision)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
  it.each([404, 405])('permits an explicit manual-model activation when models endpoint returns %i', async (statusCode) => {
    const { runtime, transport } = fixture()
    transport.setModelStatus(statusCode)
    const saved = await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
    const checked = await runtime.check(saved.revision)
    expect(checked).toMatchObject({ checkState: 'unchecked', messageKey: 'analysis.personal.models_not_supported', acceptsRuns: false })
    expect((await runtime.enable(checked.revision)).acceptsRuns).toBe(true)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
  it('requires the current revision and a checked snapshot before activation', async () => {
    const { runtime } = fixture()
    await expect(runtime.check(0)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
    await runtime.save({ ...personalFixtureSettings(), expectedRevision: 0 })
    await expect(runtime.enable(1)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
    await expect(runtime.save({ ...personalFixtureSettings('synthetic-model-b'), expectedRevision: 0 })).rejects.toBeInstanceOf(PersonalProfileConflictError)
    expect((await runtime.status()).modelId).toBe('synthetic-model')
  })
  it('rejects a run created from stale capabilities and cancels bound old runs on model change', async () => {
    const { runtime, store, profiles } = fixture()
    const enabled = await enable(runtime)
    const originalId = profiles.state.profileId!
    const created = await runtime.runService.createRun(FIXTURE_TENANT, { ...fixtureRequest('personal-model-switch'), providerProfileId: originalId })
    const switched = await runtime.save({ ...personalFixtureSettings('synthetic-model-b'), expectedRevision: enabled.revision })
    expect(switched.acceptsRuns).toBe(false)
    expect((await store.getRun(FIXTURE_TENANT, created.run.id))?.status).toBe('cancelled')
    expect((await profiles.getRunSnapshot(FIXTURE_TENANT, created.run.id))?.settings.modelId).toBe('synthetic-model')
    const checked = await runtime.check(switched.revision)
    await runtime.enable(checked.revision)
    await expect(runtime.runService.createRun(FIXTURE_TENANT, { ...fixtureRequest('personal-stale-capabilities'), providerProfileId: originalId }))
      .rejects.toMatchObject({ statusCode: 409, contractError: { messageKey: 'analysis.personal.profile_changed' } })
    expect((await runtime.availability()).activeProfileId).not.toBe(originalId)
  })
  it('pauses scheduling and erases every historic credential while retaining run metadata', async () => {
    const { runtime, store, profiles } = fixture()
    const enabled = await enable(runtime)
    const created = await runtime.runService.createRun(FIXTURE_TENANT, { ...fixtureRequest('personal-clear'), providerProfileId: profiles.state.profileId })
    const paused = await runtime.pause(enabled.revision)
    expect(paused.acceptsRuns).toBe(false)
    expect((await store.getRun(FIXTURE_TENANT, created.run.id))?.status).toBe('cancelled')
    const cleared = await runtime.clear(paused.revision)
    expect(cleared).toMatchObject({ hasApiKey: false, configured: false, acceptsRuns: false })
    expect([...profiles.snapshots.values()].every((snapshot) => snapshot.revoked && !snapshot.settings.apiKey)).toBe(true)
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, created.run.id)).toBeDefined()
  })
  it('closes admission when the profile lock/store is unhealthy', async () => {
    const { runtime, profiles } = fixture()
    await enable(runtime)
    profiles.healthy = false
    expect((await runtime.status()).acceptsRuns).toBe(false)
    expect(await runtime.availability()).toMatchObject({ jobStoreReady: false, maxSelectedCharacters: 100000 })
  })
  it('allows a selected excerpt from a large source and rejects an oversized full selection', async () => {
    const { runtime, profiles } = fixture()
    await enable(runtime)
    const original = fixtureRequest('personal-large-selection')
    const source = { ...original.manifest.sources[0], charCount: 100001, byteCount: 100001 }
    const request = { ...original, providerProfileId: profiles.state.profileId,
      manifest: { version: 1 as const, sources: [source] } }
    await expect(runtime.runService.createRun(FIXTURE_TENANT, request)).rejects.toMatchObject({ statusCode: 400,
      contractError: { code: 'source_too_large', messageKey: 'analysis.personal.source_too_large' } })
    const selected = await runtime.runService.createRun(FIXTURE_TENANT, { ...request,
      manifest: { version: 1, sources: [{ ...source, selectedRange: { start: 100000, end: 100001 } }] } })
    expect(selected.run.request.manifest.sources[0]?.selectedRange).toEqual({ start: 100000, end: 100001 })
  })
  it('rejects secret-bearing endpoint paths and non-personal initialization', async () => {
    const { runtime, store, profiles, config } = fixture()
    const settings = personalFixtureSettings()
    await expect(runtime.save({ ...settings, baseUrl: `${settings.baseUrl}${settings.apiKey}/`, expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ProviderConnectionError)
    expect(() => new PersonalAnalysisRuntime({ config: { ...config, operatingMode: 'deployment' }, store, profiles }))
      .toThrow(PersonalProfileUnavailableError)
  })
  it('never echoes a credential placed in a model id and infers explicit full API endpoints', async () => {
    const { runtime } = fixture()
    await expect(runtime.save({ ...personalFixtureSettings(), modelId: 'synthetic-personal-key-not-real', expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ProviderConnectionError)
    const saved = await runtime.save({ ...personalFixtureSettings(), baseUrl: 'http://127.0.0.1:9876/v1/responses',
      protocol: 'chat-completions', expectedRevision: 0 })
    expect(saved).toMatchObject({ protocol: 'responses', baseUrl: 'http://127.0.0.1:9876/v1/' })
  })

  it('allows one explicit personal retry after a known 429 refusal while preserving zero-price usage and invocation accounting', async () => {
    let postCount = 0
    let refused = false
    const { runtime, store, profiles } = fixture((fetch) => async (url, init) => {
      if (init?.method === 'POST') {
        postCount += 1
        const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] }
        const prompt = body.messages.find((message) => message.role === 'user')?.content ?? ''
        if (!prompt.startsWith('Map the following immutable chunk envelope') && !refused) {
          refused = true
          return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
            status: 429, headers: { 'content-type': 'application/json' },
          })
        }
      }
      return fetch(url, init)
    })
    await enable(runtime)
    const runId = await startPublicSummary(runtime, profiles.state.profileId!, 'personal-known-refusal-retry')
    await expect.poll(async () => (await runtime.runService.getRun(FIXTURE_TENANT, runId)).status, { timeout: 5000 }).toBe('failed')
    const failed = await runtime.runService.getRun(FIXTURE_TENANT, runId)
    expect(failed.artifactStates.summary).toMatchObject({ status: 'failed', attempt: 1,
      error: { code: 'rate_limited', retryable: true, details: { providerCode: 'rate_limit_exceeded' } } })
    expect(postCount).toBe(2)
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 0,
      usage: { inputTokens: 20, outputTokens: 10, estimatedCostMicros: 0 } })

    await runtime.runService.retryArtifact(FIXTURE_TENANT, runId, 'summary', failed.revision)
    await expect.poll(async () => (await runtime.runService.getRun(FIXTURE_TENANT, runId)).status, { timeout: 5000 }).toBe('succeeded')
    const completed = await runtime.runService.getRun(FIXTURE_TENANT, runId)
    expect(completed.artifactStates.summary).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(postCount).toBe(3)
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toMatchObject({ invocationCount: 3, unresolvedCount: 0,
      usage: { inputTokens: 40, outputTokens: 20, estimatedCostMicros: 0 } })
    expect((await runtime.runService.getArtifact(FIXTURE_TENANT, runId, 'summary')).kind).toBe('summary')
  })

  it('rejects an explicit personal retry after an unknown Artifact transport without sending another POST', async () => {
    let postCount = 0
    const { runtime, store, profiles } = fixture((fetch) => async (url, init) => {
      if (init?.method === 'POST') {
        postCount += 1
        const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] }
        const prompt = body.messages.find((message) => message.role === 'user')?.content ?? ''
        if (!prompt.startsWith('Map the following immutable chunk envelope')) throw new TypeError('synthetic_unknown_artifact_transport')
      }
      return fetch(url, init)
    })
    await enable(runtime)
    const runId = await startPublicSummary(runtime, profiles.state.profileId!, 'personal-unknown-refusal-retry')
    await expect.poll(async () => (await runtime.runService.getRun(FIXTURE_TENANT, runId)).status, { timeout: 5000 }).toBe('failed')
    const failed = await runtime.runService.getRun(FIXTURE_TENANT, runId)
    expect(failed.artifactStates.summary).toMatchObject({ status: 'failed', attempt: 1,
      error: { retryable: false, details: { reason: 'invocation_outcome_unknown' } } })
    await expect(runtime.runService.retryArtifact(FIXTURE_TENANT, runId, 'summary', failed.revision)).rejects.toMatchObject({
      statusCode: 409, contractError: { messageKey: 'analysis.artifact.invocation_outcome_unknown' },
    })
    expect((await runtime.runService.getRun(FIXTURE_TENANT, runId)).revision).toBe(failed.revision)
    expect(postCount).toBe(2)
    expect(await store.getRunLedgerUsage(FIXTURE_TENANT, runId)).toMatchObject({ invocationCount: 2, unresolvedCount: 1,
      usage: { inputTokens: 20, outputTokens: 10, estimatedCostMicros: 0 } })
  })
})
