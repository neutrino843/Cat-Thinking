import {
  analysisEventSchema,
  analysisRunSchema,
  artifactDescriptorSchema,
  artifactEnvelopeSchema,
  canonicalizeJson,
  evidenceCardSchema,
  evidenceChunkSchema,
  evidenceGraphSchema,
  sourceReceiptSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
  type AnalysisRunV1,
  type ArtifactDescriptorV1,
  type ArtifactKind,
  type EvidenceGraphV1,
  type SourceReceiptV1,
} from '@cat-thinking/analysis-contracts'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import type { AnalysisServiceConfig } from '../../config.js'
import { validateArtifactDescriptor } from '../../domain/artifactValidator.js'
import {
  JobStoreConflictError,
  JobStoreNotFoundError,
  type CommitArtifactInput,
  type CommitEvidenceGraphInput,
  type ExpiredRunReference,
  type ExpiredRunCleanupResult,
  type JobLease,
  type JobStore,
  type LeaseIdentity,
  type LeaseRequest,
  type RunTransition,
  type RunTransitionResult,
  type StoreSourcePartInput,
  type StoreEvidenceCardInput,
  type StoredEvidenceCard,
  type StoredArtifact,
  type StoredSourceContent,
  type StoredSourcePart,
  type StoredSourceUpload,
} from '../../domain/jobStore.js'
import type { ContentCipher, EncryptedContent } from '../contentCipher.js'
import {
  artifactEncryptionContext,
  evidenceCardEncryptionContext,
  evidenceGraphEncryptionContext,
  sourcePartEncryptionContext,
} from '../contentCipher.js'
import { migrateAnalysisDatabase } from './migrations.js'

interface RunRow extends QueryResultRow {
  run_json: unknown
}

interface LockedRunRow extends RunRow {
  content_deleted_at: string | number | null
}

interface SourceRow extends QueryResultRow {
  source_id: string
  content_hash: string
  total_chars: number
  byte_count: string | number
  part_count: number
  complete: boolean
  computed_hash: string | null
}

interface SourcePartRow extends QueryResultRow {
  part_index: number
  start_offset: number
  end_offset: number
  part_hash: string
  key_id: string
  iv: Buffer
  auth_tag: Buffer
  ciphertext: Buffer
}

interface EventRow extends QueryResultRow {
  event_json: unknown
}

interface LeaseRow extends QueryResultRow {
  owner_id: string
  attempt: number
  expires_at: string | number
}

interface EvidenceCacheRow extends QueryResultRow {
  cache_key: string
  chunk_hash: string
  card_hash: string
  chunk_json: unknown
  key_id: string
  iv: Buffer
  auth_tag: Buffer
  ciphertext: Buffer
  expires_at: string | number
}

interface EvidenceGraphRow extends QueryResultRow {
  graph_hash: string
  key_id: string
  iv: Buffer
  auth_tag: Buffer
  ciphertext: Buffer
}

interface ArtifactRow extends QueryResultRow {
  artifact_id: string
  artifact_hash: string
  schema_version: number
  kind: string
  byte_count: string | number
  key_id: string
  iv: Buffer
  auth_tag: Buffer
  ciphertext: Buffer
  created_at: string | number
  updated_at: string | number
}

const decodeRun = (row: RunRow): AnalysisRunV1 => analysisRunSchema.parse(row.run_json)
const decodeEvent = (row: EventRow): AnalysisEventV1 => analysisEventSchema.parse(row.event_json)

const samePart = (left: StoredSourcePart, right: StoredSourcePart): boolean =>
  left.partIndex === right.partIndex
  && left.partCount === right.partCount
  && left.start === right.start
  && left.end === right.end
  && left.totalChars === right.totalChars
  && left.contentHash === right.contentHash
  && left.partHash === right.partHash
  && left.text === right.text

export interface PostgresJobStoreOptions {
  readonly connectionString: string
  readonly ssl: 'disable' | 'require'
  readonly poolMax: number
  readonly connectTimeoutMs: number
  readonly cipher: ContentCipher
}

export class PostgresJobStore implements JobStore {
  private constructor(
    private readonly pool: Pool,
    private readonly cipher: ContentCipher,
  ) {}

  static async connect(options: PostgresJobStoreOptions): Promise<PostgresJobStore> {
    const pool = new Pool({
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: options.poolMax,
      ssl: options.ssl === 'require' ? { rejectUnauthorized: true } : false,
    })
    const client = await pool.connect()
    let migrationError: unknown
    try {
      await migrateAnalysisDatabase(client)
    } catch (error) {
      migrationError = error
    } finally {
      client.release()
    }
    if (migrationError !== undefined) {
      await pool.end()
      throw migrationError
    }
    return new PostgresJobStore(pool, options.cipher)
  }

  static async connectFromConfig(
    config: Extract<AnalysisServiceConfig['jobStore'], { mode: 'postgres' }>,
    cipher: ContentCipher,
  ): Promise<PostgresJobStore> {
    return PostgresJobStore.connect({
      connectionString: config.connectionString,
      ssl: config.ssl,
      poolMax: config.poolMax,
      connectTimeoutMs: config.connectTimeoutMs,
      cipher,
    })
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ healthy: number }>('SELECT 1 AS healthy')
      return result.rows[0]?.healthy === 1
    } catch {
      return false
    }
  }

  async createRun(
    tenantId: string,
    runInput: AnalysisRunV1,
    eventInput: AnalysisEventV1,
  ): Promise<Readonly<{ run: AnalysisRunV1; reused: boolean; event?: AnalysisEventV1 }>> {
    const run = analysisRunSchema.parse(runInput)
    const event = analysisEventSchema.parse(eventInput)
    return this.transaction(async (client) => {
      const inserted = await client.query<RunRow>(`
        INSERT INTO analysis_runs(
          run_id, tenant_id, request_key, revision, status, run_json,
          expires_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id, request_key) DO NOTHING
        RETURNING run_json
      `, [
        run.id,
        tenantId,
        run.requestKey,
        run.revision,
        run.status,
        run,
        run.expiresAt ?? null,
        run.createdAt,
        run.updatedAt,
      ])
      if (inserted.rowCount === 1) {
        await this.insertEvent(client, event)
        return { run, reused: false, event }
      }
      const existing = await client.query<RunRow>(
        'SELECT run_json FROM analysis_runs WHERE tenant_id=$1 AND request_key=$2',
        [tenantId, run.requestKey],
      )
      const row = existing.rows[0]
      if (!row) throw new Error('request-key conflict did not resolve to a run')
      return { run: decodeRun(row), reused: true }
    })
  }

  async getRun(tenantId: string, runId: string): Promise<AnalysisRunV1 | undefined> {
    const result = await this.pool.query<RunRow>(
      'SELECT run_json FROM analysis_runs WHERE tenant_id=$1 AND run_id=$2',
      [tenantId, runId],
    )
    const row = result.rows[0]
    return row ? decodeRun(row) : undefined
  }

  async transitionRun(
    tenantId: string,
    runId: string,
    expectedRevision: number,
    build: (current: AnalysisRunV1, nextSequence: number) => RunTransition,
  ): Promise<RunTransitionResult> {
    return this.transaction(async (client) => {
      const selected = await client.query<RunRow>(
        'SELECT run_json FROM analysis_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE',
        [tenantId, runId],
      )
      const row = selected.rows[0]
      if (!row) return { outcome: 'missing' }
      const current = decodeRun(row)
      if (current.revision !== expectedRevision) {
        return { outcome: 'revision_conflict', run: current }
      }
      const sequenceResult = await client.query<{ next_sequence: string | number }>(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM analysis_events WHERE run_id=$1
      `, [runId])
      const nextSequence = Number(sequenceResult.rows[0]?.next_sequence ?? 0)
      const transition = build(current, nextSequence)
      const run = analysisRunSchema.parse(transition.run)
      const event = analysisEventSchema.parse(transition.event)
      if (
        run.id !== runId
        || run.revision !== expectedRevision + 1
        || event.runId !== runId
        || event.runRevision !== run.revision
        || event.sequence !== nextSequence
      ) throw new TypeError('run transition identity, revision, or event sequence is invalid')

      const updated = await client.query(`
        UPDATE analysis_runs
        SET revision=$1, status=$2, run_json=$3, expires_at=$4, updated_at=$5
        WHERE tenant_id=$6 AND run_id=$7 AND revision=$8
      `, [
        run.revision,
        run.status,
        run,
        run.expiresAt ?? null,
        run.updatedAt,
        tenantId,
        runId,
        expectedRevision,
      ])
      if (updated.rowCount !== 1) throw new Error('locked run revision changed unexpectedly')
      await this.insertEvent(client, event)
      return { outcome: 'updated', run, event }
    })
  }

  async storeSourcePart(input: StoreSourcePartInput): Promise<StoredSourceUpload> {
    const part = uploadSourcePartSchema.parse(input.part)
    return this.transaction(async (client) => {
      const run = await client.query<{ content_deleted_at: string | number | null }>(`
        SELECT content_deleted_at FROM analysis_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE
      `, [input.tenantId, input.runId])
      if (!run.rows[0]) throw new JobStoreNotFoundError('run')
      if (run.rows[0].content_deleted_at !== null) throw new JobStoreConflictError('run content was deleted')

      await client.query(`
        INSERT INTO analysis_sources(
          run_id, source_id, content_hash, total_chars, byte_count, part_count
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (run_id, source_id) DO NOTHING
      `, [input.runId, part.sourceId, part.contentHash, part.totalChars, input.byteCount, part.partCount])
      const sourceResult = await client.query<SourceRow>(`
        SELECT source_id, content_hash, total_chars, byte_count, part_count, complete, computed_hash
        FROM analysis_sources WHERE run_id=$1 AND source_id=$2 FOR UPDATE
      `, [input.runId, part.sourceId])
      const source = sourceResult.rows[0]
      if (!source) throw new Error('source insert did not produce a source')
      if (
        source.content_hash !== part.contentHash
        || source.total_chars !== part.totalChars
        || Number(source.byte_count) !== input.byteCount
        || source.part_count !== part.partCount
      ) throw new JobStoreConflictError('source upload metadata changed')

      const newPart: StoredSourcePart = {
        partIndex: part.partIndex,
        partCount: part.partCount,
        start: part.start,
        end: part.end,
        totalChars: part.totalChars,
        contentHash: part.contentHash,
        partHash: part.partHash,
        text: part.text,
      }
      const existing = await client.query<SourcePartRow>(`
        SELECT part_index, start_offset, end_offset, part_hash, key_id, iv, auth_tag, ciphertext
        FROM analysis_source_parts
        WHERE run_id=$1 AND source_id=$2 AND part_index=$3
      `, [input.runId, part.sourceId, part.partIndex])
      const existingRow = existing.rows[0]
      if (existingRow) {
        const stored = this.decodePart(input.tenantId, input.runId, source, existingRow)
        if (!samePart(stored, newPart)) throw new JobStoreConflictError('source part changed after upload')
      } else {
        const context = sourcePartEncryptionContext(input.tenantId, input.runId, part.sourceId, part.partIndex)
        const encrypted = this.cipher.encrypt(part.text, context)
        await client.query(`
          INSERT INTO analysis_source_parts(
            run_id, source_id, part_index, start_offset, end_offset, part_hash,
            key_id, iv, auth_tag, ciphertext
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          input.runId,
          part.sourceId,
          part.partIndex,
          part.start,
          part.end,
          part.partHash,
          encrypted.keyId,
          encrypted.iv,
          encrypted.authTag,
          encrypted.ciphertext,
        ])
      }
      return this.loadSource(client, input.tenantId, input.runId, part.sourceId)
    })
  }

  async markSourceComplete(
    tenantId: string,
    runId: string,
    sourceId: string,
    computedHash: string,
  ): Promise<StoredSourceUpload | undefined> {
    return this.transaction(async (client) => {
      const updated = await client.query(`
        UPDATE analysis_sources source
        SET complete=TRUE, computed_hash=$1
        FROM analysis_runs run
        WHERE source.run_id=run.run_id
          AND run.tenant_id=$2 AND source.run_id=$3 AND source.source_id=$4
          AND (source.computed_hash IS NULL OR source.computed_hash=$1)
      `, [computedHash, tenantId, runId, sourceId])
      if (updated.rowCount === 0) {
        const existing = await client.query<{ computed_hash: string | null }>(`
          SELECT source.computed_hash FROM analysis_sources source
          JOIN analysis_runs run ON run.run_id=source.run_id
          WHERE run.tenant_id=$1 AND source.run_id=$2 AND source.source_id=$3
        `, [tenantId, runId, sourceId])
        if (!existing.rows[0]) return undefined
        throw new JobStoreConflictError('source completion hash changed')
      }
      return this.loadSource(client, tenantId, runId, sourceId)
    })
  }

  async getSourceReceipt(
    tenantId: string,
    runId: string,
    sourceId: string,
  ): Promise<SourceReceiptV1 | undefined> {
    const result = await this.pool.query<SourceRow & { received_parts: string | number }>(`
      SELECT source.source_id, source.content_hash, source.total_chars, source.byte_count,
        source.part_count, source.complete, source.computed_hash, COUNT(part.part_index) AS received_parts
      FROM analysis_sources source
      JOIN analysis_runs run ON run.run_id=source.run_id
      LEFT JOIN analysis_source_parts part
        ON part.run_id=source.run_id AND part.source_id=source.source_id
      WHERE run.tenant_id=$1 AND source.run_id=$2 AND source.source_id=$3
      GROUP BY source.run_id, source.source_id
    `, [tenantId, runId, sourceId])
    const row = result.rows[0]
    if (!row) return undefined
    return sourceReceiptSchema.parse({
      version: 1,
      sourceId,
      receivedParts: Number(row.received_parts),
      partCount: row.part_count,
      complete: row.complete,
      computedHash: row.computed_hash ?? undefined,
    })
  }

  async getSourceContent(
    tenantId: string,
    runId: string,
    sourceId: string,
  ): Promise<StoredSourceContent | undefined> {
    try {
      const source = await this.transaction((client) => this.loadSource(client, tenantId, runId, sourceId))
      if (!source.complete || source.computedHash !== source.contentHash || source.parts.length !== source.partCount) {
        return undefined
      }
      return {
        sourceId,
        contentHash: source.contentHash,
        text: source.parts.map((part) => part.text).join(''),
      }
    } catch (error) {
      if (error instanceof JobStoreNotFoundError) return undefined
      throw error
    }
  }

  async getCachedEvidenceCard(
    tenantId: string,
    cacheKey: string,
    now: number,
  ): Promise<StoredEvidenceCard | undefined> {
    const result = await this.pool.query<EvidenceCacheRow>(`
      SELECT cache_key, chunk_hash, card_hash, chunk_json, key_id, iv, auth_tag, ciphertext, expires_at
      FROM analysis_evidence_cache
      WHERE tenant_id=$1 AND cache_key=$2 AND expires_at>$3
    `, [tenantId, cacheKey, now])
    const row = result.rows[0]
    return row ? this.decodeEvidenceCard(tenantId, row) : undefined
  }

  async storeEvidenceCard(input: StoreEvidenceCardInput): Promise<boolean> {
    this.assertLeaseScope(input.tenantId, input.runId, input.lease)
    const chunk = evidenceChunkSchema.parse(input.chunk)
    const card = evidenceCardSchema.parse(input.card)
    const context = evidenceCardEncryptionContext(input.tenantId, input.cacheKey)
    const encrypted = this.cipher.encrypt(JSON.stringify(card), context)
    return this.transaction(async (client) => {
      if (!await this.hasActiveLease(client, input.lease, input.now, true)) return false
      await client.query(`
        INSERT INTO analysis_evidence_cache(
          tenant_id, cache_key, chunk_hash, card_hash, chunk_json,
          key_id, iv, auth_tag, ciphertext, expires_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (tenant_id, cache_key) DO NOTHING
      `, [
        input.tenantId,
        input.cacheKey,
        chunk.chunkHash,
        input.cardHash,
        chunk,
        encrypted.keyId,
        encrypted.iv,
        encrypted.authTag,
        encrypted.ciphertext,
        input.expiresAt,
        input.now,
      ])
      const cached = await client.query<EvidenceCacheRow>(`
        SELECT cache_key, chunk_hash, card_hash, chunk_json, key_id, iv, auth_tag, ciphertext, expires_at
        FROM analysis_evidence_cache
        WHERE tenant_id=$1 AND cache_key=$2 FOR UPDATE
      `, [input.tenantId, input.cacheKey])
      const existing = cached.rows[0]
      if (!existing) throw new Error('evidence cache insert did not produce a row')
      if (existing.chunk_hash !== chunk.chunkHash || existing.card_hash !== input.cardHash) {
        throw new JobStoreConflictError('evidence cache key collision')
      }
      await client.query(`
        UPDATE analysis_evidence_cache SET expires_at=GREATEST(expires_at,$1)
        WHERE tenant_id=$2 AND cache_key=$3
      `, [input.expiresAt, input.tenantId, input.cacheKey])
      const linked = await client.query<{ cache_key: string }>(`
        SELECT cache_key FROM analysis_run_evidence WHERE run_id=$1 AND chunk_id=$2 FOR UPDATE
      `, [input.runId, chunk.chunkId])
      if (linked.rows[0] && linked.rows[0].cache_key !== input.cacheKey) {
        throw new JobStoreConflictError('run evidence chunk changed')
      }
      await client.query(`
        INSERT INTO analysis_run_evidence(run_id,chunk_id,tenant_id,cache_key,chunk_json)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (run_id,chunk_id) DO NOTHING
      `, [input.runId, chunk.chunkId, input.tenantId, input.cacheKey, chunk])
      return true
    })
  }

  async listEvidenceCards(
    tenantId: string,
    runId: string,
  ): Promise<readonly StoredEvidenceCard[] | undefined> {
    const run = await this.pool.query('SELECT 1 FROM analysis_runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId])
    if (run.rowCount !== 1) return undefined
    const result = await this.pool.query<EvidenceCacheRow>(`
      SELECT cache.cache_key, cache.chunk_hash, cache.card_hash, link.chunk_json,
        cache.key_id, cache.iv, cache.auth_tag, cache.ciphertext, cache.expires_at
      FROM analysis_run_evidence link
      JOIN analysis_evidence_cache cache
        ON cache.tenant_id=link.tenant_id AND cache.cache_key=link.cache_key
      WHERE link.tenant_id=$1 AND link.run_id=$2
      ORDER BY (link.chunk_json->>'ordinal')::integer ASC
    `, [tenantId, runId])
    return result.rows.map((row) => this.decodeEvidenceCard(tenantId, row))
  }

  async commitEvidenceGraph(input: CommitEvidenceGraphInput) {
    this.assertLeaseScope(input.tenantId, input.runId, input.lease)
    const graph = evidenceGraphSchema.parse(input.graph)
    if (graph.runId !== input.runId) throw new TypeError('evidence graph run identity is invalid')
    const context = evidenceGraphEncryptionContext(input.tenantId, input.runId, graph.graphHash)
    const encrypted = this.cipher.encrypt(JSON.stringify(graph), context)
    return this.transaction(async (client) => {
      const selected = await client.query<LockedRunRow>(`
        SELECT run_json, content_deleted_at FROM analysis_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE
      `, [input.tenantId, input.runId])
      const selectedRow = selected.rows[0]
      if (!selectedRow) return { outcome: 'missing' } as const
      const currentRun = decodeRun(selectedRow)
      if (currentRun.revision !== input.expectedRevision || currentRun.status !== 'merging') {
        return { outcome: 'revision_conflict', run: currentRun } as const
      }
      if (
        selectedRow.content_deleted_at !== null
        || !await this.hasActiveLease(client, input.lease, input.now, true)
      ) return { outcome: 'lease_conflict' } as const
      const sequenceResult = await client.query<{ next_sequence: string | number }>(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM analysis_events WHERE run_id=$1
      `, [input.runId])
      const nextSequence = Number(sequenceResult.rows[0]?.next_sequence ?? 0)
      const transition = input.build(currentRun, nextSequence)
      const run = analysisRunSchema.parse(transition.run)
      const event = analysisEventSchema.parse(transition.event)
      if (
        run.id !== input.runId
        || run.revision !== input.expectedRevision + 1
        || event.runId !== input.runId
        || event.runRevision !== run.revision
        || event.sequence !== nextSequence
        || event.type !== 'evidence.ready'
      ) throw new TypeError('evidence commit identity, revision, or event sequence is invalid')
      const existing = await client.query<{ run_revision: number; graph_hash: string }>(`
        SELECT run_revision, graph_hash FROM analysis_evidence_graphs WHERE run_id=$1 FOR UPDATE
      `, [input.runId])
      const current = existing.rows[0]
      if (current && current.run_revision === run.revision && current.graph_hash !== graph.graphHash) {
        throw new JobStoreConflictError('evidence graph changed at the same revision')
      }
      await client.query(`
        INSERT INTO analysis_evidence_graphs(
          run_id, tenant_id, run_revision, graph_hash, key_id, iv, auth_tag, ciphertext, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (run_id) DO UPDATE SET
          tenant_id=EXCLUDED.tenant_id,
          run_revision=EXCLUDED.run_revision,
          graph_hash=EXCLUDED.graph_hash,
          key_id=EXCLUDED.key_id,
          iv=EXCLUDED.iv,
          auth_tag=EXCLUDED.auth_tag,
          ciphertext=EXCLUDED.ciphertext,
          created_at=EXCLUDED.created_at
      `, [
        input.runId,
        input.tenantId,
        run.revision,
        graph.graphHash,
        encrypted.keyId,
        encrypted.iv,
        encrypted.authTag,
        encrypted.ciphertext,
        input.now,
      ])
      const updated = await client.query(`
        UPDATE analysis_runs
        SET revision=$1, status=$2, run_json=$3, expires_at=$4, updated_at=$5
        WHERE tenant_id=$6 AND run_id=$7 AND revision=$8
      `, [
        run.revision,
        run.status,
        run,
        run.expiresAt ?? null,
        run.updatedAt,
        input.tenantId,
        input.runId,
        input.expectedRevision,
      ])
      if (updated.rowCount !== 1) throw new Error('locked run revision changed unexpectedly')
      await this.insertEvent(client, event)
      return { outcome: 'updated', run, event } as const
    })
  }

  async getEvidenceGraph(tenantId: string, runId: string): Promise<EvidenceGraphV1 | undefined> {
    const result = await this.pool.query<EvidenceGraphRow>(`
      SELECT graph.graph_hash, graph.key_id, graph.iv, graph.auth_tag, graph.ciphertext
      FROM analysis_evidence_graphs graph
      JOIN analysis_runs run ON run.run_id=graph.run_id
      WHERE run.tenant_id=$1 AND graph.run_id=$2
    `, [tenantId, runId])
    const row = result.rows[0]
    if (!row) return undefined
    const context = evidenceGraphEncryptionContext(tenantId, runId, row.graph_hash)
    return evidenceGraphSchema.parse(JSON.parse(this.cipher.decrypt({
      keyId: row.key_id,
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    }, context)))
  }

  async getArtifact(tenantId: string, runId: string, kind: ArtifactKind): Promise<StoredArtifact | undefined> {
    const result = await this.pool.query<ArtifactRow>(`
      SELECT artifact.artifact_id, artifact.artifact_hash, artifact.schema_version,
        artifact.kind, artifact.byte_count, artifact.key_id, artifact.iv,
        artifact.auth_tag, artifact.ciphertext, artifact.created_at, artifact.updated_at
      FROM analysis_artifacts artifact
      JOIN analysis_runs run ON run.run_id=artifact.run_id
      WHERE run.tenant_id=$1 AND artifact.run_id=$2 AND artifact.kind=$3
    `, [tenantId, runId, kind])
    const row = result.rows[0]
    return row ? this.decodeArtifact(tenantId, runId, row) : undefined
  }

  async listArtifactDescriptors(
    tenantId: string,
    runId: string,
  ): Promise<readonly ArtifactDescriptorV1[] | undefined> {
    const run = await this.pool.query('SELECT 1 FROM analysis_runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId])
    if (run.rowCount !== 1) return undefined
    const result = await this.pool.query<ArtifactRow>(`
      SELECT artifact_id, artifact_hash, schema_version, kind, byte_count,
        key_id, iv, auth_tag, ciphertext, created_at, updated_at
      FROM analysis_artifacts
      WHERE tenant_id=$1 AND run_id=$2
      ORDER BY kind ASC
    `, [tenantId, runId])
    return result.rows.map((row) => this.artifactDescriptor(runId, row))
  }

  async commitArtifact(input: CommitArtifactInput) {
    this.assertLeaseScope(input.tenantId, input.runId, input.lease)
    const stored = input.result === 'succeeded'
      ? {
          descriptor: artifactDescriptorSchema.parse(input.descriptor),
          artifact: artifactEnvelopeSchema.parse(input.artifact),
        }
      : undefined
    if (stored && (
      stored.descriptor.runId !== input.runId
      || stored.descriptor.kind !== input.kind
      || stored.artifact.runId !== input.runId
      || stored.artifact.kind !== input.kind
      || stored.descriptor.id !== stored.artifact.id
    )) throw new TypeError('artifact identity differs from commit scope')
    if (stored) validateArtifactDescriptor(stored.artifact, stored.descriptor)
    const encrypted = stored
      ? this.cipher.encrypt(
          JSON.stringify(stored.artifact),
          artifactEncryptionContext(input.tenantId, input.runId, input.kind, stored.descriptor.artifactHash),
        )
      : undefined

    return this.transaction(async (client) => {
      const selected = await client.query<LockedRunRow>(`
        SELECT run_json, content_deleted_at FROM analysis_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE
      `, [input.tenantId, input.runId])
      const row = selected.rows[0]
      if (!row) return { outcome: 'missing' } as const
      const current = decodeRun(row)
      if (current.revision !== input.expectedRevision) {
        return { outcome: 'revision_conflict', run: current } as const
      }
      if (
        row.content_deleted_at !== null
        || !await this.hasActiveLease(client, input.lease, input.now, true)
      ) return { outcome: 'lease_conflict' } as const
      const state = current.artifactStates[input.kind]
      if (!state || state.status !== 'running' || state.attempt !== input.expectedAttempt) {
        return { outcome: 'attempt_conflict' } as const
      }

      const sequenceResult = await client.query<{ next_sequence: string | number }>(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM analysis_events WHERE run_id=$1
      `, [input.runId])
      const nextSequence = Number(sequenceResult.rows[0]?.next_sequence ?? 0)
      const transition = input.build(current, nextSequence)
      const run = analysisRunSchema.parse(transition.run)
      const events = transition.events.map((event) => analysisEventSchema.parse(event))
      if (run.id !== input.runId || run.revision !== input.expectedRevision + 1 || events.length < 1 || events.length > 2) {
        throw new TypeError('artifact transition identity or revision is invalid')
      }
      for (const [index, event] of events.entries()) {
        if (
          event.runId !== input.runId
          || event.runRevision !== run.revision
          || event.sequence !== nextSequence + index
        ) throw new TypeError('artifact event identity, revision, or sequence is invalid')
      }
      const first = events[0]
      if (
        !first
        || (input.result === 'succeeded'
          ? first.type !== 'artifact.ready'
            || first.descriptor.kind !== input.kind
            || !stored
            || canonicalizeJson(first.descriptor) !== canonicalizeJson(stored.descriptor)
          : first.type !== 'artifact.failed' || first.kind !== input.kind)
      ) throw new TypeError('artifact commit event does not match its result')
      const terminal = events[1]
      if (terminal && terminal.type !== 'run.completed' && terminal.type !== 'run.failed') {
        throw new TypeError('artifact terminal event is invalid')
      }

      if (stored && encrypted) {
        await client.query(`
          INSERT INTO analysis_artifacts(
            run_id, kind, tenant_id, artifact_id, artifact_hash, schema_version,
            byte_count, key_id, iv, auth_tag, ciphertext, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (run_id,kind) DO UPDATE SET
            tenant_id=EXCLUDED.tenant_id,
            artifact_id=EXCLUDED.artifact_id,
            artifact_hash=EXCLUDED.artifact_hash,
            schema_version=EXCLUDED.schema_version,
            byte_count=EXCLUDED.byte_count,
            key_id=EXCLUDED.key_id,
            iv=EXCLUDED.iv,
            auth_tag=EXCLUDED.auth_tag,
            ciphertext=EXCLUDED.ciphertext,
            created_at=EXCLUDED.created_at,
            updated_at=EXCLUDED.updated_at
        `, [
          input.runId,
          input.kind,
          input.tenantId,
          stored.descriptor.id,
          stored.descriptor.artifactHash,
          stored.descriptor.schemaVersion,
          stored.descriptor.byteCount,
          encrypted.keyId,
          encrypted.iv,
          encrypted.authTag,
          encrypted.ciphertext,
          stored.descriptor.createdAt,
          stored.descriptor.updatedAt,
        ])
      }
      const updated = await client.query(`
        UPDATE analysis_runs
        SET revision=$1, status=$2, run_json=$3, expires_at=$4, updated_at=$5
        WHERE tenant_id=$6 AND run_id=$7 AND revision=$8
      `, [
        run.revision,
        run.status,
        run,
        run.expiresAt ?? null,
        run.updatedAt,
        input.tenantId,
        input.runId,
        input.expectedRevision,
      ])
      if (updated.rowCount !== 1) throw new Error('locked run revision changed unexpectedly')
      for (const event of events) await this.insertEvent(client, event)
      return { outcome: 'updated', run, events } as const
    })
  }

  async deleteContent(tenantId: string, runId: string): Promise<boolean | undefined> {
    return this.transaction(async (client) => {
      const selected = await client.query<{ content_deleted_at: string | number | null }>(`
        SELECT content_deleted_at FROM analysis_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE
      `, [tenantId, runId])
      const row = selected.rows[0]
      if (!row) return undefined
      if (row.content_deleted_at !== null) return false
      await this.deleteEvidenceForRun(client, tenantId, runId)
      await client.query('DELETE FROM analysis_sources WHERE run_id=$1', [runId])
      await client.query(
        'UPDATE analysis_runs SET content_deleted_at=$1 WHERE tenant_id=$2 AND run_id=$3',
        [Date.now(), tenantId, runId],
      )
      return true
    })
  }

  async listEvents(
    tenantId: string,
    runId: string,
    afterEventId?: string,
  ): Promise<readonly AnalysisEventV1[] | undefined> {
    const run = await this.pool.query('SELECT 1 FROM analysis_runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId])
    if (run.rowCount !== 1) return undefined
    let afterSequence = -1
    if (afterEventId !== undefined) {
      const cursor = await this.pool.query<{ sequence: string | number }>(`
        SELECT sequence FROM analysis_events WHERE run_id=$1 AND event_id=$2
      `, [runId, afterEventId])
      if (!cursor.rows[0]) throw new JobStoreNotFoundError('event')
      afterSequence = Number(cursor.rows[0].sequence)
    }
    const events = await this.pool.query<EventRow>(`
      SELECT event_json FROM analysis_events
      WHERE run_id=$1 AND sequence>$2 ORDER BY sequence ASC
    `, [runId, afterSequence])
    return events.rows.map(decodeEvent)
  }

  async listExpiredRuns(now: number, limit: number): Promise<readonly ExpiredRunReference[]> {
    const result = await this.pool.query<{ tenant_id: string; run_id: string }>(`
      SELECT tenant_id, run_id FROM analysis_runs
      WHERE expires_at IS NOT NULL AND expires_at <= $1 AND content_deleted_at IS NULL
      ORDER BY expires_at ASC LIMIT $2
    `, [now, limit])
    return result.rows.map((row) => ({ tenantId: row.tenant_id, runId: row.run_id }))
  }

  async cleanupExpiredRun(
    tenantId: string,
    runId: string,
    now: number,
    buildTransition: (current: AnalysisRunV1, nextSequence: number) => RunTransition | undefined,
  ): Promise<ExpiredRunCleanupResult> {
    return this.transaction(async (client) => {
      const selected = await client.query<RunRow & {
        expires_at: string | number | null
        content_deleted_at: string | number | null
      }>(`
        SELECT run_json, expires_at, content_deleted_at FROM analysis_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE
      `, [tenantId, runId])
      const row = selected.rows[0]
      if (!row) return { outcome: 'missing' }
      if (row.content_deleted_at !== null) return { outcome: 'already_clean' }
      if (row.expires_at === null || Number(row.expires_at) > now) return { outcome: 'not_due' }

      await this.deleteEvidenceForRun(client, tenantId, runId)
      await client.query('DELETE FROM analysis_sources WHERE run_id=$1', [runId])
      await client.query(
        'UPDATE analysis_runs SET content_deleted_at=$1 WHERE tenant_id=$2 AND run_id=$3',
        [now, tenantId, runId],
      )
      const current = decodeRun(row)
      const sequenceResult = await client.query<{ next_sequence: string | number }>(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM analysis_events WHERE run_id=$1
      `, [runId])
      const nextSequence = Number(sequenceResult.rows[0]?.next_sequence ?? 0)
      const transition = buildTransition(current, nextSequence)
      if (!transition) return { outcome: 'cleaned', run: current }
      const run = analysisRunSchema.parse(transition.run)
      const event = analysisEventSchema.parse(transition.event)
      if (
        run.revision !== current.revision + 1
        || event.runId !== runId
        || event.runRevision !== run.revision
        || event.sequence !== nextSequence
      ) throw new TypeError('expired run transition is invalid')
      await client.query(`
        UPDATE analysis_runs SET revision=$1, status=$2, run_json=$3, updated_at=$4
        WHERE tenant_id=$5 AND run_id=$6 AND revision=$7
      `, [run.revision, run.status, run, run.updatedAt, tenantId, runId, current.revision])
      await this.insertEvent(client, event)
      return { outcome: 'cleaned', run, event }
    })
  }

  async acquireLease(request: LeaseRequest): Promise<JobLease | undefined> {
    if (request.durationMs <= 0) throw new RangeError('lease duration must be positive')
    return this.transaction(async (client) => {
      const run = await client.query(
        `SELECT 1 FROM analysis_runs
         WHERE tenant_id=$1 AND run_id=$2 AND content_deleted_at IS NULL
           AND status NOT IN ('partial','succeeded','cancelled','failed','expired')`,
        [request.tenantId, request.runId],
      )
      if (run.rowCount !== 1) return undefined
      const selected = await client.query<LeaseRow>(`
        SELECT owner_id, attempt, expires_at FROM analysis_leases
        WHERE run_id=$1 AND node_key=$2 FOR UPDATE
      `, [request.runId, request.nodeKey])
      const current = selected.rows[0]
      if (current && Number(current.expires_at) > request.now && current.owner_id !== request.ownerId) return undefined
      const attempt = current
        ? current.owner_id === request.ownerId && Number(current.expires_at) > request.now
          ? current.attempt
          : current.attempt + 1
        : 1
      const expiresAt = request.now + request.durationMs
      await client.query(`
        INSERT INTO analysis_leases(run_id,node_key,owner_id,attempt,expires_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (run_id,node_key) DO UPDATE SET
          owner_id=EXCLUDED.owner_id,
          attempt=EXCLUDED.attempt,
          expires_at=EXCLUDED.expires_at,
          updated_at=EXCLUDED.updated_at
      `, [request.runId, request.nodeKey, request.ownerId, attempt, expiresAt, request.now])
      return Object.freeze({
        runId: request.runId,
        nodeKey: request.nodeKey,
        ownerId: request.ownerId,
        attempt,
        expiresAt,
      })
    })
  }

  async renewLease(identity: LeaseIdentity, now: number, durationMs: number): Promise<JobLease | undefined> {
    if (durationMs <= 0) throw new RangeError('lease duration must be positive')
    const expiresAt = now + durationMs
    const result = await this.pool.query<LeaseRow>(`
      UPDATE analysis_leases lease SET expires_at=$1, updated_at=$2
      FROM analysis_runs run
      WHERE lease.run_id=run.run_id
        AND run.tenant_id=$3 AND lease.run_id=$4 AND lease.node_key=$5
        AND lease.owner_id=$6 AND lease.attempt=$7 AND lease.expires_at>$2
        AND run.content_deleted_at IS NULL
        AND run.status NOT IN ('partial','succeeded','cancelled','failed','expired')
      RETURNING lease.owner_id, lease.attempt, lease.expires_at
    `, [expiresAt, now, identity.tenantId, identity.runId, identity.nodeKey, identity.ownerId, identity.attempt])
    if (!result.rows[0]) return undefined
    return Object.freeze({
      runId: identity.runId,
      nodeKey: identity.nodeKey,
      ownerId: identity.ownerId,
      attempt: identity.attempt,
      expiresAt,
    })
  }

  async releaseLease(identity: LeaseIdentity): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM analysis_leases lease USING analysis_runs run
      WHERE lease.run_id=run.run_id
        AND run.tenant_id=$1 AND lease.run_id=$2 AND lease.node_key=$3
        AND lease.owner_id=$4 AND lease.attempt=$5
    `, [identity.tenantId, identity.runId, identity.nodeKey, identity.ownerId, identity.attempt])
    return result.rowCount === 1
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async insertEvent(client: PoolClient, event: AnalysisEventV1): Promise<void> {
    await client.query(`
      INSERT INTO analysis_events(
        run_id, sequence, event_id, run_revision, event_type, event_json, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      event.runId,
      event.sequence,
      event.eventId,
      event.runRevision,
      event.type,
      event,
      event.createdAt,
    ])
  }

  private async loadSource(
    client: PoolClient,
    tenantId: string,
    runId: string,
    sourceId: string,
  ): Promise<StoredSourceUpload> {
    const sourceResult = await client.query<SourceRow>(`
      SELECT source.source_id, source.content_hash, source.total_chars, source.byte_count,
        source.part_count, source.complete, source.computed_hash
      FROM analysis_sources source JOIN analysis_runs run ON run.run_id=source.run_id
      WHERE run.tenant_id=$1 AND source.run_id=$2 AND source.source_id=$3
    `, [tenantId, runId, sourceId])
    const source = sourceResult.rows[0]
    if (!source) throw new JobStoreNotFoundError('source')
    const partsResult = await client.query<SourcePartRow>(`
      SELECT part_index, start_offset, end_offset, part_hash, key_id, iv, auth_tag, ciphertext
      FROM analysis_source_parts WHERE run_id=$1 AND source_id=$2 ORDER BY part_index ASC
    `, [runId, sourceId])
    return {
      sourceId: source.source_id,
      contentHash: source.content_hash,
      totalChars: source.total_chars,
      byteCount: Number(source.byte_count),
      partCount: source.part_count,
      complete: source.complete,
      computedHash: source.computed_hash ?? undefined,
      parts: partsResult.rows.map((row) => this.decodePart(tenantId, runId, source, row)),
    }
  }

  private decodePart(
    tenantId: string,
    runId: string,
    source: SourceRow,
    row: SourcePartRow,
  ): StoredSourcePart {
    const encrypted: EncryptedContent = {
      keyId: row.key_id,
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    }
    const context = sourcePartEncryptionContext(tenantId, runId, source.source_id, row.part_index)
    return {
      partIndex: row.part_index,
      partCount: source.part_count,
      start: row.start_offset,
      end: row.end_offset,
      totalChars: source.total_chars,
      contentHash: source.content_hash,
      partHash: row.part_hash,
      text: this.cipher.decrypt(encrypted, context),
    }
  }

  private decodeEvidenceCard(tenantId: string, row: EvidenceCacheRow): StoredEvidenceCard {
    const context = evidenceCardEncryptionContext(tenantId, row.cache_key)
    return {
      cacheKey: row.cache_key,
      cardHash: row.card_hash,
      chunk: evidenceChunkSchema.parse(row.chunk_json),
      card: evidenceCardSchema.parse(JSON.parse(this.cipher.decrypt({
        keyId: row.key_id,
        iv: row.iv,
        authTag: row.auth_tag,
        ciphertext: row.ciphertext,
      }, context))),
      expiresAt: Number(row.expires_at),
    }
  }

  private artifactDescriptor(runId: string, row: ArtifactRow): ArtifactDescriptorV1 {
    return artifactDescriptorSchema.parse({
      version: row.schema_version,
      schemaVersion: row.schema_version,
      id: row.artifact_id,
      runId,
      kind: row.kind,
      artifactHash: row.artifact_hash,
      byteCount: Number(row.byte_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })
  }

  private decodeArtifact(tenantId: string, runId: string, row: ArtifactRow): StoredArtifact {
    const descriptor = this.artifactDescriptor(runId, row)
    const context = artifactEncryptionContext(tenantId, runId, descriptor.kind, descriptor.artifactHash)
    const artifact = artifactEnvelopeSchema.parse(JSON.parse(this.cipher.decrypt({
      keyId: row.key_id,
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    }, context)))
    validateArtifactDescriptor(artifact, descriptor)
    return { descriptor, artifact }
  }

  private async hasActiveLease(
    client: PoolClient,
    identity: LeaseIdentity,
    now: number,
    requireContent: boolean,
  ): Promise<boolean> {
    const result = await client.query(`
      SELECT 1 FROM analysis_leases lease
      JOIN analysis_runs run ON run.run_id=lease.run_id
      WHERE run.tenant_id=$1 AND lease.run_id=$2 AND lease.node_key=$3
        AND lease.owner_id=$4 AND lease.attempt=$5 AND lease.expires_at>$6
        ${requireContent ? "AND run.content_deleted_at IS NULL AND run.status NOT IN ('partial','succeeded','cancelled','failed','expired')" : ''}
      FOR UPDATE OF lease
    `, [identity.tenantId, identity.runId, identity.nodeKey, identity.ownerId, identity.attempt, now])
    return result.rowCount === 1
  }

  private assertLeaseScope(tenantId: string, runId: string, identity: LeaseIdentity): void {
    if (identity.tenantId !== tenantId || identity.runId !== runId) {
      throw new JobStoreConflictError('lease identity does not match run scope')
    }
  }

  private async deleteEvidenceForRun(client: PoolClient, tenantId: string, runId: string): Promise<void> {
    await client.query('DELETE FROM analysis_artifacts WHERE run_id=$1', [runId])
    await client.query('DELETE FROM analysis_evidence_graphs WHERE run_id=$1', [runId])
    await client.query('DELETE FROM analysis_run_evidence WHERE run_id=$1', [runId])
    await client.query(`
      DELETE FROM analysis_evidence_cache cache
      WHERE cache.tenant_id=$1
        AND NOT EXISTS (
          SELECT 1 FROM analysis_run_evidence link
          WHERE link.tenant_id=cache.tenant_id AND link.cache_key=cache.cache_key
        )
    `, [tenantId])
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
