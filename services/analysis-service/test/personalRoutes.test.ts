import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAnalysisServer } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { PersonalAnalysisRuntime } from '../src/personal/personalRuntime.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createPersonalFixtureFetch, MemoryPersonalProfileStore, personalFixtureConfig, personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'

const closing: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
const headers = { authorization: 'Bearer synthetic-personal-service-token-not-a-real-secret', 'x-cat-tenant-id': 'synthetic-tenant', origin: 'http://127.0.0.1:5173' }
const fixture = async () => {
  const config = personalFixtureConfig()
  const jobs = new InMemoryJobStore()
  const profiles = new MemoryPersonalProfileStore(jobs)
  const transport = createPersonalFixtureFetch()
  const runtime = new PersonalAnalysisRuntime({ config, store: jobs, profiles, fetchImplementation: transport.fetchImplementation })
  const server = await buildAnalysisServer(config, { logger: false, runService: runtime.runService,
    personalRuntime: runtime, availability: () => runtime.availability() })
  closing.push(() => runtime.close(), () => server.close())
  return { server, runtime, transport }
}
const action = (server: FastifyInstance, name: 'check' | 'enable' | 'pause', revision: number) => server.inject({
  method: 'POST', url: `/api/analysis/v1/personal/${name}`, headers, payload: { version: 1, expectedRevision: revision },
})
describe('authenticated personal configuration routes', () => {
  it('protects every V3 local operation using the existing token and exact origin boundary', async () => {
    const { server, runtime } = await fixture()
    const start = vi.spyOn(runtime.localModels, 'start')
    for (const url of ['/chat', '/local-models/start', '/local-models/stop', '/local-models/pull', '/local-models/cancel', '/local-models/storage']) {
      expect((await server.inject({ method: 'POST', url: `/api/analysis/v1/personal${url}`, payload: {} })).statusCode).toBe(401)
      expect((await server.inject({ method: 'POST', url: `/api/analysis/v1/personal${url}`, headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403)
    }
    expect(start).not.toHaveBeenCalled()
    for (const [path, payload] of [['/chat', { question: 'a'.repeat(2001) }], ['/local-models/pull', { model: 'unknown' }], ['/local-models/storage', { directory: 'x', arbitrary: true }], ['/local-models/arbitrary', {}]] as const) {
      expect((await server.inject({ method: 'POST', url: `/api/analysis/v1/personal${path}`, headers, payload })).statusCode).toBe(400)
    }
  })
  it('allows authenticated reads but rejects every mutation of existing work in verification mode', async () => {
    const config = { ...personalFixtureConfig(), personalReadOnly: true }
    const jobs = new InMemoryJobStore()
    const profiles = new MemoryPersonalProfileStore(jobs)
    const transport = createPersonalFixtureFetch()
    const { runId } = await prepareFixtureRun(jobs, 'read-only-http-existing-run')
    const before = await jobs.getRun(FIXTURE_TENANT, runId)
    const ledger = await jobs.getRunLedgerUsage(FIXTURE_TENANT, runId)
    const runtime = new PersonalAnalysisRuntime({ config, store: jobs, profiles, fetchImplementation: transport.fetchImplementation })
    const server = await buildAnalysisServer(config, { logger: false, runService: runtime.runService,
      personalRuntime: runtime, availability: () => runtime.availability() })
    closing.push(() => runtime.close(), () => server.close())
    await runtime.initialize()
    expect((await server.inject({ url: `/api/analysis/v1/runs/${runId}`, headers })).statusCode).toBe(200)
    const writes = [
      { method: 'POST' as const, url: `/runs/${runId}/cancel` }, { method: 'POST' as const, url: `/runs/${runId}/start` },
      { method: 'DELETE' as const, url: `/runs/${runId}/content` }, { method: 'PUT' as const, url: `/runs/${runId}/sources/synthetic-source` },
      { method: 'POST' as const, url: '/runs/abandon' }, { method: 'POST' as const, url: '/personal/models' },
      ...['chat', 'local-models/start', 'local-models/stop', 'local-models/pull', 'local-models/cancel', 'local-models/storage'].map((path) => ({ method: 'POST' as const, url: `/personal/${path}` })),
    ]
    for (const write of writes) {
      const response = await server.inject({ ...write, url: `/api/analysis/v1${write.url}`, headers, payload: {} })
      expect(response.statusCode).toBe(503)
    }
    expect(await jobs.getRun(FIXTURE_TENANT, runId)).toEqual(before)
    expect(await jobs.getRunLedgerUsage(FIXTURE_TENANT, runId)).toEqual(ledger)
    expect(transport.calls).toEqual([])
  })
  it('exposes a closed read-only status in deployment mode', async () => {
    const server = await buildAnalysisServer(loadAnalysisServiceConfig(), { logger: false })
    closing.push(() => server.close())
    const response = await server.inject('/api/analysis/v1/personal/settings')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ available: false, enabled: false, acceptsRuns: false })
    const enable = await server.inject({ method: 'POST', url: '/api/analysis/v1/personal/enable', payload: { version: 1, expectedRevision: 0 } })
    expect(enable.statusCode).toBe(503)
  })
  it('requires the existing gateway credential and exact allowed origin', async () => {
    const { server } = await fixture()
    expect((await server.inject('/api/analysis/v1/personal/settings')).statusCode).toBe(401)
    expect((await server.inject({ url: '/api/analysis/v1/personal/settings', headers: { ...headers, origin: 'https://evil.example' } })).statusCode).toBe(403)
  })
  it('supports save, non-billable check, explicit activation, pause and credential deletion', async () => {
    const { server, transport } = await fixture()
    const saved = await server.inject({ method: 'PUT', url: '/api/analysis/v1/personal/settings', headers,
      payload: { ...personalFixtureSettings(), expectedRevision: 0 } })
    expect(saved.statusCode).toBe(200); expect(saved.headers['cache-control']).toBe('no-store')
    expect(saved.body).not.toContain('synthetic-personal-key')
    const checked = await action(server, 'check', saved.json().revision)
    expect(checked.json().checkState).toBe('ready')
    const enabled = await action(server, 'enable', checked.json().revision)
    expect(enabled.json().acceptsRuns).toBe(true)
    const capabilities = await server.inject({ url: '/api/analysis/v1/capabilities', headers })
    expect(capabilities.json()).toMatchObject({ acceptsRuns: true, operatingMode: 'personal', pricingKnown: false, modelId: 'synthetic-model' })
    expect(capabilities.json().activeProfileId).toMatch(/^[0-9a-f-]{36}$/u)
    const paused = await action(server, 'pause', enabled.json().revision)
    expect(paused.json().acceptsRuns).toBe(false)
    const cleared = await server.inject({ method: 'DELETE', url: '/api/analysis/v1/personal/settings', headers,
      payload: { version: 1, expectedRevision: paused.json().revision } })
    expect(cleared.json()).toMatchObject({ configured: false, hasApiKey: false, acceptsRuns: false })
    expect(transport.calls).toEqual([{ method: 'GET' }])
  })
  it('returns model discovery without persisting preview credentials and safe conflict errors', async () => {
    const { server } = await fixture()
    const models = await server.inject({ method: 'POST', url: '/api/analysis/v1/personal/models', headers,
      payload: { ...personalFixtureSettings(), modelId: undefined } })
    expect(models.statusCode).toBe(200); expect(models.json().source).toBe('provider')
    expect((await server.inject({ url: '/api/analysis/v1/personal/settings', headers })).json().hasApiKey).toBe(false)
    await server.inject({ method: 'PUT', url: '/api/analysis/v1/personal/settings', headers, payload: { ...personalFixtureSettings(), expectedRevision: 0 } })
    const conflict = await server.inject({ method: 'PUT', url: '/api/analysis/v1/personal/settings', headers,
      payload: { ...personalFixtureSettings('synthetic-model-b'), expectedRevision: 0 } })
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.messageKey).toBe('analysis.personal.profile_changed')
    expect(conflict.body).not.toContain('synthetic-personal-key')
  })
  it('rejects unexpected fields and suppresses raw provider error text', async () => {
    const { server, transport } = await fixture()
    const malformed = await server.inject({ method: 'PUT', url: '/api/analysis/v1/personal/settings', headers,
      payload: { ...personalFixtureSettings(), expectedRevision: 0, dangerous: 'synthetic-secret-should-not-be-echoed' } })
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain('synthetic-secret')
    transport.setModelStatus(401)
    const models = await server.inject({ method: 'POST', url: '/api/analysis/v1/personal/models', headers, payload: personalFixtureSettings() })
    expect(models.statusCode).toBe(400); expect(models.json().error.messageKey).toBe('analysis.personal.credentials_rejected')
  })
})
