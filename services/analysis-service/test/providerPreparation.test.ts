import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareAnalysisProvider, type PreparationEvidence } from '../src/operations/providerPreparation.js'

const verified: PreparationEvidence = { checkout: 'clean', build: 'verified', ciPrerequisites: 'verified', signingMaterial: 'verified' }
const environment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development', ANALYSIS_RELEASE_HOLD: 'true', ANALYSIS_JOB_STORE: 'postgres',
  ANALYSIS_DATABASE_URL: 'postgresql://synthetic:smoke-password@127.0.0.1/cat_analysis_smoke',
  ANALYSIS_CONTENT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ANALYSIS_AUTH_MODE: 'service-token', ANALYSIS_SERVICE_TOKEN: 'synthetic-token-with-at-least-thirty-two-bytes',
  ANALYSIS_CORS_ORIGINS: 'http://127.0.0.1:5173',
  ANALYSIS_PROVIDER_MODE: 'openai-compatible', ANALYSIS_PROVIDER_ID: 'synthetic',
  ANALYSIS_PROVIDER_BASE_URL: 'https://model.example.test/v1', ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'model.example.test',
  ANALYSIS_PROVIDER_API_KEY: 'synthetic-private-provider-key', ANALYSIS_PROVIDER_MODEL_ID: 'synthetic-model',
  ANALYSIS_PROVIDER_PROFILE_VERSION: 'synthetic-profile', ANALYSIS_PROVIDER_MAX_ATTEMPTS: '1',
  ANALYSIS_PROVIDER_INPUT_MICROS_PER_MILLION_TOKENS: '1000000',
  ANALYSIS_PROVIDER_OUTPUT_MICROS_PER_MILLION_TOKENS: '2000000',
  ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_TOKENS: '200000', ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_COST_MICROS: '1000000',
  ANALYSIS_TEST_DATABASE_URL: 'postgresql://synthetic:smoke-password@127.0.0.1/cat_analysis_smoke',
  ANALYSIS_LIVE_SMOKE: 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE',
  ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS: '200000', ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS: '1000000',
  ANALYSIS_RECOVERY_TEST_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1/cat_analysis_test',
  ANALYSIS_LIVE_SMOKE_EXECUTION_ID: 'a'.repeat(32),
  ANALYSIS_CI_PREREQUISITES_PATH: resolve(tmpdir(), 'synthetic-ci.json'),
  ANALYSIS_RELEASE_PUBLIC_KEY_PATH: resolve(tmpdir(), 'synthetic-public.pem'),
  ANALYSIS_RELEASE_SIGNING_KEY_PATH: resolve(tmpdir(), 'synthetic-private.pem'),
  ANALYSIS_RELEASE_ATTESTATION_PATH: resolve(tmpdir(), 'synthetic-release.json'),
  ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH: resolve(tmpdir(), 'synthetic-checkpoint.json'),
})
const failed = (input: NodeJS.ProcessEnv, evidence: PreparationEvidence = verified) =>
  prepareAnalysisProvider(input, evidence).checks.filter(({ passed }) => !passed).map(({ id }) => id)

describe('offline Provider preparation', () => {
  it('keeps missing configuration blocked without claiming runtime readiness', () => {
    const report = prepareAnalysisProvider({}, { checkout: 'dirty', build: 'unverified', ciPrerequisites: 'missing' })
    expect(report).toMatchObject({ status: 'blocked', liveVerification: 'pending', enablesAdmission: false,
      networkRequests: 0, databaseConnections: 0, providerCalls: 0 })
    expect(failed({})).toContain('provider')
  })

  it('prepares a configured target without enabling admission or performing validation', () => {
    expect(prepareAnalysisProvider(environment(), verified)).toMatchObject({
      status: 'prepared_for_protected_validation', enablesAdmission: false, liveVerification: 'pending',
      networkRequests: 0, databaseConnections: 0, providerCalls: 0,
    })
  })

  it('rejects dirty builds and missing or invalid independently verified prerequisites', () => {
    expect(failed(environment(), { ...verified, checkout: 'dirty' })).toEqual(['checkout'])
    expect(failed(environment(), { ...verified, checkout: 'unavailable', build: 'unverified' })).toEqual(['checkout', 'build'])
    for (const ciPrerequisites of ['missing', 'invalid'] as const) {
      expect(failed(environment(), { ...verified, ciPrerequisites })).toEqual(['ci_prerequisites'])
    }
  })

  it('requires explicit budgets, a held gateway, one transport attempt and smoke authorization', () => {
    const missingBudget = environment()
    delete missingBudget.ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_TOKENS
    delete missingBudget.ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_COST_MICROS
    expect(failed(missingBudget)).toEqual(['explicit_budget'])
    for (const value of ['0', '-1', '1e3', 'NaN', '9007199254740992']) {
      expect(failed({ ...environment(), ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_COST_MICROS: value })).toContain('explicit_budget')
    }
    expect(failed({ ...environment(), ANALYSIS_RELEASE_HOLD: 'false' })).toEqual(['hold'])
    expect(failed({ ...environment(), ANALYSIS_PROVIDER_MAX_ATTEMPTS: '2' })).toEqual(['single_transport_attempt'])
    expect(failed({ ...environment(), ANALYSIS_LIVE_SMOKE: undefined })).toEqual(['live_authorization'])
    expect(failed({ ...environment(), ANALYSIS_AUTH_MODE: 'disabled' })).toEqual(['authenticated_gateway'])
    expect(failed({ ...environment(), ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS: '200001' })).toEqual(['smoke_budget'])
    expect(failed({ ...environment(), ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS: undefined })).toEqual(['smoke_budget'])
    expect(failed({ ...environment(), ANALYSIS_LIVE_SMOKE_EXECUTION_ID: undefined })).toEqual(['smoke_identity'])
    expect(failed(environment(), { ...verified, signingMaterial: 'invalid' })).toEqual(['signing_material'])
    expect(failed({ ...environment(), ANALYSIS_RELEASE_SIGNING_KEY_PATH: environment().ANALYSIS_RELEASE_PUBLIC_KEY_PATH })).toEqual(['protected_paths'])
    const alias = resolve(tmpdir(), 'subdirectory', '..', 'synthetic-public.pem')
    expect(failed({ ...environment(), ANALYSIS_RELEASE_SIGNING_KEY_PATH: alias })).toEqual(['protected_paths'])
    if (process.platform === 'win32') {
      expect(failed({ ...environment(), ANALYSIS_RELEASE_SIGNING_KEY_PATH: environment().ANALYSIS_RELEASE_PUBLIC_KEY_PATH?.toUpperCase() }))
        .toEqual(['protected_paths'])
    }
  })

  it('rejects business/test databases in the destructive smoke slot', () => {
    for (const database of ['cat_analysis_local', 'cat_analysis_test', 'production']) {
      expect(failed({ ...environment(), ANALYSIS_TEST_DATABASE_URL: `postgresql://private:secret@localhost/${database}` }))
        .toEqual(['smoke_database'])
    }
    expect(failed({ ...environment(), ANALYSIS_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1/cat_analysis_local' }))
      .toEqual(['smoke_database'])
    expect(failed({ ...environment(), ANALYSIS_RECOVERY_TEST_DATABASE_URL: environment().ANALYSIS_TEST_DATABASE_URL }))
      .toEqual(['smoke_recovery_database'])
  })

  it('never serializes private configuration or raw parser errors', () => {
    for (const override of [{}, { ANALYSIS_CORS_ORIGINS: 'https://private.example.test/secret-origin' },
      { ANALYSIS_PROVIDER_BASE_URL: 'https://private:secret@models.example.test' },
      { ANALYSIS_DATABASE_URL: 'private-credential-bearing-invalid-url' }]) {
      const result = JSON.stringify(prepareAnalysisProvider({ ...environment(), ...override }, verified))
      for (const secret of ['private-password', 'synthetic-private-provider-key', 'synthetic-token', 'smoke-password',
        'secret-origin', 'private-credential-bearing-invalid-url', 'model.example.test']) expect(result).not.toContain(secret)
    }
  })
})
