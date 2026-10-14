import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { configurationHash } from '../src/release/releaseAttestation.js'
import { targetValidationScope, validateTargetDeployment, type TargetValidationCheckpoint } from '../src/release/targetValidation.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, prepareFixtureRun } from './fixtures/fakeAnalysisProvider.js'
import { targetFixtureBuild, targetFixtureBudget, targetFixtureConfig } from './fixtures/targetValidationFixture.js'
import { assertDedicatedPostgresTestDatabase } from './fixtures/postgresTestSafety.js'
import { acquireSyntheticDatabaseLock } from './fixtures/syntheticDatabaseLock.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
if (databaseUrl) assertDedicatedPostgresTestDatabase(databaseUrl)
const key = Buffer.alloc(32, 31)
const rawPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined
let unlock: (() => Promise<void>) | undefined
const connect = (schemaPolicy: 'migrate' | 'require-current' = 'require-current') => PostgresJobStore.connect({
  connectionString: databaseUrl!, ssl: 'disable', poolMax: 4, connectTimeoutMs: 10000,
  cipher: new AesGcmContentCipher(key), schemaPolicy,
})
beforeAll(async () => {
  if (!rawPool) return
  unlock = await acquireSyntheticDatabaseLock(rawPool)
  const bootstrap = await connect('migrate'); await bootstrap.close()
})
afterAll(async () => { await unlock?.(); await rawPool?.end() })
const fixture = () => {
  const original = targetFixtureConfig()
  const config = { ...original, jobStore: { mode: 'postgres' as const, connectionString: databaseUrl!, ssl: 'disable' as const,
    poolMax: 4, connectTimeoutMs: 10000, encryptionKey: key.toString('base64') } }
  const provider = new FakeAnalysisProvider()
  const options = { config, build: targetFixtureBuild, executionId: randomBytes(16).toString('hex'),
    budget: targetFixtureBudget, provider, connect, estimateCostMicros: () => 100,
    canExecute: async () => true, saveCheckpoint: async () => undefined }
  return { provider, options }
}
const businessSnapshot = async (runId: string) => {
  if (!rawPool) throw new Error('test database missing')
  const result = await rawPool.query(`SELECT
    (SELECT to_jsonb(r) FROM analysis_runs r WHERE run_id=$1) run,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY source_id) FROM analysis_sources s WHERE run_id=$1) sources,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY part_index) FROM analysis_source_parts p WHERE run_id=$1) parts,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY invocation_id) FROM analysis_provider_invocations i WHERE run_id=$1) ledger`, [runId])
  return result.rows[0]
}

describe.skipIf(!databaseUrl)('PostgreSQL target validation without global cleanup', () => {
  it('preserves existing business content and usage while validating and cleaning only its synthetic run', async () => {
    const seeded = await connect()
    let businessRun: string | undefined
    try {
      businessRun = (await prepareFixtureRun(seeded, `business-preserved-${randomBytes(16).toString('hex')}`)).runId
      await seeded.reserveProviderInvocation({ tenantId: FIXTURE_TENANT, runId: businessRun, invocationId: `business-ledger-${businessRun}`,
        nodeKey: 'business:synthetic', runAttempt: 1, role: 'artifact-summary', providerId: 'synthetic-provider', modelId: 'synthetic-model',
        profileVersion: 'synthetic-v1', promptVersion: 'artifact-v1', estimatedInputTokens: 40, reservedOutputTokens: 20,
        estimatedCostMicros: 100, maxRunEstimatedTokens: 10000, maxRunEstimatedCostMicros: 10000, staleAfterMs: 600000, now: Date.now() })
      await seeded.completeProviderInvocation({ tenantId: FIXTURE_TENANT, invocationId: `business-ledger-${businessRun}`,
        result: 'succeeded', transportAttempts: 1, actualInputTokens: 40, actualOutputTokens: 20, now: Date.now() })
      const before = await businessSnapshot(businessRun)
      const { provider, options } = fixture()
      const result = await validateTargetDeployment(options)
      expect(result.cleanup).toBe('passed'); expect(provider.calls).toHaveLength(6)
      expect(await businessSnapshot(businessRun)).toEqual(before)
      expect(await seeded.getRunLedgerUsage(result.checkpoint.tenantId, result.checkpoint.runId)).toEqual(result.checkpoint.ledger)
      expect(await seeded.listArtifactDescriptors(result.checkpoint.tenantId, result.checkpoint.runId)).toEqual([])
      expect(await seeded.getSourceContent(result.checkpoint.tenantId, result.checkpoint.runId, 'synthetic-source')).toBeUndefined()
      expect(await seeded.getSourceContent(FIXTURE_TENANT, businessRun, 'synthetic-source')).toBeDefined()
    } finally {
      if (businessRun) await seeded.deleteContent(FIXTURE_TENANT, businessRun)
      await seeded.close()
    }
  })
  it('reopens a persisted checkpoint after interruption without creating another paid invocation', async () => {
    const { provider, options } = fixture()
    let checkpoint: TargetValidationCheckpoint | undefined
    await expect(validateTargetDeployment({ ...options, saveCheckpoint: async (value) => { checkpoint = value; throw new Error('synthetic checkpoint interruption') } })).rejects.toThrow('synthetic checkpoint interruption')
    expect(provider.calls).toHaveLength(6)
    const completed = await validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint })
    expect(completed.checkpoint).toEqual(checkpoint); expect(completed.cleanup).toBe('passed')
    expect(provider.calls).toHaveLength(6)
    const again = await validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint })
    expect(again.checkpoint).toEqual(checkpoint); expect(provider.calls).toHaveLength(6)
  })
  it('retains unknown usage across process-style reopening and forbids same-nonce transport replay', async () => {
    const { provider, options } = fixture()
    provider.override = () => { throw new ProviderGatewayError({ providerId: provider.id, kind: 'unavailable', retryable: true,
      safeCode: 'synthetic.response_lost', acceptance: 'unknown' }) }
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'incomplete' })
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'incomplete' })
    expect(provider.calls).toHaveLength(1)
    const reopened = await connect()
    try {
      const scope = targetValidationScope(options.executionId, configurationHash(options.config), options.build)
      const ledger = await reopened.getRunLedgerUsage(scope.tenantId, scope.runId)
      expect(ledger).toMatchObject({ invocationCount: 1, unresolvedCount: 1 })
      await reopened.deleteContent(scope.tenantId, scope.runId)
      expect(await reopened.getRunLedgerUsage(scope.tenantId, scope.runId)).toEqual(ledger)
    } finally { await reopened.close() }
  })
})
