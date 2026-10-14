import { createHash, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import { createAnalysisRunSchema } from '@cat-thinking/analysis-contracts'
import { buildAnalysisServer } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { PostgresPersonalProfileStore } from '../src/infrastructure/postgres/postgresPersonalProfileStore.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { PersonalAnalysisRuntime } from '../src/personal/personalRuntime.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'
import { createPersonalFixtureFetch } from './fixtures/personalProviderFixture.js'
import { FIXTURE_TEXT, fixtureHash } from './fixtures/fakeAnalysisProvider.js'

// Compiled only for tests. No real Provider or ambient key can enter this harness.
if (process.env.NODE_ENV !== 'test' || process.env.ANALYSIS_BROWSER_SYNTHETIC !== '1'
  || process.env.ANALYSIS_BROWSER_PERSONAL !== '1') throw new Error('Personal browser harness is test-only')
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL ?? ''
assertDedicatedPostgresTestDatabase(databaseUrl)
if (new URL(databaseUrl).pathname !== '/cat_analysis_test') throw new Error('Dedicated synthetic database required')
const token = process.env.ANALYSIS_GATEWAY_TOKEN ?? ''
const key = process.env.ANALYSIS_BROWSER_CONTENT_KEY ?? ''
if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token) || Buffer.from(key, 'base64').length !== 32) throw new Error('Synthetic harness credentials missing')
const config = { ...loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_OPERATING_MODE: 'personal',
  ANALYSIS_HOST: '127.0.0.1', ANALYSIS_PORT: '8790', ANALYSIS_AUTH_MODE: 'service-token', ANALYSIS_SERVICE_TOKEN: token,
  ANALYSIS_CORS_ORIGINS: 'http://127.0.0.1:5175', ANALYSIS_JOB_STORE: 'postgres', ANALYSIS_DATABASE_URL: databaseUrl,
  ANALYSIS_DATABASE_SSL: 'disable', ANALYSIS_CONTENT_ENCRYPTION_KEY: key, ANALYSIS_PROVIDER_MODE: 'disabled',
  ANALYSIS_RELEASE_HOLD: 'true', ANALYSIS_LEASE_MS: '10000', ANALYSIS_SSE_POLL_MS: '100', ANALYSIS_RATE_LIMIT_MAX: '10000' }),
  serviceVersion: 'synthetic-browser-personal-v1' }
if (config.jobStore.mode !== 'postgres') throw new Error('PostgreSQL required')
const pool = new Pool({ connectionString: databaseUrl, max: 2 })
const unlock = await acquireSyntheticDatabaseLock(pool)
const cipher = new AesGcmContentCipher(Buffer.from(key, 'base64'))
const jobs = await PostgresJobStore.connectFromConfig(config.jobStore, cipher)
await pool.query('DROP TABLE IF EXISTS cat_analysis_personal_run_profiles,cat_analysis_personal_state,cat_analysis_personal_profiles,cat_analysis_personal_schema_migrations')
await pool.query('TRUNCATE analysis_runs,analysis_evidence_cache,analysis_abandoned_requests CASCADE')
const profiles = await PostgresPersonalProfileStore.connect(config.jobStore, cipher, jobs)
const transport = createPersonalFixtureFetch()
const runtime = new PersonalAnalysisRuntime({ config, store: jobs, profiles, fetchImplementation: transport.fetchImplementation })
const server = await buildAnalysisServer(config, { logger: false, runService: runtime.runService,
  personalRuntime: runtime, availability: () => runtime.availability() })
const hash = (value: string) => createHash('sha256').update(value).digest()
server.addHook('preValidation', async (request, reply) => {
  if (request.method === 'POST' && request.url === '/api/analysis/v1/runs') {
    const parsed = createAnalysisRunSchema.safeParse(request.body)
    if (!parsed.success || parsed.data.request.manifest.sources.some((source) => source.contentHash !== fixtureHash(FIXTURE_TEXT))) {
      return reply.code(422).send({ error: 'Only public synthetic text is accepted' })
    }
  }
})
server.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/__synthetic/')) return
  if (request.ip !== '127.0.0.1' || !timingSafeEqual(hash(String(request.headers.authorization ?? '')), hash(`Bearer ${token}`))) {
    return reply.code(403).send({ error: 'Denied' })
  }
})
server.get<{ Params: { runId: string } }>('/__synthetic/runs/:runId', async (request) => ({
  run: await jobs.getRun('synthetic-browser', request.params.runId),
  ledger: await jobs.getRunLedgerUsage('synthetic-browser', request.params.runId),
}))
server.get('/__synthetic/status', async () => ({ generationCalls: transport.calls.filter((call) => call.method === 'POST').length,
  modelChecks: transport.calls.filter((call) => call.method === 'GET').length }))
let shutdownPromise: Promise<void> | undefined
const shutdown = () => shutdownPromise ??= (async () => {
  try { await runtime.close(); server.server.closeAllConnections(); await server.close(); await jobs.close() }
  finally { await unlock(); await pool.end() }
})()
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
try { await runtime.initialize(); await server.listen({ host: '127.0.0.1', port: 8790 }) }
catch { process.exitCode = 1; await shutdown(); process.stderr.write('Synthetic personal harness failed; credentials withheld.\n') }
