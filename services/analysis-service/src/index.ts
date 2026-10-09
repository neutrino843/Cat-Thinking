import { buildAnalysisServer } from './api/server.js'
import { loadAnalysisServiceConfig } from './config.js'

const config = loadAnalysisServiceConfig()
const server = await buildAnalysisServer(config)
let shuttingDown = false

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
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
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await server.listen({ host: config.host, port: config.port })
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
}
