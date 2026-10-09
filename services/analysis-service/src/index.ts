import { buildAnalysisServer } from './api/server.js'
import { loadAnalysisServiceConfig } from './config.js'
import { RunService } from './domain/runService.js'
import type { JobStore } from './domain/jobStore.js'
import { AesGcmContentCipher, decodeContentEncryptionKey } from './infrastructure/contentCipher.js'
import { PostgresJobStore } from './infrastructure/postgres/postgresJobStore.js'

const config = loadAnalysisServiceConfig()
let jobStore: JobStore | undefined
if (config.jobStore.mode === 'postgres') {
  const cipher = new AesGcmContentCipher(decodeContentEncryptionKey(config.jobStore.encryptionKey))
  jobStore = await PostgresJobStore.connectFromConfig(config.jobStore, cipher)
}
const runService = jobStore ? new RunService({ store: jobStore, retentionSeconds: config.retentionSeconds }) : undefined
const server = await buildAnalysisServer(config, { runService, acceptsRuns: false })
let shuttingDown = false
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

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  if (cleanupTimer) clearInterval(cleanupTimer)
  server.log.info({ event: 'analysis.service.shutdown', signal }, 'analysis service shutting down')
  const forcedExit = setTimeout(() => {
    server.log.fatal({ event: 'analysis.service.shutdown_timeout', signal }, 'analysis service shutdown timed out')
    process.exitCode = 1
  }, config.shutdownTimeoutMs)
  forcedExit.unref()
  try {
    await server.close()
  } finally {
    clearTimeout(forcedExit)
    await jobStore?.close()
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await server.listen({ host: config.host, port: config.port })
  if (runService) {
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
  await server.close()
  await jobStore?.close()
}
