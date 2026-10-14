import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Pool } from 'pg'
const name = process.argv[2]
if (!/^quality-regression-[0-9a-f-]{36}$/u.test(name ?? '')) throw new Error('expected quality execution directory')
const root = resolve(import.meta.dirname, '..')
const directory = join(root, '..', 'reports', name)
const report = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
const config = JSON.parse(await readFile(join(root, '..', '.cat-thinking-postgres', 'secrets', 'database.json'), 'utf8'))
if (config.version !== 1 || config.host !== '127.0.0.1' || config.port !== 55432 || config.databases?.local?.name !== 'cat_analysis_local') throw new Error('local_quality_database_configuration_invalid')
const local = config.databases.local
const pool = new Pool({ host: config.host, port: config.port, database: local.name, user: local.user, password: local.password,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000' })
try {
  const ids = [...report.results, ...(report.followups ?? []), ...(report.remediations ?? [])].map((entry) => entry.result.runId).filter(Boolean)
  const runs = (await pool.query(`SELECT run_id, status, run_json->'error' AS error, run_json->'artifactStates' AS states FROM analysis_runs WHERE run_id=ANY($1::text[])`, [ids])).rows
  const calls = (await pool.query(`SELECT run_id, role, prompt_version, status, estimated_input_tokens, reserved_output_tokens,
    actual_input_tokens, actual_output_tokens, safe_code, started_at, completed_at,
    CASE WHEN completed_at IS NOT NULL THEN completed_at-started_at ELSE NULL END AS elapsed_ms
    FROM analysis_provider_invocations WHERE run_id=ANY($1::text[]) ORDER BY started_at`, [ids])).rows
  const diagnostic = { readOnly: true, includesSourceOrCredentials: false, runs, calls }
  await writeFile(join(directory, 'diagnostics.json'), JSON.stringify(diagnostic, null, 2))
  console.log(JSON.stringify(diagnostic, null, 2))
} finally { await pool.end() }
