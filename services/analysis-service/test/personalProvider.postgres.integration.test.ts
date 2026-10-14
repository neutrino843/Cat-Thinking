import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { PostgresPersonalProfileStore } from '../src/infrastructure/postgres/postgresPersonalProfileStore.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { PersonalAnalysisRuntime } from '../src/personal/personalRuntime.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError } from '../src/personal/profileStore.js'
import { isTerminalRun, RunService } from '../src/domain/runService.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'
import { createPersonalFixtureFetch, personalFixtureConfig, personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { FakeAnalysisProvider } from './fixtures/fakeAnalysisProvider.js'
import { QualityProfileReader } from '../src/operations/qualityProfileReader.js'
import { verifyPersonalQualitySample } from '../src/operations/personalProviderVerification.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
if (databaseUrl) assertDedicatedPostgresTestDatabase(databaseUrl)
const raw = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined
const cipher = new AesGcmContentCipher(Buffer.alloc(32, 47))
const ownedRuns = new Set<string>()
const open: { runtime?: PersonalAnalysisRuntime; profiles: PostgresPersonalProfileStore; jobs: PostgresJobStore }[] = []
let unlock: (() => Promise<void>) | undefined
const config = () => ({ ...personalFixtureConfig(), jobStore: { mode: 'postgres' as const,
  connectionString: databaseUrl!, ssl: 'disable' as const, poolMax: 4, connectTimeoutMs: 10_000, encryptionKey: Buffer.alloc(32, 47).toString('base64') } })
const connectJobs = () => PostgresJobStore.connectFromConfig(config().jobStore, cipher)
const dropPersonalTestTables = () => raw!.query('DROP TABLE IF EXISTS cat_analysis_personal_run_profiles,cat_analysis_personal_state,cat_analysis_personal_profiles,cat_analysis_personal_schema_migrations')
beforeAll(async () => {
  if (!raw) return
  unlock = await acquireSyntheticDatabaseLock(raw)
  const jobs = await connectJobs(); await jobs.close()
  // These tables contain only this dedicated synthetic database's test profiles.
  await dropPersonalTestTables()
})
afterEach(async () => {
  for (const entry of open.splice(0)) {
    if (entry.runtime) await entry.runtime.close()
    else await entry.profiles.close()
    await entry.jobs.close()
  }
  if (raw && ownedRuns.size) {
    await raw.query('DELETE FROM analysis_runs WHERE run_id=ANY($1::text[])', [[...ownedRuns]])
    ownedRuns.clear()
  }
})
afterAll(async () => { if (raw) await dropPersonalTestTables(); await unlock?.(); await raw?.end() })
const fixture = async (reset = true, transport = createPersonalFixtureFetch()) => {
  const jobs = await connectJobs()
  const profiles = await PostgresPersonalProfileStore.connect(config().jobStore, cipher, jobs)
  if (reset) await profiles.clear((await profiles.readState()).revision)
  const runtime = new PersonalAnalysisRuntime({ config: config(), store: jobs, profiles, fetchImplementation: transport.fetchImplementation })
  const entry = { jobs, profiles, runtime }
  open.push(entry)
  await runtime.initialize()
  return { ...entry, transport }
}
const enable = async (runtime: PersonalAnalysisRuntime, modelId = 'synthetic-model') => {
  const saved = await runtime.save({ ...personalFixtureSettings(modelId), expectedRevision: (await runtime.status()).revision })
  const checked = await runtime.check(saved.revision)
  return runtime.enable(checked.revision)
}
const createRun = async (runtime: PersonalAnalysisRuntime, profiles: PostgresPersonalProfileStore, suffix: string) => {
  const created = await runtime.runService.createRun(FIXTURE_TENANT, {
    ...fixtureRequest(`personal-pg-${suffix}-${randomBytes(8).toString('hex')}`), providerProfileId: (await profiles.readState()).profileId,
  })
  ownedRuns.add(created.run.id)
  return created.run
}
const uploadAndStart = async (runtime: PersonalAnalysisRuntime, run: Awaited<ReturnType<typeof createRun>>) => {
  await runtime.runService.uploadSource(FIXTURE_TENANT, run.id, { version: 1, sourceId: 'synthetic-source',
    contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1,
    start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
  await runtime.runService.startRun(FIXTURE_TENANT, run.id, run.revision)
}
const finish = async (jobs: PostgresJobStore, id: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await jobs.getRun(FIXTURE_TENANT, id)
    if (run && isTerminalRun(run)) return run
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('synthetic personal pipeline did not settle')
}

describe.skipIf(!databaseUrl)('PostgreSQL personal provider authorization and recovery', () => {
  it('reads quality settings alongside the live owner without mutating settings or binding work to its dispatcher', async () => {
    const f = await fixture(); await enable(f.runtime)
    const state = await f.profiles.readState()
    const reader = new QualityProfileReader(config().jobStore, cipher, f.jobs)
    const fake = new FakeAnalysisProvider()
    try {
      expect(await reader.checkHealth()).toBe(true)
      expect(await reader.readState()).toEqual(state)
      expect('save' in reader).toBe(false)
      const result = await verifyPersonalQualitySample({ store: f.jobs, profiles: reader, maxRunTokens: 50000,
        createProvider: (snapshot) => ({ id: fake.id, modelId: fake.modelId, profileVersion: snapshot.id,
          capabilities: fake.capabilities, isReady: () => true, generate: fake.generate.bind(fake) }) }, 'photosynthesis')
      if (result.runId) ownedRuns.add(result.runId)
      expect(result).toMatchObject({ outcome: 'passed', callsUsed: 6, profileStateUnchanged: true, cleanupComplete: true })
      expect(await f.profiles.readState()).toEqual(state)
      expect(await f.profiles.checkHealth()).toBe(true)
      expect((await raw!.query('SELECT COUNT(*) AS count FROM cat_analysis_personal_run_profiles WHERE run_id=$1', [result.runId])).rows[0].count).toBe('0')
    } finally { await reader.close() }
  })
  it('revokes obsolete encrypted keys after a switch and protects the current secret from stale cleanup', async () => {
    const { runtime, profiles } = await fixture()
    const first = await runtime.save({ ...personalFixtureSettings(), expectedRevision: (await runtime.status()).revision })
    const oldId = (await profiles.readState()).profileId!
    await runtime.save({ ...personalFixtureSettings('synthetic-model-b'), apiKey: undefined, expectedRevision: first.revision })
    const selected = (await profiles.readState()).profileId!
    expect(await profiles.getSnapshot(oldId)).toMatchObject({ revoked: true, settings: { modelId: 'synthetic-model' } })
    expect((await profiles.getSnapshot(oldId))?.settings.apiKey).toBeUndefined()
    expect((await profiles.getSnapshot(selected))?.settings.apiKey).toBe('synthetic-personal-key-not-real')
    await expect(profiles.revokeHistoricSecrets(oldId)).rejects.toBeInstanceOf(PersonalProfileConflictError)
    expect((await profiles.getSnapshot(selected))?.revoked).toBe(false)
    expect(await profiles.getSnapshot('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })
  it('detects altered public metadata and rejects a plaintext credential field in PostgreSQL', async () => {
    const { runtime, profiles } = await fixture()
    await runtime.save({ ...personalFixtureSettings(), expectedRevision: (await runtime.status()).revision })
    const profileId = (await profiles.readState()).profileId!
    const original = (await raw!.query<{ settings_json: unknown }>('SELECT settings_json FROM cat_analysis_personal_profiles WHERE profile_id=$1', [profileId])).rows[0]!.settings_json
    try {
      await expect(raw!.query("UPDATE cat_analysis_personal_profiles SET settings_json=settings_json || '{\"apiKey\":\"public-test-only\"}'::jsonb WHERE profile_id=$1", [profileId])).rejects.toThrow()
      await raw!.query("UPDATE cat_analysis_personal_profiles SET settings_json=jsonb_set(settings_json,'{modelId}','\"altered-model\"') WHERE profile_id=$1", [profileId])
      await expect(profiles.getSnapshot(profileId)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
    } finally { await raw!.query('UPDATE cat_analysis_personal_profiles SET settings_json=$1 WHERE profile_id=$2', [original, profileId]) }
  })
  it('closes ownership readiness when its dedicated lock connection is lost', async () => {
    const { runtime, profiles } = await fixture()
    expect(await Promise.all(Array.from({ length: 20 }, () => profiles.checkHealth()))).toEqual(Array(20).fill(true))
    const owner = await raw!.query<{ pid: number }>(`SELECT activity.pid FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
      WHERE activity.application_name='cat-analysis-personal-profiles' AND lock.locktype='advisory' AND lock.granted
        AND activity.datname=current_database() AND activity.usename=current_user
        AND lock.classid=0 AND lock.objid=1669082374`)
    expect(owner.rows).toHaveLength(1)
    await raw!.query('SELECT pg_terminate_backend($1)', [owner.rows[0]!.pid])
    await expect.poll(() => profiles.checkHealth()).toBe(false)
    expect((await runtime.availability()).personalAuthorized).toBe(false)
  })
  it('reads an enabled persistent connection without running or cancelling queued work in verification mode', async () => {
    const first = await fixture()
    await enable(first.runtime)
    const run = await createRun(first.runtime, first.profiles, 'read-only')
    const state = await first.profiles.readState()
    await first.runtime.close(); await first.jobs.close()
    const entryIndex = open.findIndex((entry) => entry.runtime === first.runtime)
    if (entryIndex >= 0) open.splice(entryIndex, 1)
    const jobs = await connectJobs()
    const profiles = await PostgresPersonalProfileStore.connect(config().jobStore, cipher, jobs)
    const runtime = new PersonalAnalysisRuntime({ config: { ...config(), personalReadOnly: true }, store: jobs, profiles,
      fetchImplementation: first.transport.fetchImplementation })
    open.push({ runtime, profiles, jobs })
    // Seed queued work without starting any dispatcher, then verify each mode
    // discovers only its own persistent queue in this same database.
    const seed = new RunService({ store: jobs, providerProfileMode: 'personal', retentionSeconds: 3600 })
    await seed.uploadSource(FIXTURE_TENANT, run.id, { version: 1, sourceId: 'synthetic-source', contentHash: fixtureHash(FIXTURE_TEXT),
      partHash: fixtureHash(FIXTURE_TEXT), partIndex: 0, partCount: 1, start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT })
    await seed.startRun(FIXTURE_TENANT, run.id, run.revision)
    const legacy = await prepareFixtureRun(jobs, `cross-mode-legacy-${randomBytes(8).toString('hex')}`)
    ownedRuns.add(legacy.runId)
    await runtime.initialize()
    expect(await runtime.status()).toMatchObject({ enabled: true, acceptsRuns: false, configured: true })
    expect(await profiles.readState()).toEqual(state)
    expect((await jobs.getRun(FIXTURE_TENANT, run.id))?.status).toBe('queued')
    const generic = await jobs.listDispatchableRuns(Date.now(), 1000)
    expect(generic).toContainEqual({ tenantId: FIXTURE_TENANT, runId: legacy.runId })
    expect(generic).not.toContainEqual({ tenantId: FIXTURE_TENANT, runId: run.id })
    const personal = await profiles.listDispatchableRuns(Date.now(), 1000)
    expect(personal).toContainEqual({ tenantId: FIXTURE_TENANT, runId: run.id })
    expect(personal).not.toContainEqual({ tenantId: FIXTURE_TENANT, runId: legacy.runId })
    expect(first.transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    await expect(runtime.pause(state.revision)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
  })
  it('encrypts immutable profiles and atomically binds accepted runs while rejecting stale revisions', async () => {
    const { jobs, profiles, runtime } = await fixture()
    await enable(runtime)
    const state = await profiles.readState()
    const run = await createRun(runtime, profiles, 'binding')
    const encrypted = await raw!.query<{ ciphertext: Buffer; key_id: string }>('SELECT ciphertext,key_id FROM cat_analysis_personal_profiles WHERE profile_id=$1', [state.profileId])
    expect(encrypted.rows[0]?.ciphertext.toString('utf8')).not.toContain('synthetic-personal-key')
    expect(encrypted.rows[0]?.key_id).toBe('primary-v1')
    expect((await profiles.getRunSnapshot(FIXTURE_TENANT, run.id))?.id).toBe(state.profileId)
    await expect(profiles.save(state.revision - 1, personalFixtureSettings())).rejects.toBeInstanceOf(PersonalProfileConflictError)
    const saved = await runtime.save({ ...personalFixtureSettings('synthetic-model-b'), expectedRevision: state.revision })
    const checked = await runtime.check(saved.revision); await runtime.enable(checked.revision)
    const forgedRun = { ...run, id: `stale-${randomBytes(8).toString('hex')}`, requestKey: fixtureHash('stale-pg-key'),
      request: { ...run.request, requestKey: fixtureHash('stale-pg-key') } }
    await expect(jobs.createRun(FIXTURE_TENANT, forgedRun, { version: 1, type: 'run.accepted', eventId: 'stale-pg-event', runId: forgedRun.id,
      runRevision: 1, sequence: 0, createdAt: Date.now(), requestKey: forgedRun.requestKey }, { profileId: state.profileId!, revision: state.revision }))
      .rejects.toMatchObject({ reason: 'personal profile changed' })
    expect(await jobs.getRun(FIXTURE_TENANT, forgedRun.id)).toBeUndefined()
    expect((await profiles.getRunSnapshot(FIXTURE_TENANT, run.id))?.settings.modelId).toBe('synthetic-model')
  })
  it('runs all five artifacts through fake HTTP, coordinator, validators, dispatcher and ledger', async () => {
    const { runtime, profiles, jobs, transport } = await fixture()
    expect((await runtime.status()).acceptsRuns).toBe(false)
    await enable(runtime)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    const run = await createRun(runtime, profiles, 'five-artifacts')
    await uploadAndStart(runtime, run)
    const result = await finish(jobs, run.id)
    expect(result.status).toBe('succeeded')
    expect(Object.values(result.artifactStates).every((state) => state.status === 'succeeded')).toBe(true)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(6)
    expect((await jobs.getRunLedgerUsage(FIXTURE_TENANT, run.id))).toMatchObject({ invocationCount: 6, unresolvedCount: 0,
      usage: { inputTokens: 120, outputTokens: 60 } })
    expect((await runtime.status()).pricingKnown).toBe(false)
    expect(result.providerRoutes.every((route) => route.modelId === 'synthetic-model')).toBe(true)
  })
  it('restores a queued run with its original profile after restart and cancels it before a model switch', async () => {
    const first = await fixture()
    const enabled = await enable(first.runtime)
    const run = await createRun(first.runtime, first.profiles, 'restart')
    await first.runtime.close(); await first.jobs.close()
    // fixture returns a spread object; remove the closed resource by identity.
    const entryIndex = open.findIndex((entry) => entry.runtime === first.runtime)
    if (entryIndex >= 0) open.splice(entryIndex, 1)
    const next = await fixture(false, first.transport)
    expect((await next.profiles.getRunSnapshot(FIXTURE_TENANT, run.id))?.settings.modelId).toBe('synthetic-model')
    expect((await next.runtime.status())).toMatchObject({ enabled: true, acceptsRuns: true, revision: enabled.revision })
    await next.runtime.save({ ...personalFixtureSettings('synthetic-model-b'), expectedRevision: enabled.revision })
    expect((await next.jobs.getRun(FIXTURE_TENANT, run.id))?.status).toBe('cancelled')
    expect(first.transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
  it('rejects a second personal instance and allows ownership only after the first closes', async () => {
    const first = await fixture()
    const otherJobs = await connectJobs()
    try {
      await expect(PostgresPersonalProfileStore.connect(config().jobStore, cipher, otherJobs)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
      await first.runtime.close()
      const next = await PostgresPersonalProfileStore.connect(config().jobStore, cipher, otherJobs)
      expect(await next.checkHealth()).toBe(true)
      await next.close()
    } finally { await otherJobs.close() }
  })
  it('clears all historic credentials, retains usage and leaves unbound business runs untouched', async () => {
    const { runtime, profiles, jobs, transport } = await fixture()
    await enable(runtime)
    const completed = await createRun(runtime, profiles, 'clear-ledger')
    await uploadAndStart(runtime, completed); await finish(jobs, completed.id)
    const before = await jobs.getRunLedgerUsage(FIXTURE_TENANT, completed.id)
    const business = await prepareFixtureRun(jobs, `unbound-business-${randomBytes(8).toString('hex')}`)
    ownedRuns.add(business.runId)
    const oldStatus = (await jobs.getRun(FIXTURE_TENANT, business.runId))?.status
    const saved = await runtime.save({ ...personalFixtureSettings('synthetic-model-b'), expectedRevision: (await runtime.status()).revision })
    await runtime.clear(saved.revision)
    expect(await jobs.getRunLedgerUsage(FIXTURE_TENANT, completed.id)).toEqual(before)
    expect((await jobs.getRun(FIXTURE_TENANT, business.runId))?.status).toBe(oldStatus)
    const rows = await raw!.query<{ count: string }>('SELECT COUNT(*) count FROM cat_analysis_personal_profiles WHERE ciphertext IS NOT NULL')
    expect(Number(rows.rows[0]?.count)).toBe(0)
    expect(await profiles.getRunSnapshot(FIXTURE_TENANT, completed.id)).toMatchObject({ revoked: true, settings: { modelId: 'synthetic-model' } })
    expect((await runtime.status()).acceptsRuns).toBe(false)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(6)
  })
  it('upgrades version-one metadata and rejects a future version without resetting profiles', async () => {
    const first = await fixture()
    const saved = await first.runtime.save({ ...personalFixtureSettings(), expectedRevision: (await first.runtime.status()).revision })
    await first.runtime.close()
    await raw!.query('ALTER TABLE cat_analysis_personal_profiles DROP COLUMN settings_json; DELETE FROM cat_analysis_personal_schema_migrations WHERE version=2')
    const migrated = await PostgresPersonalProfileStore.connect(config().jobStore, cipher, first.jobs)
    expect((await migrated.getSnapshot((await migrated.readState()).profileId!))?.settings.modelId).toBe('synthetic-model')
    expect((await raw!.query<{ version: number }>('SELECT MAX(version)::integer version FROM cat_analysis_personal_schema_migrations')).rows[0]?.version).toBe(2)
    await migrated.close()
    await raw!.query('INSERT INTO cat_analysis_personal_schema_migrations(version) VALUES(99)')
    try {
      await expect(PostgresPersonalProfileStore.connect(config().jobStore, cipher, first.jobs)).rejects.toBeInstanceOf(PersonalProfileUnavailableError)
      expect((await raw!.query<{ revision: string }>('SELECT revision FROM cat_analysis_personal_state WHERE singleton=TRUE')).rows[0]?.revision).toBe(String(saved.revision))
    } finally { await raw!.query('DELETE FROM cat_analysis_personal_schema_migrations WHERE version=99') }
  })
  it('reserves the invocation count limit atomically under concurrent callers', async () => {
    const { runtime, profiles, jobs } = await fixture()
    await enable(runtime)
    const run = await createRun(runtime, profiles, 'count-limit')
    const state = await profiles.readState()
    const reservation = (index: number) => jobs.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId: run.id,
      invocationId: `quota-${run.id}-${index}`, nodeKey: `quota:${index}`, runAttempt: 1, role: 'evidence-map', providerId: 'personal-custom',
      modelId: 'synthetic-model', profileVersion: state.profileId!, promptVersion: 'synthetic-v1', estimatedInputTokens: 1,
      reservedOutputTokens: 1, estimatedCostMicros: 0, maxRunEstimatedTokens: 200000, maxRunEstimatedCostMicros: 0,
      maxRunInvocations: 2, staleAfterMs: 600000, now: Date.now() })
    const results = await Promise.all([reservation(1), reservation(2), reservation(3)])
    expect(results.filter((result) => result.outcome === 'reserved')).toHaveLength(2)
    expect(results.find((result) => result.outcome === 'budget_exceeded')).toMatchObject({ dimension: 'invocations', actual: 3, maximum: 2 })
    expect((await jobs.getRunLedgerUsage(FIXTURE_TENANT, run.id))?.invocationCount).toBe(2)
  })
  it('does not replay a transport outcome that is unknown after process restart', async () => {
    const first = await fixture()
    await enable(first.runtime)
    first.transport.failNextPost()
    const run = await createRun(first.runtime, first.profiles, 'unknown')
    await uploadAndStart(first.runtime, run)
    expect((await finish(first.jobs, run.id)).status).toBe('failed')
    expect((await first.jobs.getRunLedgerUsage(FIXTURE_TENANT, run.id))?.unresolvedCount).toBe(1)
    await first.runtime.close(); await first.jobs.close()
    const entryIndex = open.findIndex((entry) => entry.runtime === first.runtime)
    if (entryIndex >= 0) open.splice(entryIndex, 1)
    const next = await fixture(false, first.transport)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(first.transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect((await next.jobs.getRunLedgerUsage(FIXTURE_TENANT, run.id))?.unresolvedCount).toBe(1)
  })
})
