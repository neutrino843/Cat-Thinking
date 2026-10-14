import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const environment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_')))
const execute = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [resolve('scripts/run-live-provider-smoke.mjs')], { env, encoding: 'utf8', timeout: 10000 })
describe('protected smoke preflight', () => {
  it('cannot inherit a ready marker to skip missing authorization or configuration', () => {
    const result = execute({ ...environment(), ANALYSIS_LIVE_SMOKE_PREREQUISITES_READY: 'true' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('blocked before network access')
    expect(result.stderr).toContain('explicit billable synthetic smoke opt-in')
    expect(result.stdout).not.toContain('RUN')
  })
  it('rejects a production database and incomplete signing material before running tests', () => {
    const result = execute({ ...environment(), ANALYSIS_LIVE_SMOKE: 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE', ANALYSIS_TEST_DATABASE_URL: 'postgresql://user:sensitive-password@localhost/production', ANALYSIS_RELEASE_SIGNING_KEY_PATH: 'absent-release-private.pem' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('dedicated PostgreSQL cat_analysis_smoke database')
    expect(result.stderr).toContain('Ed25519 signing material')
    expect(result.stderr).not.toContain('sensitive-password')
    expect(result.stdout).not.toContain('RUN')
  })
  it('requires a reusable signed checkpoint and keeps fake recovery out of the billable smoke store', () => {
    const result = execute({ ...environment(), ANALYSIS_LIVE_SMOKE: 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE',
      ANALYSIS_TEST_DATABASE_URL: 'postgresql://synthetic:secret@localhost/cat_analysis_smoke',
      ANALYSIS_RECOVERY_TEST_DATABASE_URL: 'postgresql://synthetic:secret@localhost/cat_analysis_smoke' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('separate fake-recovery cat_analysis_test database')
    expect(result.stderr).toContain('explicit reusable live smoke execution nonce')
    expect(result.stderr).toContain('ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH')
    expect(result.stderr).not.toContain('synthetic:secret'); expect(result.stdout).not.toContain('RUN')
  })
})
