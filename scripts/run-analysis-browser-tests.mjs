import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Pool } from 'pg'

const root = resolve(import.meta.dirname, '..')
const arguments_ = process.argv.slice(2)
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--personal')) throw new Error('Unsupported synthetic browser group')
const personal = arguments_[0] === '--personal'
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
let validDatabase = false
try {
  const parsed = new URL(databaseUrl)
  validDatabase = ['postgres:', 'postgresql:'].includes(parsed.protocol) && parsed.pathname === '/cat_analysis_test'
} catch { /* Never include a malformed credential-bearing URL in an error. */ }
if (!validDatabase) {
  throw new Error('Browser tests require the isolated cat_analysis_test database; use npm run e2e:analysis:local')
}
if (!process.env.npm_execpath) throw new Error('Run via npm run e2e:analysis')
// Deliberately erase live Provider and release settings inherited from the shell.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_') && !name.startsWith('VITE_ANALYSIS') && name !== 'NODE_ENV'))
Object.assign(environment, {
  NODE_ENV: 'test', ANALYSIS_BROWSER_SYNTHETIC: '1', ANALYSIS_TEST_DATABASE_URL: databaseUrl,
  ...(personal ? { ANALYSIS_BROWSER_PERSONAL: '1' } : {}),
  ANALYSIS_GATEWAY_UPSTREAM: 'http://127.0.0.1:8790', ANALYSIS_GATEWAY_TENANT: 'synthetic-browser',
  ANALYSIS_GATEWAY_TOKEN: randomBytes(32).toString('base64url'), ANALYSIS_GATEWAY_ORIGINS: 'http://127.0.0.1:5175',
  ANALYSIS_BROWSER_CONTENT_KEY: randomBytes(32).toString('base64'),
})
const jsonReport = process.env.ANALYSIS_BROWSER_JSON_REPORT_PATH
if (jsonReport) environment.PLAYWRIGHT_JSON_OUTPUT_FILE = resolve(jsonReport)
const run = async (file, args) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: false })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error('Synthetic browser validation failed')
}
try {
  await run(process.env.npm_execpath, ['run', 'build:browser-harness'])
  await run('node_modules/@playwright/test/cli.js', ['test', `--config=playwright.${personal ? 'personal' : 'analysis'}.config.ts`, ...(jsonReport ? ['--reporter=json'] : [])])
} catch {
  process.exitCode = 1
  console.error('Synthetic browser tests failed; no live Provider was invoked.')
} finally {
  // Playwright can forcibly terminate children on Windows. Finish cleanup here,
  // but never clear a database still locked by any other test process.
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const client = await pool.connect()
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(19481, 6021) AS locked')
      if (!lock.rows[0]?.locked) { process.exitCode = 1; console.error('Synthetic database still in use; cleanup skipped.') }
      else {
        try {
          if (personal) await client.query('DROP TABLE IF EXISTS cat_analysis_personal_run_profiles,cat_analysis_personal_state,cat_analysis_personal_profiles,cat_analysis_personal_schema_migrations')
          await client.query('TRUNCATE analysis_runs, analysis_evidence_cache, analysis_abandoned_requests CASCADE')
        }
        finally { await client.query('SELECT pg_advisory_unlock(19481, 6021)') }
      }
    } finally { client.release() }
  } catch { process.exitCode = 1; console.error('Synthetic database cleanup could not be confirmed; credentials withheld.') }
  finally { await pool.end() }
}
