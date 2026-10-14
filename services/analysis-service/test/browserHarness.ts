import { createHash, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import { type FastifyInstance } from 'fastify'
import { identifierSchema, createAnalysisRunSchema } from '@cat-thinking/analysis-contracts'
import { buildAnalysisServer } from '../src/api/server.js'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { RunService } from '../src/domain/runService.js'
import { PersistentDispatcher } from '../src/domain/persistentDispatcher.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { DEFAULT_PROVIDER_INVOCATION_POLICY } from '../src/providers/providerInvocationCoordinator.js'
import { createStableInvocationId } from '../src/providers/invocationId.js'
import { OUTLINE_HIERARCHY_PROMPT_VERSION } from '../src/providers/artifactPrompts.js'
import { BrowserSyntheticProvider } from './fixtures/browserSyntheticProvider.js'
import { ANALYSIS_SYNTHETIC } from './fixtures/browserSyntheticTexts.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'

// Intentionally absent from the production build and provider configuration.
if (process.env.NODE_ENV !== 'test' || process.env.ANALYSIS_BROWSER_SYNTHETIC !== '1') throw new Error('Synthetic browser harness is test-only')
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL ?? ''
assertDedicatedPostgresTestDatabase(databaseUrl)
if (new URL(databaseUrl).pathname !== '/cat_analysis_test') throw new Error('Browser harness requires cat_analysis_test')
const token = process.env.ANALYSIS_GATEWAY_TOKEN ?? ''
const key = process.env.ANALYSIS_BROWSER_CONTENT_KEY ?? ''
if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token) || Buffer.from(key, 'base64').length !== 32) throw new Error('Synthetic harness credentials are missing')
const tenant = 'synthetic-browser'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const allowedHashes = new Set(Object.values(ANALYSIS_SYNTHETIC).map(hash))
const config = { ...loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_AUTH_MODE: 'service-token', ANALYSIS_SERVICE_TOKEN: token,
  ANALYSIS_JOB_STORE: 'postgres', ANALYSIS_DATABASE_URL: databaseUrl, ANALYSIS_DATABASE_SSL: 'disable', ANALYSIS_CONTENT_ENCRYPTION_KEY: key,
  ANALYSIS_HOST: '127.0.0.1', ANALYSIS_PORT: '8790', ANALYSIS_PROVIDER_MODE: 'disabled', ANALYSIS_RELEASE_HOLD: 'true',
  ANALYSIS_SSE_POLL_MS: '100', ANALYSIS_LEASE_MS: '10000', ANALYSIS_RATE_LIMIT_MAX: '10000' }), serviceVersion: 'synthetic-browser-v1' }
if (config.jobStore.mode !== 'postgres') throw new Error('Synthetic harness requires PostgreSQL')
const storeConfig = config.jobStore
const lockPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 })
const releaseLock = await acquireSyntheticDatabaseLock(lockPool)
let current: { store: PostgresJobStore; server: FastifyInstance; dispatcher: PersistentDispatcher } | undefined
let open = true
let stopping = false
let restarting = false
let generation = 0

async function boot() {
  const store = await PostgresJobStore.connectFromConfig(storeConfig, new AesGcmContentCipher(Buffer.from(key, 'base64')))
  const service = new RunService({ store, retentionSeconds: 3600 })
  const runtime = createAnalysisProviderRuntime({ store, broker: service.broker, provider: new BrowserSyntheticProvider(), leaseMs: 10000,
    estimateCostMicros: () => 1, canInvoke: async () => open && !stopping,
    policy: { ...DEFAULT_PROVIDER_INVOCATION_POLICY, maxAttempts: 1, staleAfterMs: 60000 } })
  const artifacts = { async runOnce(tenantId: string, runId: string, ownerId: string, signal: AbortSignal) {
    const graph = await store.getEvidenceGraph(tenantId, runId)
    if (graph?.claims.some((claim) => claim.statement.includes('fixture unknown'))) {
      // Simulate an interrupted paid invocation by seeding only its durable ledger reservation.
      // The real coordinator must classify it as unknown and refuse to call the fake transport.
      const nodeKey = 'artifact:outline'
      await store.reserveProviderInvocation({ tenantId, runId, nodeKey, runAttempt: 1, role: 'artifact-outline',
        invocationId: createStableInvocationId({ runId, nodeKey, runAttempt: 1, role: 'artifact-outline' }),
        providerId: 'synthetic-browser-provider', modelId: 'synthetic-browser-model', profileVersion: 'synthetic-browser-v1', promptVersion: OUTLINE_HIERARCHY_PROMPT_VERSION,
        estimatedInputTokens: 20, reservedOutputTokens: 1800, estimatedCostMicros: 1, maxRunEstimatedTokens: 4_000_000,
        maxRunEstimatedCostMicros: 50_000_000, staleAfterMs: 60000, now: Date.now() - 61000 })
    }
    return runtime.artifacts.runOnce(tenantId, runId, ownerId, signal)
  } }
  const dispatcher = new PersistentDispatcher({ store, evidence: runtime.evidence, artifacts, leaseMs: 10000, pollMs: 50, maxRunMs: 60_000,
    cleanupExpired: () => service.cleanupExpired(50), canDispatch: async () => open && !stopping })
  const server = await buildAnalysisServer(config, { logger: false, runService: service,
    availability: async () => ({ jobStoreReady: await store.checkHealth(), providerReady: true,
      dispatcherReady: dispatcher.isReady(), usageReady: true, recoveryReady: true, liveSmokeReady: open && !stopping }) })
  server.addHook('preValidation', async (request, reply) => {
    if (request.method === 'POST' && request.url === '/api/analysis/v1/runs') {
      const parsed = createAnalysisRunSchema.safeParse(request.body)
      if (!parsed.success || parsed.data.request.manifest.sources.some((source) => !allowedHashes.has(source.contentHash))) {
        return reply.code(422).send({ error: 'Only public synthetic fixture inputs are accepted' })
      }
    }
  })
  // Private controls are loopback + bearer protected and cannot pass the browser gateway route allowlist.
  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/__synthetic/')) return
    const candidate = hash(String(request.headers.authorization ?? ''))
    if (request.ip !== '127.0.0.1' || !timingSafeEqual(Buffer.from(candidate), Buffer.from(hash(`Bearer ${token}`)))) return reply.code(403).send({ error: 'Denied' })
  })
  server.get<{ Params: { runId: string } }>('/__synthetic/runs/:runId', async (request) => {
    const id = identifierSchema.parse(request.params.runId)
    return { ledger: await store.getRunLedgerUsage(tenant, id), run: await service.getRun(tenant, id) }
  })
  server.get('/__synthetic/status', async () => ({ generation, restarting }))
  server.post<{ Body: { open: boolean } }>('/__synthetic/gate', async (request) => {
    open = request.body.open === true
    return { open }
  })
  server.post('/__synthetic/restart', async (_request, reply) => {
    if (restarting) return reply.code(409).send({ error: 'Restart in progress' })
    restarting = true
    setTimeout(() => { void restart().catch(() => { process.exitCode = 1; void shutdown() }) }, 100)
    return { accepted: true }
  })
  current = { store, server, dispatcher }
  await server.listen({ host: '127.0.0.1', port: 8790 })
  await dispatcher.start()
  generation++
}
async function drain() {
  const instance = current
  current = undefined
  if (!instance) return
  await instance.dispatcher.stop(10_000)
  instance.server.server.closeAllConnections()
  await instance.server.close()
  await instance.store.close()
}
async function restart() { await drain(); await boot(); restarting = false }
async function shutdown() {
  if (stopping) return
  stopping = true
  try { await drain() } finally {
    try { await lockPool.query('TRUNCATE analysis_runs, analysis_evidence_cache, analysis_abandoned_requests CASCADE') }
    finally { await releaseLock(); await lockPool.end() }
  }
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
try {
  // Clear only after acquiring the shared test-runner lock and migrating this dedicated database.
  const initial = await PostgresJobStore.connectFromConfig(storeConfig, new AesGcmContentCipher(Buffer.from(key, 'base64')))
  await initial.close()
  await lockPool.query('TRUNCATE analysis_runs, analysis_evidence_cache, analysis_abandoned_requests CASCADE')
  await boot()
} catch {
  process.exitCode = 1
  await shutdown()
  process.stderr.write('Synthetic browser harness failed; credentials withheld.\n')
}
