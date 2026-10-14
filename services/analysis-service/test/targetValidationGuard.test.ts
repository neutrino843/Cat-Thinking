import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const environment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_')))
const execute = (script: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [resolve('scripts', script)], { env, encoding: 'utf8', timeout: 10000 })
describe('zero network protected target and CI signer preflight', () => {
  it('does not accept inherited ready markers as authorization', () => {
    const result = execute('run-target-provider-validation.mjs', { ...environment(), ANALYSIS_LIVE_SMOKE_PREREQUISITES_READY: 'true' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('blocked before network access')
    expect(result.stderr).toContain('explicit billable target validation opt-in')
    expect(result.stdout).not.toContain('RUN')
  })
  it('rejects missing trust, dirty build and invalid budgets without exposing credentials', () => {
    const result = execute('run-target-provider-validation.mjs', { ...environment(),
      ANALYSIS_TARGET_VALIDATION: 'I_ACKNOWLEDGE_BILLABLE_NONDESTRUCTIVE_TARGET_VALIDATION',
      ANALYSIS_DATABASE_URL: 'postgresql://business:sensitive-password@localhost/business',
      ANALYSIS_TARGET_VALIDATION_EXECUTION_ID: 'c'.repeat(32), ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_TOKENS: '200001',
      ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_COST_MICROS: '1' })
    expect(result.status).toBe(2); expect(result.stderr).toContain('ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_TOKENS')
    expect(result.stderr).not.toContain('sensitive-password'); expect(result.stdout).not.toContain('RUN')
  })
  it('will not sign local or hand-written CI success flags', () => {
    const result = execute('sign-analysis-ci-prerequisites.mjs', { ...environment(), CI: 'false',
      ANALYSIS_CI_SIGNING: 'I_ACKNOWLEDGE_TRUSTED_CI_SIGNING', ANALYSIS_LIVE_SMOKE_PREREQUISITES_READY: 'true' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('blocked before tests or network')
    expect(result.stderr).toContain('actual Linux GitHub Actions execution')
    expect(result.stdout).not.toContain('RUN')
  })
  it('rejects Windows case aliases between protected key and output paths', () => {
    const identities = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { protectedPathIdentity as id } from "./scripts/protected-path-identity.mjs"; process.stdout.write(JSON.stringify({ windows: id("protected/Key.pem", "win32") === id("protected/KEY.PEM", "win32"), linux: id("protected/Key.pem", "linux") !== id("protected/KEY.PEM", "linux") }))'],
    { cwd: resolve('.'), env: environment(), encoding: 'utf8', timeout: 10000 })
    expect(identities.status).toBe(0)
    expect(JSON.parse(identities.stdout)).toEqual({ windows: true, linux: true })
    if (process.platform !== 'win32') return
    const keyPath = resolve('C:/protected-fixture/private.pem')
    const env = { ...environment(), ANALYSIS_RELEASE_SIGNING_KEY_PATH: keyPath,
      ANALYSIS_RELEASE_PUBLIC_KEY_PATH: resolve('C:/protected-fixture/public.pem'),
      ANALYSIS_CI_PREREQUISITES_PATH: resolve('C:/protected-fixture/ci.json'),
      ANALYSIS_RELEASE_ATTESTATION_PATH: keyPath.toUpperCase(),
      ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH: resolve('C:/protected-fixture/checkpoint.json') }
    const target = execute('run-target-provider-validation.mjs', env)
    expect(target.status).toBe(2); expect(target.stderr).toContain('distinct protected evidence/key/output paths')
    const ci = execute('sign-analysis-ci-prerequisites.mjs', { ...env, ANALYSIS_CI_PREREQUISITES_PATH: keyPath.toUpperCase() })
    expect(ci.status).toBe(2); expect(ci.stderr).toContain('distinct key and output paths')
    expect(target.stdout).not.toContain('RUN'); expect(ci.stdout).not.toContain('RUN')
  })
})
