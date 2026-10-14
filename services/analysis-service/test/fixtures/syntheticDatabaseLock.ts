import type { Pool, PoolClient } from 'pg'

/** Same advisory key for every runner that can clear the dedicated synthetic database. */
export async function acquireSyntheticDatabaseLock(pool: Pool): Promise<() => Promise<void>> {
  const client: PoolClient = await pool.connect()
  try {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(19481, 6021) AS locked')
    if (!result.rows[0]?.locked) throw new Error('Synthetic database is in use by another test runner')
  } catch (error) { client.release(); throw error }
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock(19481, 6021)') } finally { client.release() }
  }
}
