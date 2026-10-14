import { loadAnalysisServiceConfig } from '../../src/config.js'
import { InMemoryJobStore } from '../../src/infrastructure/memoryJobStore.js'
import type { TargetValidationOptions } from '../../src/release/targetValidation.js'
import { FakeAnalysisProvider } from './fakeAnalysisProvider.js'

export const targetFixtureConfig = () => loadAnalysisServiceConfig({
  ANALYSIS_JOB_STORE: 'postgres', ANALYSIS_DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/cat_analysis_test',
  ANALYSIS_DATABASE_SSL: 'disable', ANALYSIS_CONTENT_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64'),
  ANALYSIS_PROVIDER_MODE: 'openai-compatible', ANALYSIS_PROVIDER_BASE_URL: 'https://models.synthetic.test/v1',
  ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.synthetic.test', ANALYSIS_PROVIDER_ID: 'synthetic-provider',
  ANALYSIS_PROVIDER_API_KEY: 'synthetic-not-a-real-provider-secret', ANALYSIS_PROVIDER_MODEL_ID: 'synthetic-model',
  ANALYSIS_PROVIDER_PROFILE_VERSION: 'synthetic-v1', ANALYSIS_PROVIDER_MAX_ATTEMPTS: '1',
  ANALYSIS_PROVIDER_INPUT_MICROS_PER_MILLION_TOKENS: '1000000', ANALYSIS_PROVIDER_OUTPUT_MICROS_PER_MILLION_TOKENS: '1000000',
  ANALYSIS_LEASE_MS: '1000', ANALYSIS_SSE_POLL_MS: '200',
})
export const targetFixtureBuild = { serviceVersion: '0.1.0', commit: 'a'.repeat(40), artifactDigest: 'b'.repeat(64) }
export const targetFixtureBudget = { maxEstimatedTokens: 200_000, maxEstimatedCostMicros: 100_000, timeoutMs: 30_000 }
export const targetFixture = (executionId = 'c'.repeat(32)) => {
  const store = new InMemoryJobStore()
  const provider = new FakeAnalysisProvider()
  const options: TargetValidationOptions = { config: targetFixtureConfig(), build: targetFixtureBuild, executionId,
    budget: targetFixtureBudget, provider, connect: async () => store, estimateCostMicros: () => 100,
    canExecute: async () => true, saveCheckpoint: async () => undefined }
  return { store, provider, options }
}
