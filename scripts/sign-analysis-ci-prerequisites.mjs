import { spawnSync } from 'node:child_process'
import { assertPostgresTestEvidence } from './postgres-test-evidence.mjs'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { writeProtectedJson } from './protected-file.mjs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOutsideCheckout, protectedPathIdentity } from './protected-path-identity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const blocked = []
if (process.env.ANALYSIS_CI_SIGNING !== 'I_ACKNOWLEDGE_TRUSTED_CI_SIGNING') blocked.push('explicit protected CI signing opt-in')
if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') blocked.push('actual Linux GitHub Actions execution')
if (process.platform === 'linux') {
  try { if (!/^ID=ubuntu$/mu.test(await readFile('/etc/os-release', 'utf8'))) blocked.push('actual Ubuntu operating system') }
  catch { blocked.push('actual Ubuntu operating system') }
}
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT
if (!/^[1-9][0-9]*$/u.test(runId ?? '') || !/^[1-9][0-9]*$/u.test(attempt ?? '')) blocked.push('actual GitHub run identity')
if (!process.env.npm_execpath) blocked.push('invoke through npm run verify:ci:sign')
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
try {
  const database = new URL(databaseUrl ?? '')
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/cat_analysis_test') throw new Error('invalid')
} catch { blocked.push('dedicated PostgreSQL cat_analysis_test database') }
const pathNames = ['ANALYSIS_RELEASE_SIGNING_KEY_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH', 'ANALYSIS_CI_PREREQUISITES_PATH']
const paths = Object.fromEntries(pathNames.map((name) => {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) blocked.push(name)
  const path = value ? resolve(value) : undefined
  if (path) {
    if (!isOutsideCheckout(root, path)) blocked.push('protected signing/output paths outside checkout')
  }
  return [name, path]
}))
if (new Set(Object.values(paths).filter(Boolean).map((path) => protectedPathIdentity(path))).size !== 3) blocked.push('distinct key and output paths')
const cleanCommit = () => {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (status.error || status.status !== 0 || status.stdout.trim() || head.error || head.status !== 0
    || !/^[a-f0-9]{40}$/u.test(head.stdout.trim())) throw new Error('clean_versioned_checkout_required')
  return head.stdout.trim()
}
let commit
try { commit = cleanCommit() } catch { blocked.push('clean versioned checkout') }
let privateKey
try {
  privateKey = createPrivateKey(await readFile(paths.ANALYSIS_RELEASE_SIGNING_KEY_PATH))
  const trusted = createPublicKey(await readFile(paths.ANALYSIS_RELEASE_PUBLIC_KEY_PATH))
  if (privateKey.asymmetricKeyType !== 'ed25519' || trusted.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(trusted.export({ type: 'spki', format: 'der' }))) throw new Error('invalid_trust_root')
} catch { blocked.push('matching protected Ed25519 signing material') }
if (blocked.length) {
  console.error(`CI prerequisite signing blocked before tests or network: ${[...new Set(blocked)].join('; ')}`)
  process.exitCode = 2
} else {
  // Neither tests, audit, browsers nor the container inherit a live/Provider key,
  // release override or signing file path. Only isolated PG tasks get a DB URL.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_')
    && !name.startsWith('VITE_ANALYSIS') && name !== 'NODE_ENV'))
  const pgEnv = { ...cleanEnv, ANALYSIS_TEST_DATABASE_URL: databaseUrl }
  const directory = await mkdtemp(join(tmpdir(), 'cat-ci-evidence-'))
  const reports = []
  const run = (args, env = cleanEnv) => {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit', env, shell: false, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('ci_prerequisite_failed')
  }
  const readReport = async (name) => {
    const bytes = await readFile(join(directory, name))
    reports.push({ name, bytes })
    return JSON.parse(bytes.toString('utf8'))
  }
  const assertVitest = async (name, minimum, allowProtectedSkips = false) => {
    const report = await readReport(name)
    const allow = /[/\\](?:providerLiveSmoke|postgresJobStore\.integration|targetValidation\.postgres\.integration|personalProvider\.postgres\.integration)\.test\.ts$/u
    if (report.success !== true || report.numFailedTests !== 0 || report.numPassedTests < minimum
      || (!allowProtectedSkips && report.numPendingTests !== 0) || !report.testResults?.length
      || !report.testResults.every((suite) => suite.assertionResults?.length
        && suite.assertionResults.every((test) => test.status === 'passed' || (allowProtectedSkips
          && allow.test(suite.name) && ['pending', 'skipped'].includes(test.status))))) throw new Error('ci_test_evidence_incomplete')
  }
  const assertPlaywright = async (name, minimum) => {
    const report = await readReport(name)
    if (!report.stats || report.stats.expected < minimum || report.stats.unexpected !== 0
      || report.stats.flaky !== 0 || report.stats.skipped !== 0 || report.errors?.length) throw new Error('ci_browser_evidence_incomplete')
  }
  const audit = async (omitDevelopment, name) => {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', ...(omitDevelopment ? ['--omit=dev'] : []), '--audit-level=low', '--json'],
      { cwd: root, env: cleanEnv, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('ci_dependency_audit_failed')
    const report = JSON.parse(result.stdout)
    if (report.error || !report.metadata?.vulnerabilities || report.metadata.vulnerabilities.total !== 0) throw new Error('ci_dependency_audit_incomplete')
    await writeFile(join(directory, name), result.stdout, { flag: 'wx', mode: 0o600 })
    await readReport(name)
  }
  try {
    run(['run', 'check:ci'])
    run(['exec', '--', 'vitest', 'run', '--reporter=json', `--outputFile=${join(directory, 'quality.json')}`])
    await assertVitest('quality.json', 900, true)
    run(['run', 'test:service:postgres', '--', '--reporter=json', `--outputFile=${join(directory, 'postgres.json')}`], pgEnv)
    assertPostgresTestEvidence(await readReport('postgres.json'))
    run(['run', 'coverage:postgres'], pgEnv)
    reports.push({ name: 'postgres-coverage.json', bytes: await readFile(resolve(root, 'coverage-postgres/coverage-summary.json')) })
    await audit(false, 'audit-all.json'); await audit(true, 'audit-prod.json')
    run(['run', 'e2e', '--', '--reporter=json'], { ...cleanEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'browser.json') })
    await assertPlaywright('browser.json', 61)
    run(['run', 'e2e:analysis'], { ...pgEnv, ANALYSIS_BROWSER_JSON_REPORT_PATH: join(directory, 'analysis-browser.json') })
    await assertPlaywright('analysis-browser.json', 25)
    run(['run', 'e2e:personal'], { ...pgEnv, ANALYSIS_BROWSER_JSON_REPORT_PATH: join(directory, 'personal-browser.json') })
    await assertPlaywright('personal-browser.json', 1)
    run(['run', 'verify:container'])
    if (cleanCommit() !== commit) throw new Error('checkout_changed_during_ci')
    const buildModule = await import('../services/analysis-service/dist/release/buildIdentity.js')
    const build = await buildModule.loadVerifiedBuildIdentity(root)
    if (build.commit !== commit) throw new Error('ci_build_identity_mismatch')
    const reportDigest = createHash('sha256').update('cat-ci-prerequisite-reports-v1\n')
    for (const report of reports.sort((left, right) => left.name.localeCompare(right.name))) reportDigest.update(`${report.name}\n${report.bytes.length}\n`).update(report.bytes)
    const { signCiPrerequisites } = await import('../services/analysis-service/dist/release/ciPrerequisites.js')
    const issuedAt = Date.now()
    const receipt = signCiPrerequisites({ version: 1, audience: 'cat-analysis-ci-prerequisites', build,
      issuedAt, expiresAt: issuedAt + 24 * 60 * 60000, evidence: { quality: 'passed', postgresRecovery: 'passed',
        postgresCoverage: 'passed', dependencyAudit: 'passed', remotePlatform: 'ubuntu', containerReady: 'passed', browserRecovery: 'passed',
        workflowExecutionId: `${runId}/${attempt}`, reportDigest: reportDigest.digest('hex') } }, privateKey)
    await writeProtectedJson(paths.ANALYSIS_CI_PREREQUISITES_PATH, receipt)
    console.log('Trusted CI prerequisite receipt issued for the exact build. No live Provider call or admission change occurred.')
  } catch {
    console.error('Trusted CI prerequisite verification failed. No new prerequisite receipt was issued.')
    process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
