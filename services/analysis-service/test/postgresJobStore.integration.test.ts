import { createHash } from 'node:crypto'
import { analysisRequestSchema, type AnalysisRequestV1, type UploadSourcePartV1 } from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { JobStoreConflictError, JobStoreNotFoundError } from '../src/domain/jobStore.js'
import { ServiceHttpError } from '../src/errors.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
const integration = describe.skipIf(!databaseUrl)
const key = Buffer.alloc(32, 11)
const plaintext = 'PostgreSQL 持久加密正文 🌱 '.repeat(8)
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const makeRequest = (): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey: hash('postgres-integration-request'),
  docId: 'doc-postgres',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-postgres',
      kind: 'text',
      extractor: 'integration@1',
      contentHash: hash(plaintext),
      charCount: plaintext.length,
      byteCount: new TextEncoder().encode(plaintext).byteLength,
    }],
  },
  artifacts: ['summary'],
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount: 1,
    externalKnowledge: false,
  },
})

const sourcePart = (): UploadSourcePartV1 => ({
  version: 1,
  sourceId: 'source-postgres',
  contentHash: hash(plaintext),
  partHash: hash(plaintext),
  partIndex: 0,
  partCount: 1,
  start: 0,
  end: plaintext.length,
  totalChars: plaintext.length,
  text: plaintext,
})

const openStores = new Set<PostgresJobStore>()
const connectStore = async (): Promise<PostgresJobStore> => {
  const store = await PostgresJobStore.connect({
    connectionString: databaseUrl!,
    ssl: 'disable',
    poolMax: 4,
    connectTimeoutMs: 10_000,
    cipher: new AesGcmContentCipher(key),
  })
  openStores.add(store)
  return store
}
const closeStore = async (store: PostgresJobStore): Promise<void> => {
  openStores.delete(store)
  await store.close()
}

const rawPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined

beforeEach(async () => {
  if (!rawPool) return
  const store = await connectStore()
  await closeStore(store)
  await rawPool.query('TRUNCATE analysis_runs CASCADE')
})

afterEach(async () => {
  await Promise.all([...openStores].map((store) => closeStore(store)))
})

afterAll(async () => {
  await rawPool?.end()
})

integration('PostgreSQL durable job store', () => {
  it('survives a store restart and never stores plaintext source content', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 10_000,
      createId: (() => { let id = 0; return () => `postgres-id-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest())
    await service.uploadSource('tenant-postgres', created.run.id, sourcePart())
    await service.startRun('tenant-postgres', created.run.id, 1)
    await closeStore(store)

    const reopened = await connectStore()
    const recovered = new RunService({ store: reopened, retentionSeconds: 3_600 })
    expect(await recovered.getRun('tenant-postgres', created.run.id)).toMatchObject({ status: 'queued', revision: 2 })
    expect((await recovered.listEvents('tenant-postgres', created.run.id)).map((event) => event.type)).toEqual([
      'run.accepted',
      'stage.started',
    ])
    expect(await reopened.getSourceReceipt('tenant-postgres', created.run.id, 'source-postgres')).toMatchObject({
      complete: true,
      computedHash: hash(plaintext),
    })
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_source_parts WHERE run_id=$1',
      [created.run.id],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from(plaintext, 'utf8'))).toBe(false)
    await closeStore(reopened)
  })

  it('serializes concurrent idempotent create and revision transitions', async () => {
    const firstStore = await connectStore()
    const secondStore = await connectStore()
    const first = new RunService({ store: firstStore, retentionSeconds: 3_600 })
    const second = new RunService({ store: secondStore, retentionSeconds: 3_600 })
    const [left, right] = await Promise.all([
      first.createRun('tenant-postgres', makeRequest()),
      second.createRun('tenant-postgres', makeRequest()),
    ])
    expect(left.run.id).toBe(right.run.id)
    expect([left.reused, right.reused].sort()).toEqual([false, true])
    await first.uploadSource('tenant-postgres', left.run.id, sourcePart())

    const transitions = await Promise.allSettled([
      first.startRun('tenant-postgres', left.run.id, 1),
      second.startRun('tenant-postgres', left.run.id, 1),
    ])
    expect(transitions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = transitions.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.any(ServiceHttpError) })
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      contractError: { code: 'conflict' },
    })
    await closeStore(firstStore)
    await closeStore(secondStore)
  })

  it('persists lease attempts and performs transactional TTL expiration', async () => {
    let now = 1_000
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 1,
      now: () => now,
      createId: (() => { let id = 0; return () => `ttl-id-${++id}` })(),
    })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    await service.uploadSource('tenant-postgres', run.id, sourcePart())
    const first = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now, durationMs: 100,
    })
    const takeover = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 1_100, durationMs: 100,
    })
    expect(first?.attempt).toBe(1)
    expect(takeover).toMatchObject({ attempt: 2, ownerId: 'worker-2' })

    now = 2_000
    expect(await service.cleanupExpired(10)).toEqual({ examined: 1, cleaned: 1, expired: 1 })
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ status: 'expired', revision: 2 })
    expect(await rawPool!.query('SELECT 1 FROM analysis_source_parts WHERE run_id=$1', [run.id]))
      .toMatchObject({ rowCount: 0 })
    await closeStore(store)
  })

  it('enforces tenant, cursor, source mutation, deletion, and lease CAS boundaries', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 5_000,
      createId: (() => { let id = 0; return () => `boundary-id-${++id}` })(),
    })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    expect(await store.getRun('tenant-other', run.id)).toBeUndefined()
    expect(await store.listEvents('tenant-other', run.id)).toBeUndefined()
    expect(await store.deleteContent('tenant-other', run.id)).toBeUndefined()
    expect(await store.getSourceReceipt('tenant-postgres', run.id, 'missing-source')).toBeUndefined()
    await expect(store.listEvents('tenant-postgres', run.id, 'missing-event'))
      .rejects.toBeInstanceOf(JobStoreNotFoundError)

    await service.uploadSource('tenant-postgres', run.id, sourcePart())
    const changedText = `X${plaintext.slice(1)}`
    const changed = { ...sourcePart(), text: changedText, partHash: hash(changedText) }
    await expect(service.uploadSource('tenant-postgres', run.id, changed))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(store.markSourceComplete('tenant-postgres', run.id, 'source-postgres', 'f'.repeat(64)))
      .rejects.toBeInstanceOf(JobStoreConflictError)

    const sameOwner = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 10, durationMs: 100,
    })
    expect((await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 20, durationMs: 100,
    }))?.attempt).toBe(sameOwner?.attempt)
    const renewed = await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 30, 100)
    expect(renewed?.expiresAt).toBe(130)
    expect(await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 2,
    }, 40, 100)).toBeUndefined()
    expect(await store.releaseLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', attempt: 1,
    })).toBe(false)
    expect(await store.releaseLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    })).toBe(true)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: 'missing-run', nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 1,
    })).toBeUndefined()
    await expect(store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 0,
    })).rejects.toThrow(/positive/)

    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: true })
    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: false })
    await expect(service.uploadSource('tenant-postgres', run.id, sourcePart()))
      .rejects.toMatchObject({ statusCode: 409 })
    await closeStore(store)
  })

  it('rolls back an invalid transition and reports direct cleanup edge cases', async () => {
    const store = await connectStore()
    const service = new RunService({ store, retentionSeconds: 0 })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    await expect(store.transitionRun('tenant-postgres', run.id, 1, (current, sequence) => ({
      run: { ...current, revision: 4 },
      event: {
        version: 1,
        type: 'run.expired',
        eventId: 'invalid-transition-event',
        runId: current.id,
        runRevision: 4,
        sequence,
        createdAt: 1,
        reason: 'retention_elapsed',
      },
    }))).rejects.toThrow(/transition/)
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ revision: 1, status: 'receiving' })
    expect(await store.transitionRun('tenant-postgres', 'missing-run', 1, () => {
      throw new Error('must not build')
    })).toEqual({ outcome: 'missing' })
    expect(await store.transitionRun('tenant-postgres', run.id, 2, () => {
      throw new Error('must not build')
    })).toMatchObject({ outcome: 'revision_conflict' })
    expect(await store.cleanupExpiredRun('tenant-postgres', run.id, 1, () => undefined))
      .toEqual({ outcome: 'not_due' })
    expect(await store.cleanupExpiredRun('tenant-postgres', 'missing-run', 1, () => undefined))
      .toEqual({ outcome: 'missing' })
    await closeStore(store)
  })
})
