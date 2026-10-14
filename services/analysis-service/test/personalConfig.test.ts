import { describe, expect, it } from 'vitest'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { personalFixtureConfig } from './fixtures/personalProviderFixture.js'

const environment = { NODE_ENV: 'test', ANALYSIS_OPERATING_MODE: 'personal', ANALYSIS_HOST: '127.0.0.1',
  ANALYSIS_CORS_ORIGINS: 'http://127.0.0.1:5173', ANALYSIS_AUTH_MODE: 'service-token',
  ANALYSIS_SERVICE_TOKEN: 'synthetic-personal-service-token-not-a-real-secret', ANALYSIS_JOB_STORE: 'postgres',
  ANALYSIS_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/cat_analysis_test',
  ANALYSIS_CONTENT_ENCRYPTION_KEY: Buffer.alloc(32, 47).toString('base64') }
describe('personal mode network and deployment separation', () => {
  it('defaults to protected deployment and accepts authenticated loopback-only personal mode', () => {
    expect(loadAnalysisServiceConfig().operatingMode).toBe('deployment')
    expect(loadAnalysisServiceConfig().personalReadOnly).toBe(false)
    expect(loadAnalysisServiceConfig({ ...environment, ANALYSIS_PERSONAL_READ_ONLY: 'true' }).personalReadOnly).toBe(true)
    expect(() => loadAnalysisServiceConfig({ ANALYSIS_PERSONAL_READ_ONLY: 'true' })).toThrow()
    expect(personalFixtureConfig().operatingMode).toBe('personal')
    expect(loadAnalysisServiceConfig({ ...environment, ANALYSIS_HOST: '::1', ANALYSIS_CORS_ORIGINS: 'http://[::1]:5173',
      ANALYSIS_DATABASE_URL: 'postgresql://synthetic:synthetic@[::1]/cat_analysis_test' }).operatingMode).toBe('personal')
  })
  it.each([
    { NODE_ENV: 'production' }, { ANALYSIS_HOST: '0.0.0.0' }, { ANALYSIS_AUTH_MODE: 'disabled' },
    { ANALYSIS_CORS_ORIGINS: '' }, { ANALYSIS_CORS_ORIGINS: 'https://example.com' }, { ANALYSIS_TRUST_PROXY_HOPS: '1' },
    { ANALYSIS_JOB_STORE: 'disabled' }, { ANALYSIS_DATABASE_URL: 'postgresql://synthetic:synthetic@remote.example/cat_analysis_test' },
    { ANALYSIS_PROVIDER_MODE: 'openai-compatible' }, { ANALYSIS_RELEASE_HOLD: 'false' },
  ])('rejects personal boundary override %j', (override) => {
    expect(() => loadAnalysisServiceConfig({ ...environment, ...override })).toThrow()
  })
})
