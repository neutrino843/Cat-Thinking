import { canonicalizeJson, type AnalysisEventV1, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import type { AnalysisServiceConfig } from '../config.js'
import type { JobStore } from '../domain/jobStore.js'
import type { ContentCipher } from '../infrastructure/contentCipher.js'
import { storedPersonalSettingsSchema, PersonalProfileUnavailableError, type PersonalProfileState, type PersonalProviderSnapshot } from '../personal/profileStore.js'
import { PERSONAL_PROFILE_SCHEMA_VERSION } from '../infrastructure/postgres/postgresPersonalProfileStore.js'
import { QUALITY_SAMPLES, qualitySampleHash } from './qualityCorpus.js'

/** Does not acquire the running app's ownership lock, migrate, save, enable or bind any profile.
 * Quality runs are unbound, so the app's personal dispatcher cannot select them. */
export class QualityProfileReader {
  private readonly pool: Pool
  constructor(config: Extract<AnalysisServiceConfig['jobStore'], { mode: 'postgres' }>, private readonly cipher: ContentCipher, private readonly jobs: JobStore) {
    this.pool = new Pool({ connectionString: config.connectionString, max: 2, connectionTimeoutMillis: config.connectTimeoutMs,
      ssl: config.ssl === 'require' ? { rejectUnauthorized: true } : false,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000', application_name: 'cat-analysis-quality-profile-reader' })
    this.pool.on('error', () => undefined)
  }
  async checkHealth(): Promise<boolean> {
    try { const row = (await this.pool.query('SELECT MAX(version) AS version FROM cat_analysis_personal_schema_migrations')).rows[0]
      return Number(row?.version) === PERSONAL_PROFILE_SCHEMA_VERSION } catch { return false }
  }
  async readState(): Promise<PersonalProfileState> {
    const row = (await this.pool.query('SELECT revision,profile_id,enabled,check_state FROM cat_analysis_personal_state WHERE singleton=TRUE')).rows[0]
    if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 0
      || !['unchecked', 'ready', 'failed', 'unsupported'].includes(row.check_state)) throw new PersonalProfileUnavailableError()
    return { revision: Number(row.revision), profileId: row.profile_id ?? undefined, enabled: row.enabled, checkState: row.check_state }
  }
  async getSnapshot(profileId: string): Promise<PersonalProviderSnapshot | undefined> {
    const row = (await this.pool.query('SELECT profile_id,key_id,iv,auth_tag,ciphertext,settings_json FROM cat_analysis_personal_profiles WHERE profile_id=$1', [profileId])).rows[0]
    if (!row || !row.ciphertext || !row.iv || !row.auth_tag || !row.key_id) return undefined
    const settings = storedPersonalSettingsSchema.parse(JSON.parse(this.cipher.decrypt({ keyId: row.key_id, iv: row.iv,
      authTag: row.auth_tag, ciphertext: row.ciphertext }, `cat-analysis-personal-profile-v1:${row.profile_id}`)))
    const { apiKey: ignored, ...publicSettings } = settings
    void ignored
    if (canonicalizeJson(publicSettings) !== canonicalizeJson(row.settings_json)) throw new PersonalProfileUnavailableError()
    return { id: row.profile_id, settings, revoked: false }
  }
  async createRun(tenantId: string, run: AnalysisRunV1, event: AnalysisEventV1) {
    const state = await this.readState()
    if (!tenantId.startsWith('learning-verify-') || !state.enabled || state.profileId !== run.request.providerProfileId
      || run.request.manifest.sources.length !== 1 || !QUALITY_SAMPLES.some((sample) =>
        qualitySampleHash(sample) === run.request.manifest.sources[0]?.contentHash && sample.text.length === run.request.manifest.sources[0]?.charCount)) {
      throw new PersonalProfileUnavailableError()
    }
    return this.jobs.createRun(tenantId, run, event)
  }
  async close(): Promise<void> { await this.pool.end() }
}
