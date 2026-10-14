import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildAnalysisServer } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { createEngineCapabilities } from '../src/domain/capabilities.js'
import { PersistentDispatcher } from '../src/domain/persistentDispatcher.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { createExecutionReadiness } from '../src/release/executionReadiness.js'
import { ReleaseGate } from '../src/release/releaseGate.js'
import { configurationHash, RELEASE_PROMPT_VERSIONS, RELEASE_SCHEMA_VERSION, signReleaseAttestation } from '../src/release/releaseAttestation.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'

describe('shared admission and execution readiness', () => {
  it('runs five fake artifacts with signed evidence, then revokes API admission and network activity', async () => {
    const token = 'release-test-token-with-at-least-thirty-two-bytes'
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_AUTH_MODE: 'service-token', ANALYSIS_SERVICE_TOKEN: token, ANALYSIS_CORS_ORIGINS: 'https://app.test', ANALYSIS_RELEASE_HOLD: 'false', ANALYSIS_RELEASE_ATTESTATION_PATH: 'receipt', ANALYSIS_RELEASE_PUBLIC_KEY_PATH: 'public' })
    const keys = generateKeyPairSync('ed25519')
    const build = { serviceVersion: config.serviceVersion, commit: 'a'.repeat(40), artifactDigest: 'b'.repeat(64) }
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const proof = JSON.stringify(signReleaseAttestation({ version: 1, audience: 'cat-analysis-engine', build, configurationHash: configurationHash(config), schemaVersion: RELEASE_SCHEMA_VERSION, promptVersions: RELEASE_PROMPT_VERSIONS, issuedAt: 1000, expiresAt: 2000, evidence: { quality: 'passed', postgresRecovery: 'passed', postgresCoverage: 'passed', liveProvider: 'passed', executionId: 'c'.repeat(32) } }, keys.privateKey))
    let now = 1500
    let shuttingDown = false
    const release = new ReleaseGate({ config, build, now: () => now, read: async (path) => path === 'public' ? publicKey : proof })
    const store = new InMemoryJobStore()
    const fixture = await prepareFixtureRun(store, 'signed-fake-completion')
    const provider = new FakeAnalysisProvider()
    const readiness = createExecutionReadiness({ release, store, provider, usageReady: true, dispatcherReady: () => dispatcher?.isReady() ?? false, shuttingDown: () => shuttingDown })
    const runtime = createAnalysisProviderRuntime({ store, provider, broker: fixture.service.broker, leaseMs: 300, estimateCostMicros: () => 1, canInvoke: readiness.canExecute })
    const dispatcher = new PersistentDispatcher({ store, ...runtime, leaseMs: 300, pollMs: 50, maxRunMs: 3000, cleanupExpired: async () => undefined, canDispatch: readiness.canExecute })
    const server = await buildAnalysisServer(config, { runService: fixture.service, availability: readiness.availability, logger: false })
    const headers = { authorization: `Bearer ${token}`, 'x-cat-tenant-id': FIXTURE_TENANT, origin: 'https://app.test' }
    try {
      expect(createEngineCapabilities(config, await readiness.availability()).acceptsRuns).toBe(false)
      expect(await readiness.canExecute()).toBe(true)
      await dispatcher.start()
      await vi.waitFor(async () => expect((await fixture.service.getRun(FIXTURE_TENANT, fixture.runId)).status).toBe('succeeded'))
      expect(provider.calls).toHaveLength(6)
      expect((await server.inject({ url: '/api/analysis/v1/capabilities', headers })).json().acceptsRuns).toBe(true)
      now = 2000
      expect(await readiness.canExecute()).toBe(false)
      expect((await server.inject({ method: 'POST', url: '/api/analysis/v1/runs', headers, payload: {} })).statusCode).toBe(503)
      await prepareFixtureRun(store, 'revoked-new-run')
      await dispatcher.tick()
      expect(provider.calls).toHaveLength(6)
      now = 1500
      shuttingDown = true
      expect(await readiness.canExecute()).toBe(false)
    } finally { await dispatcher.stop(1000); await server.close() }
  })
  it('fails closed for store, Provider, proof, usage and shutdown faults', async () => {
    const release = { status: vi.fn(async () => ({ ready: true as const, expiresAt: 2000 })) }
    const store = { checkHealth: vi.fn(async () => true) }
    const provider = { isReady: vi.fn(() => true) }
    const options = { release, store, provider, usageReady: true, dispatcherReady: () => true, shuttingDown: () => false }
    expect(await createExecutionReadiness(options).canExecute()).toBe(true)
    store.checkHealth.mockRejectedValueOnce(new Error('private connection'))
    expect(await createExecutionReadiness(options).canExecute()).toBe(false)
    provider.isReady.mockImplementationOnce(() => { throw new Error('private key') })
    expect(await createExecutionReadiness(options).canExecute()).toBe(false)
    release.status.mockRejectedValueOnce(new Error('private receipt path'))
    expect(await createExecutionReadiness(options).canExecute()).toBe(false)
    for (const changes of [{ store: undefined }, { provider: undefined }, { usageReady: false }, { shuttingDown: () => true }]) {
      expect(await createExecutionReadiness({ ...options, ...changes }).canExecute()).toBe(false)
    }
    expect(createEngineCapabilities(loadAnalysisServiceConfig({}), await createExecutionReadiness({ ...options, dispatcherReady: () => false }).availability()).acceptsRuns).toBe(false)
  })
})
