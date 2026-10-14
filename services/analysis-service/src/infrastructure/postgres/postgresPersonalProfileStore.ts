import { randomUUID } from 'node:crypto'
import { canonicalizeJson, type AnalysisEventV1, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import type { AnalysisServiceConfig } from '../../config.js'
import type { ContentCipher, EncryptedContent } from '../contentCipher.js'
import type { PostgresJobStore } from './postgresJobStore.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError, storedPersonalSettingsSchema, type PersonalProfileState, type PersonalProfileStore, type PersonalProviderSnapshot, type PersonalSavedSettings } from '../../personal/profileStore.js'

export const PERSONAL_PROFILE_SCHEMA_VERSION = 2
const LOCK_KEY = 1_669_082_374
const encryptionContext = (id: string) => `cat-analysis-personal-profile-v1:${id}`
interface StateRow extends QueryResultRow { revision: string | number; profile_id: string | null; enabled: boolean; check_state: PersonalProfileState['checkState'] }
interface SnapshotRow extends QueryResultRow { profile_id: string; key_id: string | null; iv: Buffer | null; auth_tag: Buffer | null; ciphertext: Buffer | null; settings_json: unknown }
const publicSettings = (settings: PersonalSavedSettings) => ({ version: 1 as const, providerId: settings.providerId,
  baseUrl: settings.baseUrl, modelId: settings.modelId, protocol: settings.protocol,
  structuredOutput: settings.structuredOutput, networkMode: settings.networkMode })
const decodeState = (row: StateRow | undefined): PersonalProfileState => {
  if (!row) throw new PersonalProfileUnavailableError()
  const revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision < 0) throw new PersonalProfileUnavailableError()
  return { revision, profileId: row.profile_id ?? undefined, enabled: row.enabled, checkState: row.check_state }
}

/** One personal owner per database. Losing the session lock closes admission until restart. */
export class PostgresPersonalProfileStore implements PersonalProfileStore {
  private healthy = true
  private closed = false
  private healthProbe?: Promise<boolean>
  private constructor(private readonly pool: Pool, private readonly lockClient: PoolClient,
    private readonly cipher: ContentCipher, private readonly jobs: PostgresJobStore) {
    pool.on('error', () => { this.healthy = false })
    lockClient.on('error', () => { this.healthy = false })
    lockClient.on('end', () => { this.healthy = false })
  }
  static async connect(config: Extract<AnalysisServiceConfig['jobStore'], { mode: 'postgres' }>, cipher: ContentCipher,
    jobs: PostgresJobStore): Promise<PostgresPersonalProfileStore> {
    const pool = new Pool({ connectionString: config.connectionString, connectionTimeoutMillis: config.connectTimeoutMs,
      max: 3, ssl: config.ssl === 'require' ? { rejectUnauthorized: true } : false, application_name: 'cat-analysis-personal-profiles' })
    // Install a listener before connecting; error text can contain credentials.
    pool.on('error', () => undefined)
    let client: PoolClient | undefined
    try {
      client = await pool.connect()
      client.on('error', () => undefined)
      const locked = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_KEY])
      if (!locked.rows[0]?.acquired) throw new PersonalProfileUnavailableError()
      await client.query('BEGIN')
      try {
        await client.query('CREATE TABLE IF NOT EXISTS cat_analysis_personal_schema_migrations(version INTEGER PRIMARY KEY CHECK(version > 0))')
        const result = await client.query<{ version: number | null }>('SELECT MAX(version)::integer AS version FROM cat_analysis_personal_schema_migrations')
        const version = result.rows[0]?.version ?? 0
        if (version > PERSONAL_PROFILE_SCHEMA_VERSION) throw new PersonalProfileUnavailableError()
        if (version === 0) {
          await client.query(`
            CREATE TABLE cat_analysis_personal_profiles (
              profile_id UUID PRIMARY KEY, created_at BIGINT NOT NULL,
              key_id TEXT, iv BYTEA, auth_tag BYTEA, ciphertext BYTEA,
              CHECK ((key_id IS NULL AND iv IS NULL AND auth_tag IS NULL AND ciphertext IS NULL)
                OR (key_id IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL AND ciphertext IS NOT NULL))
            );
            CREATE TABLE cat_analysis_personal_state (
              singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision BIGINT NOT NULL CHECK(revision >= 0),
              profile_id UUID REFERENCES cat_analysis_personal_profiles(profile_id), enabled BOOLEAN NOT NULL,
              check_state TEXT NOT NULL CHECK(check_state IN ('unchecked','ready','failed','unsupported')),
              CHECK (NOT enabled OR (profile_id IS NOT NULL AND check_state IN ('ready','unsupported')))
            );
            INSERT INTO cat_analysis_personal_state(singleton,revision,enabled,check_state) VALUES(TRUE,0,FALSE,'unchecked');
            CREATE TABLE cat_analysis_personal_run_profiles (
              run_id TEXT NOT NULL, tenant_id TEXT NOT NULL, profile_id UUID NOT NULL REFERENCES cat_analysis_personal_profiles(profile_id),
              PRIMARY KEY(run_id,tenant_id), FOREIGN KEY(run_id,tenant_id) REFERENCES analysis_runs(run_id,tenant_id) ON DELETE CASCADE
            );
            CREATE INDEX cat_analysis_personal_run_profile_idx ON cat_analysis_personal_run_profiles(profile_id);
            INSERT INTO cat_analysis_personal_schema_migrations(version) VALUES(1);
          `)
        }
        if (version < 2) {
          await client.query('ALTER TABLE cat_analysis_personal_profiles ADD COLUMN settings_json JSONB')
          const profiles = await client.query<SnapshotRow>('SELECT profile_id,key_id,iv,auth_tag,ciphertext FROM cat_analysis_personal_profiles WHERE ciphertext IS NOT NULL')
          for (const row of profiles.rows) {
            if (!row.key_id || !row.iv || !row.auth_tag || !row.ciphertext) throw new PersonalProfileUnavailableError()
            const settings = storedPersonalSettingsSchema.parse(JSON.parse(cipher.decrypt({ keyId: row.key_id, iv: row.iv,
              authTag: row.auth_tag, ciphertext: row.ciphertext }, encryptionContext(row.profile_id))))
            await client.query('UPDATE cat_analysis_personal_profiles SET settings_json=$1 WHERE profile_id=$2', [publicSettings(settings), row.profile_id])
          }
          await client.query(`ALTER TABLE cat_analysis_personal_profiles
            ADD CONSTRAINT cat_analysis_personal_metadata_safe CHECK(settings_json IS NULL OR (jsonb_typeof(settings_json)='object' AND NOT (settings_json ? 'apiKey'))),
            ADD CONSTRAINT cat_analysis_personal_cipher_has_metadata CHECK(ciphertext IS NULL OR settings_json IS NOT NULL);
            INSERT INTO cat_analysis_personal_schema_migrations(version) VALUES(2)`)
        }
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      return new PostgresPersonalProfileStore(pool, client, cipher, jobs)
    } catch (error) {
      client?.release(true)
      await pool.end()
      throw error
    }
  }
  async readState(): Promise<PersonalProfileState> {
    this.assertHealthy()
    return decodeState((await this.pool.query<StateRow>('SELECT revision,profile_id,enabled,check_state FROM cat_analysis_personal_state WHERE singleton=TRUE')).rows[0])
  }
  async getSnapshot(profileId: string): Promise<PersonalProviderSnapshot | undefined> {
    this.assertHealthy()
    const row = (await this.pool.query<SnapshotRow>('SELECT profile_id,key_id,iv,auth_tag,ciphertext,settings_json FROM cat_analysis_personal_profiles WHERE profile_id=$1', [profileId])).rows[0]
    if (!row) return undefined
    if (!row.key_id || !row.iv || !row.auth_tag || !row.ciphertext) {
      return row.settings_json ? { id: row.profile_id, settings: storedPersonalSettingsSchema.parse(row.settings_json), revoked: true } : undefined
    }
    const encrypted: EncryptedContent = { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }
    const settings = storedPersonalSettingsSchema.parse(JSON.parse(this.cipher.decrypt(encrypted, encryptionContext(row.profile_id))))
    if (canonicalizeJson(publicSettings(settings)) !== canonicalizeJson(row.settings_json)) throw new PersonalProfileUnavailableError()
    return { id: row.profile_id, settings, revoked: false }
  }
  async save(expectedRevision: number, settings: PersonalSavedSettings): Promise<PersonalProfileState> {
    const parsed = storedPersonalSettingsSchema.parse(settings)
    return this.mutate(expectedRevision, async (client) => {
      const id = randomUUID()
      const encrypted = this.cipher.encrypt(JSON.stringify(parsed), encryptionContext(id))
      await client.query('INSERT INTO cat_analysis_personal_profiles(profile_id,created_at,key_id,iv,auth_tag,ciphertext,settings_json) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, Date.now(), encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext, publicSettings(parsed)])
      await client.query("UPDATE cat_analysis_personal_state SET revision=revision+1,profile_id=$1,enabled=FALSE,check_state='unchecked' WHERE singleton=TRUE", [id])
    })
  }
  async setCheck(expectedRevision: number, result: 'ready' | 'failed' | 'unsupported'): Promise<PersonalProfileState> {
    return this.mutate(expectedRevision, async (client, state) => {
      if (!state.profileId) throw new PersonalProfileUnavailableError()
      await client.query('UPDATE cat_analysis_personal_state SET revision=revision+1,check_state=$1,enabled=FALSE WHERE singleton=TRUE', [result])
    })
  }
  async setEnabled(expectedRevision: number, enabled: boolean): Promise<PersonalProfileState> {
    return this.mutate(expectedRevision, async (client, state) => {
      if (enabled && (!state.profileId || !['ready', 'unsupported'].includes(state.checkState))) throw new PersonalProfileUnavailableError()
      await client.query('UPDATE cat_analysis_personal_state SET revision=revision+1,enabled=$1 WHERE singleton=TRUE', [enabled])
    })
  }
  async clear(expectedRevision: number): Promise<PersonalProfileState> {
    return this.mutate(expectedRevision, async (client) => {
      await client.query("UPDATE cat_analysis_personal_state SET revision=revision+1,profile_id=NULL,enabled=FALSE,check_state='unchecked' WHERE singleton=TRUE")
    })
  }
  async revokeHistoricSecrets(retainProfileId?: string): Promise<void> {
    this.assertHealthy()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const state = decodeState((await client.query<StateRow>('SELECT revision,profile_id,enabled,check_state FROM cat_analysis_personal_state WHERE singleton=TRUE FOR UPDATE')).rows[0])
      if (state.profileId !== retainProfileId) throw new PersonalProfileConflictError()
      // Old workers are drained before the manager removes obsolete credentials.
      await client.query('UPDATE cat_analysis_personal_profiles SET key_id=NULL,iv=NULL,auth_tag=NULL,ciphertext=NULL WHERE $1::uuid IS NULL OR profile_id<>$1', [retainProfileId ?? null])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async getRunSnapshot(tenantId: string, runId: string): Promise<PersonalProviderSnapshot | undefined> {
    this.assertHealthy()
    const row = (await this.pool.query<{ profile_id: string }>('SELECT profile_id FROM cat_analysis_personal_run_profiles WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId])).rows[0]
    return row ? this.getSnapshot(row.profile_id) : undefined
  }
  async createRun(tenantId: string, run: AnalysisRunV1, event: AnalysisEventV1) {
    const state = await this.readState()
    if (!state.enabled || !state.profileId || !['ready', 'unsupported'].includes(state.checkState)) throw new PersonalProfileUnavailableError()
    return this.jobs.createRun(tenantId, run, event, { profileId: state.profileId, revision: state.revision })
  }
  async listBoundActiveRuns() {
    this.assertHealthy()
    const result = await this.pool.query<{ tenant_id: string; run_id: string }>(`
      SELECT run.tenant_id,run.run_id FROM analysis_runs run JOIN cat_analysis_personal_run_profiles binding
      ON binding.run_id=run.run_id AND binding.tenant_id=run.tenant_id
      WHERE run.status NOT IN ('partial','succeeded','cancelled','failed','expired') ORDER BY run.created_at
    `)
    return result.rows.map((row) => ({ tenantId: row.tenant_id, runId: row.run_id }))
  }
  async listDispatchableRuns(now: number, limit: number) {
    this.assertHealthy()
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be positive')
    const result = await this.pool.query<{ tenant_id: string; run_id: string }>(`
      SELECT run.tenant_id,run.run_id FROM analysis_runs run JOIN cat_analysis_personal_run_profiles binding
      ON binding.run_id=run.run_id AND binding.tenant_id=run.tenant_id
      JOIN cat_analysis_personal_state state ON state.singleton=TRUE AND state.profile_id=binding.profile_id AND state.enabled=TRUE
      LEFT JOIN analysis_leases dispatch_lease ON dispatch_lease.run_id=run.run_id AND dispatch_lease.node_key='dispatcher:run'
      WHERE run.content_deleted_at IS NULL AND run.expires_at>$1
        AND run.status IN ('queued','planning','mapping','merging','generating')
        AND COALESCE(dispatch_lease.expires_at,0)<=$1
      ORDER BY GREATEST(run.updated_at,COALESCE(dispatch_lease.expires_at,0)),run.run_id LIMIT $2
    `, [now, limit])
    return result.rows.map((row) => ({ tenantId: row.tenant_id, runId: row.run_id }))
  }
  async listExpiredRuns(now: number, limit: number) {
    this.assertHealthy()
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be positive')
    const result = await this.pool.query<{ tenant_id: string; run_id: string }>(`
      SELECT run.tenant_id,run.run_id FROM analysis_runs run JOIN cat_analysis_personal_run_profiles binding
      ON binding.run_id=run.run_id AND binding.tenant_id=run.tenant_id
      WHERE run.content_deleted_at IS NULL AND run.expires_at<=$1 ORDER BY run.expires_at,run.run_id LIMIT $2
    `, [now, limit])
    return result.rows.map((row) => ({ tenantId: row.tenant_id, runId: row.run_id }))
  }
  async checkHealth(): Promise<boolean> {
    if (!this.healthy || this.closed) return false
    if (this.healthProbe) return this.healthProbe
    // The owner connection carries a session lock. Coalesce concurrent probes:
    // pg@9 will no longer queue overlapping queries on this same client.
    const probe = this.lockClient.query<{ healthy: number }>('SELECT 1 AS healthy')
      .then((result) => !this.closed && this.healthy && result.rows[0]?.healthy === 1)
      .catch(() => { this.healthy = false; return false })
    this.healthProbe = probe
    try { return await probe } finally { if (this.healthProbe === probe) this.healthProbe = undefined }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.healthy = false
    this.lockClient.release(true)
    await this.pool.end()
  }
  private assertHealthy(): void { if (!this.healthy || this.closed) throw new PersonalProfileUnavailableError() }
  private async mutate(expectedRevision: number, apply: (client: PoolClient, state: PersonalProfileState) => Promise<void>): Promise<PersonalProfileState> {
    this.assertHealthy()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const state = decodeState((await client.query<StateRow>('SELECT revision,profile_id,enabled,check_state FROM cat_analysis_personal_state WHERE singleton=TRUE FOR UPDATE')).rows[0])
      if (state.revision !== expectedRevision) throw new PersonalProfileConflictError()
      await apply(client, state)
      const next = decodeState((await client.query<StateRow>('SELECT revision,profile_id,enabled,check_state FROM cat_analysis_personal_state WHERE singleton=TRUE')).rows[0])
      await client.query('COMMIT')
      return next
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
