import { spawnSync } from 'node:child_process'
import { assertPostgresTestEvidence } from './postgres-test-evidence.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const blocked = []
if (process.argv.slice(2).length) blocked.push('unsupported command arguments; use the documented environment-based invocation')
if (process.env.ANALYSIS_LIVE_SMOKE !== 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE') blocked.push('explicit billable synthetic smoke opt-in')
const dedicatedDatabase = (value, name) => {
  try {
    const database = new URL(value ?? '')
    return ['postgres:', 'postgresql:'].includes(database.protocol) && database.pathname === `/${name}`
  } catch { return false }
}
if (!dedicatedDatabase(process.env.ANALYSIS_TEST_DATABASE_URL, 'cat_analysis_smoke')) blocked.push('dedicated PostgreSQL cat_analysis_smoke database')
if (!dedicatedDatabase(process.env.ANALYSIS_RECOVERY_TEST_DATABASE_URL, 'cat_analysis_test')) blocked.push('separate fake-recovery cat_analysis_test database; smoke usage must never be truncated')
for (const name of ['ANALYSIS_PROVIDER_API_KEY', 'ANALYSIS_PROVIDER_ID', 'ANALYSIS_PROVIDER_MODEL_ID',
  'ANALYSIS_PROVIDER_PROFILE_VERSION', 'ANALYSIS_PROVIDER_BASE_URL', 'ANALYSIS_PROVIDER_ALLOWED_HOSTS',
  'ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS', 'ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS',
  'ANALYSIS_CI_PREREQUISITES_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH', 'ANALYSIS_RELEASE_SIGNING_KEY_PATH',
  'ANALYSIS_RELEASE_ATTESTATION_PATH', 'ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH']) if (!process.env[name]) blocked.push(name)
if (!/^[a-f0-9]{32}$/u.test(process.env.ANALYSIS_LIVE_SMOKE_EXECUTION_ID ?? '')) blocked.push('explicit reusable live smoke execution nonce')
if (process.env.ANALYSIS_PROVIDER_MODE !== 'openai-compatible') blocked.push('OpenAI-compatible Provider mode')
if (process.env.ANALYSIS_PROVIDER_MAX_ATTEMPTS !== '1') blocked.push('exact configured Provider maxAttempts=1')
if (process.env.ANALYSIS_RELEASE_HOLD !== undefined && !['true', '1'].includes(process.env.ANALYSIS_RELEASE_HOLD)) blocked.push('held admission')
for (const name of ['ANALYSIS_PROVIDER_INPUT_MICROS_PER_MILLION_TOKENS', 'ANALYSIS_PROVIDER_OUTPUT_MICROS_PER_MILLION_TOKENS']) {
  if (!process.env[name] || !Number.isSafeInteger(Number(process.env[name])) || Number(process.env[name]) <= 0) blocked.push(name)
}
const npmCli = process.env.npm_execpath
if (!npmCli) blocked.push('invoke through npm run test:provider:live')
if (process.env.ANALYSIS_JOB_STORE !== 'postgres' || process.env.ANALYSIS_DATABASE_URL !== process.env.ANALYSIS_TEST_DATABASE_URL) blocked.push('configured store must be the dedicated smoke database')
const cleanCommit = () => {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (status.error || status.status !== 0 || status.stdout.trim() || head.error || head.status !== 0
    || !/^[a-f0-9]{40}$/u.test(head.stdout.trim())) throw new Error('clean_versioned_checkout_required')
  return head.stdout.trim()
}
let commit
try { commit = cleanCommit() } catch { blocked.push('clean versioned checkout') }
const targetEnv = { ...process.env,
  ANALYSIS_TARGET_VALIDATION: 'I_ACKNOWLEDGE_BILLABLE_NONDESTRUCTIVE_TARGET_VALIDATION',
  ANALYSIS_TARGET_VALIDATION_EXECUTION_ID: process.env.ANALYSIS_LIVE_SMOKE_EXECUTION_ID,
  ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_TOKENS: process.env.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS,
  ANALYSIS_TARGET_VALIDATION_MAX_ESTIMATED_COST_MICROS: process.env.ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS,
  ANALYSIS_TARGET_VALIDATION_CHECKPOINT_PATH: process.env.ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH,
}
// The shared target runner owns signing, per-attempt CI/build checks and durable
// checkpoint verification. Its read-only preflight must pass before fake tests.
const probe = blocked.length ? undefined : spawnSync(process.execPath, [resolve(root, 'scripts/run-target-provider-validation.mjs'), '--preflight-only'],
  { cwd: root, env: targetEnv, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 })
if (!probe || probe.error || probe.status !== 0) blocked.push('valid matching Ed25519 signing material, exact held build/config, budget, signed CI and durable checkpoint')
if (blocked.length) {
  console.error(`Live Provider smoke blocked before network access: ${[...new Set(blocked)].join('; ')}`)
  process.exitCode = 2
} else {
  const testEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_') && !name.startsWith('VITE_ANALYSIS') && name !== 'NODE_ENV'))
  const pgEnv = { ...testEnv, ANALYSIS_TEST_DATABASE_URL: process.env.ANALYSIS_RECOVERY_TEST_DATABASE_URL }
  const directory = await mkdtemp(join(tmpdir(), 'cat-protected-smoke-'))
  const run = (args, env = testEnv) => {
    const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', env, shell: false, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('smoke_prerequisite_failed')
  }
  try {
    run(['run', 'check:ci'])
    const postgresReport = join(directory, 'postgres.json')
    run(['run', 'test:service:postgres', '--', '--reporter=json', `--outputFile=${postgresReport}`], pgEnv)
    const report = JSON.parse(await readFile(postgresReport, 'utf8'))
    assertPostgresTestEvidence(report)
    run(['run', 'coverage:postgres'], pgEnv)
    if (cleanCommit() !== commit) throw new Error('checkout_changed')
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/run-target-provider-validation.mjs')],
      { cwd: root, env: targetEnv, stdio: 'inherit', shell: false, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('protected_live_validation_failed')
    console.log('Dedicated smoke verification completed using its reusable nonce and signed checkpoint. Usage remains durable; admission remains held.')
  } catch {
    console.error('Live smoke or release verification failed. No new release proof was issued; keep admission held and reuse the same smoke nonce/checkpoint.')
    process.exitCode = 1
  } finally { await rm(directory, { recursive: true, force: true }) }
}
