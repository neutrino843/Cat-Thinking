import { buildAnalysisServer } from './api/server.js'
import { loadAnalysisServiceConfig } from './config.js'
import { RunService } from './domain/runService.js'
import type { JobStore } from './domain/jobStore.js'
import { AesGcmContentCipher, decodeContentEncryptionKey } from './infrastructure/contentCipher.js'
import { PostgresJobStore } from './infrastructure/postgres/postgresJobStore.js'
import { createConfiguredModelProvider } from './providers/configuredProvider.js'
import { configuredCostEstimator } from './providers/configuredCostEstimator.js'
import { createAnalysisProviderRuntime } from './providers/analysisProviderRuntime.js'
import { PersistentDispatcher } from './domain/persistentDispatcher.js'
import { fileURLToPath } from 'node:url'
import { loadVerifiedBuildIdentity, type BuildIdentity } from './release/buildIdentity.js'
import { ReleaseGate } from './release/releaseGate.js'
import { createExecutionReadiness } from './release/executionReadiness.js'
import { PersonalAnalysisRuntime } from './personal/personalRuntime.js'
import { PostgresPersonalProfileStore } from './infrastructure/postgres/postgresPersonalProfileStore.js'

const config = loadAnalysisServiceConfig()
let jobStore: JobStore | undefined
let personal: PersonalAnalysisRuntime | undefined
if (config.jobStore.mode === 'postgres') {
  const cipher = new AesGcmContentCipher(decodeContentEncryptionKey(config.jobStore.encryptionKey))
  const postgresStore = await PostgresJobStore.connectFromConfig(config.jobStore, cipher)
  jobStore = postgresStore
  if (config.operatingMode === 'personal') {
    const profiles = await PostgresPersonalProfileStore.connect(config.jobStore, cipher, postgresStore)
    personal = new PersonalAnalysisRuntime({ config, store: jobStore, profiles,
      onError: (error) => server.log.error({ event: 'analysis.personal.dispatcher_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError' }, 'personal dispatcher failed') })
  }
}
const runService = personal?.runService ?? (jobStore ? new RunService({ store: jobStore, retentionSeconds: config.retentionSeconds,
  maxRunEstimatedTokens: config.provider.mode === 'openai-compatible' ? config.provider.invocationPolicy.maxRunEstimatedTokens : undefined,
  maxRunEstimatedCostMicros: config.provider.mode === 'openai-compatible' ? config.provider.invocationPolicy.maxRunEstimatedCostMicros : undefined,
}) : undefined)
const provider = createConfiguredModelProvider(config.provider)
const estimateCostMicros = configuredCostEstimator(config.provider)
let build: BuildIdentity | undefined
if (!config.release.hold) {
  try { build = await loadVerifiedBuildIdentity(fileURLToPath(new URL('../../../', import.meta.url))) } catch { /* An unverifiable build cannot execute. */ }
}
const releaseGate = new ReleaseGate({ config, build })
let shuttingDown = false
const readiness = createExecutionReadiness({ release: releaseGate, store: jobStore, provider,
  usageReady: estimateCostMicros !== undefined, dispatcherReady: () => dispatcher?.isReady() ?? false,
  shuttingDown: () => shuttingDown })
const canExecute = readiness.canExecute
const runtime = jobStore && runService && provider && estimateCostMicros
  ? createAnalysisProviderRuntime({ store: jobStore, broker: runService.broker, provider,
      leaseMs: config.leaseMs, estimateCostMicros,
      canInvoke: canExecute,
      policy: config.provider.mode === 'openai-compatible' ? config.provider.invocationPolicy : undefined })
  : undefined
const dispatcher = runtime && jobStore && runService ? new PersistentDispatcher({
  store: jobStore, evidence: runtime.evidence, artifacts: runtime.artifacts,
  cleanupExpired: () => runService.cleanupExpired(config.cleanupBatchSize),
  leaseMs: config.leaseMs, pollMs: config.ssePollMs, maxRunMs: 30 * 60_000,
  canDispatch: canExecute,
  onError: (error) => server.log.error({ event: 'analysis.dispatcher.failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'analysis dispatcher failed'),
}) : undefined
const server = await buildAnalysisServer(config, {
  runService,
  availability: personal ? () => personal.availability() : readiness.availability,
  personalRuntime: personal,
})
let cleanupRunning = false
let cleanupTimer: NodeJS.Timeout | undefined

const cleanupExpiredContent = async (): Promise<void> => {
  if (!runService || cleanupRunning) return
  cleanupRunning = true
  try {
    const result = await runService.cleanupExpired(config.cleanupBatchSize)
    if (result.cleaned > 0) {
      server.log.info({ event: 'analysis.content.cleaned', ...result }, 'expired analysis content cleaned')
    }
  } catch (error) {
    server.log.error({
      event: 'analysis.content.cleanup_failed',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'expired analysis content cleanup failed')
  } finally {
    cleanupRunning = false
  }
}

let shutdownPromise: Promise<void> | undefined
const shutdown = (signal: NodeJS.Signals | 'parent-ipc'): Promise<void> => shutdownPromise ??= (async () => {
  shuttingDown = true
  if (cleanupTimer) clearInterval(cleanupTimer)
  server.log.info({ event: 'analysis.service.shutdown', signal }, 'analysis service shutting down')
  const forcedExit = setTimeout(() => {
    server.log.fatal({ event: 'analysis.service.shutdown_timeout', signal }, 'analysis service shutdown timed out')
    process.exit(1)
  }, config.shutdownTimeoutMs)
  forcedExit.unref()
  let drained = true
  try {
    await dispatcher?.stop(config.shutdownTimeoutMs)
    await personal?.close()
  } catch {
    drained = false
    process.exitCode = 1
  } finally {
    try {
      await server.close()
      if (drained) await jobStore?.close()
    } finally {
      if (drained) clearTimeout(forcedExit)
      if (process.connected) process.disconnect()
    }
  }
})()

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'cat.analysis.shutdown') {
    void shutdown('parent-ipc')
  }
})

try {
  await server.listen({ host: config.host, port: config.port })
  await personal?.initialize()
  if (await canExecute()) await dispatcher?.start()
  if (runService && !config.personalReadOnly) {
    await cleanupExpiredContent()
    cleanupTimer = setInterval(() => void cleanupExpiredContent(), config.cleanupIntervalMs)
    cleanupTimer.unref()
  }
  server.log.info({
    event: 'analysis.service.started',
    host: config.host,
    port: config.port,
    version: config.serviceVersion,
  }, 'analysis service started')
} catch (error) {
  server.log.fatal({
    event: 'analysis.service.start_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError',
  }, 'analysis service failed to start')
  process.exitCode = 1
  await dispatcher?.stop(config.shutdownTimeoutMs)
  await personal?.close()
  await server.close()
  await jobStore?.close()
  if (process.connected) process.disconnect()
}
