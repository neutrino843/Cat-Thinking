import type { PoolClient } from 'pg'

interface Migration {
  readonly version: number
  readonly sql: string
}

const MIGRATION_LOCK_ID = 843_202_610

export const ANALYSIS_SCHEMA_VERSION = 2

export const ANALYSIS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE analysis_runs (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        request_key CHAR(64) NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL,
        run_json JSONB NOT NULL,
        expires_at BIGINT,
        content_deleted_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE (tenant_id, request_key)
      );

      CREATE INDEX analysis_runs_expiry_idx
        ON analysis_runs (expires_at)
        WHERE expires_at IS NOT NULL AND content_deleted_at IS NULL;

      CREATE TABLE analysis_sources (
        run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        total_chars INTEGER NOT NULL CHECK (total_chars >= 0),
        byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
        part_count INTEGER NOT NULL CHECK (part_count > 0),
        complete BOOLEAN NOT NULL DEFAULT FALSE,
        computed_hash CHAR(64),
        PRIMARY KEY (run_id, source_id)
      );

      CREATE TABLE analysis_source_parts (
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        part_index INTEGER NOT NULL CHECK (part_index >= 0),
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
        part_hash CHAR(64) NOT NULL,
        key_id TEXT NOT NULL,
        iv BYTEA NOT NULL,
        auth_tag BYTEA NOT NULL,
        ciphertext BYTEA NOT NULL,
        PRIMARY KEY (run_id, source_id, part_index),
        FOREIGN KEY (run_id, source_id)
          REFERENCES analysis_sources(run_id, source_id) ON DELETE CASCADE
      );

      CREATE TABLE analysis_events (
        run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
        sequence BIGINT NOT NULL CHECK (sequence >= 0),
        event_id TEXT NOT NULL,
        run_revision INTEGER NOT NULL CHECK (run_revision > 0),
        event_type TEXT NOT NULL,
        event_json JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (run_id, event_id)
      );

      CREATE TABLE analysis_leases (
        run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
        node_key TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        expires_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (run_id, node_key)
      );

      CREATE INDEX analysis_leases_expiry_idx ON analysis_leases (expires_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE analysis_runs
        ADD CONSTRAINT analysis_runs_run_tenant_unique UNIQUE (run_id, tenant_id);

      CREATE TABLE analysis_evidence_cache (
        tenant_id TEXT NOT NULL,
        cache_key CHAR(64) NOT NULL,
        chunk_hash CHAR(64) NOT NULL,
        card_hash CHAR(64) NOT NULL,
        chunk_json JSONB NOT NULL,
        key_id TEXT NOT NULL,
        iv BYTEA NOT NULL,
        auth_tag BYTEA NOT NULL,
        ciphertext BYTEA NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, cache_key)
      );

      CREATE INDEX analysis_evidence_cache_expiry_idx
        ON analysis_evidence_cache (expires_at);

      CREATE TABLE analysis_run_evidence (
        run_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        cache_key CHAR(64) NOT NULL,
        chunk_json JSONB NOT NULL,
        PRIMARY KEY (run_id, chunk_id),
        FOREIGN KEY (run_id, tenant_id)
          REFERENCES analysis_runs(run_id, tenant_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, cache_key)
          REFERENCES analysis_evidence_cache(tenant_id, cache_key) ON DELETE RESTRICT
      );

      CREATE INDEX analysis_run_evidence_cache_idx
        ON analysis_run_evidence (tenant_id, cache_key);

      CREATE TABLE analysis_evidence_graphs (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_revision INTEGER NOT NULL CHECK (run_revision > 0),
        graph_hash CHAR(64) NOT NULL,
        key_id TEXT NOT NULL,
        iv BYTEA NOT NULL,
        auth_tag BYTEA NOT NULL,
        ciphertext BYTEA NOT NULL,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (run_id, tenant_id)
          REFERENCES analysis_runs(run_id, tenant_id) ON DELETE CASCADE
      );
    `,
  },
]

export const migrateAnalysisDatabase = async (client: PoolClient): Promise<void> => {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cat_analysis_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const currentResult = await client.query<{ version: number | null }>(
      'SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations',
    )
    const current = currentResult.rows[0]?.version ?? 0
    if (current > ANALYSIS_SCHEMA_VERSION) {
      throw new Error(`analysis database schema ${current} is newer than supported ${ANALYSIS_SCHEMA_VERSION}`)
    }
    for (const migration of ANALYSIS_MIGRATIONS) {
      if (migration.version <= current) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO cat_analysis_schema_migrations(version) VALUES ($1)',
          [migration.version],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
  }
}
