import { loadAnalysisServiceConfig } from '../config.js'
import { isAbsolute, resolve } from 'node:path'

export interface PreparationEvidence {
  readonly checkout: 'clean' | 'dirty' | 'unavailable'
  readonly build: 'verified' | 'unverified'
  readonly ciPrerequisites: 'verified' | 'missing' | 'invalid'
  readonly signingMaterial?: 'verified' | 'missing' | 'invalid'
}

export type PreparationCheckId = 'configuration' | 'provider' | 'price_bounds' | 'explicit_budget'
  | 'postgres' | 'authenticated_gateway' | 'hold' | 'checkout' | 'build' | 'ci_prerequisites'
  | 'smoke_database' | 'smoke_recovery_database' | 'smoke_budget' | 'smoke_identity' | 'protected_paths'
  | 'signing_material' | 'single_transport_attempt' | 'live_authorization'

export interface ProviderPreparationReport {
  readonly version: 1
  readonly mode: 'offline'
  readonly status: 'blocked' | 'prepared_for_protected_validation'
  readonly checks: readonly Readonly<{ id: PreparationCheckId; passed: boolean }>[]
  readonly liveVerification: 'pending'
  readonly enablesAdmission: false
  readonly networkRequests: 0
  readonly databaseConnections: 0
  readonly providerCalls: 0
}

const positiveInteger = (value: string | undefined): boolean => value !== undefined
  && /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))

/** Configuration checks are preparation, never runtime health or a release attestation. */
export const prepareAnalysisProvider = (
  environment: NodeJS.ProcessEnv,
  evidence: PreparationEvidence,
): ProviderPreparationReport => {
  const checks: { id: PreparationCheckId; passed: boolean }[] = []
  const check = (id: PreparationCheckId, passed: boolean) => { checks.push({ id, passed }) }
  let config: ReturnType<typeof loadAnalysisServiceConfig> | undefined
  try { config = loadAnalysisServiceConfig(environment) } catch { /* Never expose config values or Zod messages. */ }
  check('configuration', config !== undefined)
  check('provider', config?.provider.mode === 'openai-compatible')
  check('price_bounds', config?.provider.mode === 'openai-compatible'
    && config.provider.inputMicrosPerMillionTokens > 0 && config.provider.outputMicrosPerMillionTokens > 0)
  check('explicit_budget', positiveInteger(environment.ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_TOKENS)
    && positiveInteger(environment.ANALYSIS_PROVIDER_MAX_RUN_ESTIMATED_COST_MICROS))
  check('postgres', config?.jobStore.mode === 'postgres')
  check('authenticated_gateway', config?.auth.mode === 'service-token' && config.corsOrigins.length > 0)
  check('hold', config?.release.hold === true)
  check('checkout', evidence.checkout === 'clean')
  check('build', evidence.build === 'verified')
  check('ci_prerequisites', evidence.ciPrerequisites === 'verified')
  let smokeDatabase = false
  try {
    const url = new URL(environment.ANALYSIS_TEST_DATABASE_URL ?? '')
    smokeDatabase = ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/cat_analysis_smoke'
      && config?.jobStore.mode === 'postgres' && config.jobStore.connectionString === environment.ANALYSIS_TEST_DATABASE_URL
  } catch { /* A malformed credential-bearing URL must stay private. */ }
  check('smoke_database', smokeDatabase)
  let recoveryDatabase = false
  try {
    const url = new URL(environment.ANALYSIS_RECOVERY_TEST_DATABASE_URL ?? '')
    recoveryDatabase = ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/cat_analysis_test'
  } catch { /* A malformed credential-bearing URL must stay private. */ }
  check('smoke_recovery_database', recoveryDatabase)
  check('smoke_budget', positiveInteger(environment.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS)
    && Number(environment.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS) <= 200_000
    && positiveInteger(environment.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS)
    && Number(environment.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS) <= 1_000_000)
  check('smoke_identity', /^[a-f0-9]{32}$/u.test(environment.ANALYSIS_LIVE_SMOKE_EXECUTION_ID ?? ''))
  const paths = ['ANALYSIS_CI_PREREQUISITES_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH', 'ANALYSIS_RELEASE_SIGNING_KEY_PATH',
    'ANALYSIS_RELEASE_ATTESTATION_PATH', 'ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH'].map((name) => environment[name])
  check('protected_paths', paths.every((value) => value !== undefined && isAbsolute(value))
    && new Set(paths.map((value) => {
      const path = value ? resolve(value) : ''
      return process.platform === 'win32' ? path.toLowerCase() : path
    })).size === paths.length)
  check('signing_material', evidence.signingMaterial === 'verified')
  check('single_transport_attempt', config?.provider.mode === 'openai-compatible'
    && config.provider.invocationPolicy.maxAttempts === 1)
  check('live_authorization', environment.ANALYSIS_LIVE_SMOKE === 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE')
  return {
    version: 1, mode: 'offline',
    status: checks.every(({ passed }) => passed) ? 'prepared_for_protected_validation' : 'blocked',
    checks, liveVerification: 'pending', enablesAdmission: false,
    networkRequests: 0, databaseConnections: 0, providerCalls: 0,
  }
}
