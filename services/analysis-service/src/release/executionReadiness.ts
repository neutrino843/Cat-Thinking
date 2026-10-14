import type { EngineAvailability } from '../domain/capabilities.js'
import type { ReleaseDecision } from './releaseAttestation.js'

export const createExecutionReadiness = (options: {
  readonly release: { status(): Promise<ReleaseDecision> }
  readonly store?: { checkHealth(): Promise<boolean> }
  readonly provider?: { isReady(): boolean }
  readonly usageReady: boolean
  readonly dispatcherReady: () => boolean
  readonly shuttingDown: () => boolean
}) => {
  const availability = async (): Promise<EngineAvailability> => {
    let storeReady = false
    let providerReady = false
    let verified = false
    try { storeReady = await options.store?.checkHealth() ?? false } catch { /* Fail closed. */ }
    try { providerReady = options.provider?.isReady() ?? false } catch { /* Fail closed. */ }
    try { verified = (await options.release.status()).ready } catch { /* Fail closed. */ }
    const running = !options.shuttingDown()
    return { jobStoreReady: storeReady, providerReady, usageReady: options.usageReady,
      dispatcherReady: running && options.dispatcherReady(), recoveryReady: running && verified, liveSmokeReady: running && verified }
  }
  const canExecute = async (): Promise<boolean> => {
    const state = await availability()
    // Dispatcher startup and each network attempt share these prerequisites.
    return !!(state.jobStoreReady && state.providerReady && state.usageReady && state.recoveryReady && state.liveSmokeReady)
  }
  return { availability, canExecute }
}
