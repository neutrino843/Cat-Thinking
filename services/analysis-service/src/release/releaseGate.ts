import type { AnalysisServiceConfig } from '../config.js'
import { readBoundedFile, type BuildIdentity } from './buildIdentity.js'
import { configurationHash, verifyReleaseAttestation, type ReleaseDecision } from './releaseAttestation.js'

export class ReleaseGate {
  constructor(private readonly options: {
    readonly config: AnalysisServiceConfig; readonly build?: BuildIdentity; readonly now?: () => number
    readonly read?: (path: string, maxBytes: number) => Promise<string>
  }) {}
  async status(): Promise<ReleaseDecision> {
    const { config, build } = this.options
    if (config.release.hold) return { ready: false, reason: 'held' }
    if (!build || build.serviceVersion !== config.serviceVersion || !config.release.attestationPath || !config.release.publicKeyPath) return { ready: false, reason: 'not_configured' }
    try {
      const read = this.options.read ?? readBoundedFile
      const [receipt, publicKey] = await Promise.all([
        read(config.release.attestationPath, 32768), read(config.release.publicKeyPath, 4096),
      ])
      return verifyReleaseAttestation({ value: JSON.parse(receipt), publicKey, build,
        configurationHash: configurationHash(config), now: (this.options.now ?? Date.now)() })
    } catch { return { ready: false, reason: 'invalid' } }
  }
}
