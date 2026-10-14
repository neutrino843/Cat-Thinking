import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'

// Read-only audit: never select source, encrypted content, settings or credentials.
const config = JSON.parse(await readFile(new URL('../../.cat-thinking-postgres/secrets/database.json', import.meta.url), 'utf8'))
const local = config.databases.local
const pool = new Pool({ host: config.host, port: config.port, database: local.name,
  user: local.user, password: local.password, connectionTimeoutMillis: 5000 })
try {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const runs = await client.query(`SELECT run_id, status, created_at, updated_at,
      run_json->'error' AS error, run_json->'usage' AS usage,
      run_json->'artifactStates' AS artifact_states,
      run_json->'request'->'options' AS options
      FROM analysis_runs ORDER BY created_at DESC LIMIT 12`)
    const calls = await client.query(`SELECT run_id, node_key, role, model_id, prompt_version,
      status, reserved_output_tokens, actual_input_tokens, actual_output_tokens,
      transport_attempts, failure_kind, safe_code, started_at
      FROM analysis_provider_invocations
      WHERE run_id = ANY($1::text[]) ORDER BY started_at`, [runs.rows.map(r => r.run_id)])
    await client.query('COMMIT')
    const result = { readOnly: true, includesSourceOrCredentials: false, capturedAt: new Date().toISOString(),
      runs: runs.rows, calls: calls.rows }
    await writeFile(new URL('../../reports/CURRENT_AI_METADATA_2026-10-14.json', import.meta.url), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ runs: result.runs.length, calls: result.calls.length,
      report: 'reports/CURRENT_AI_METADATA_2026-10-14.json' }))
  } finally { client.release() }
} finally { await pool.end() }
