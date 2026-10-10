import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  canonicalizeJson,
  evidenceCardSchema,
  type AnalysisRequestV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { hashChunkPlan, planEvidenceChunks } from '../src/domain/chunkPlanner.js'
import { calculateEvidenceCoverage, mergeEvidenceCards } from '../src/domain/evidenceMerger.js'
import { JobStoreConflictError, JobStoreNotFoundError } from '../src/domain/jobStore.js'
import { ServiceHttpError } from '../src/errors.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'

const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL
const integration = describe.skipIf(!databaseUrl)
const key = Buffer.alloc(32, 11)
const plaintext = 'PostgreSQL 持久加密正文 🌱 '.repeat(8)
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const makeRequest = (requestKey = hash('postgres-integration-request')): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey,
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
  const store = await PostgresJobStore.connectFromConfig({
    mode: 'postgres',
    connectionString: databaseUrl!,
    ssl: 'disable',
    poolMax: 4,
    connectTimeoutMs: 10_000,
    encryptionKey: key.toString('base64'),
  }, new AesGcmContentCipher(key))
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
  await rawPool.query('TRUNCATE analysis_runs, analysis_evidence_cache CASCADE')
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
    await expect(service.uploadSource('tenant-postgres', created.run.id, sourcePart())).resolves.toMatchObject({
      complete: true,
      receivedParts: 1,
    })
    await service.startRun('tenant-postgres', created.run.id, 1)
    await closeStore(store)

    const reopened = await connectStore()
    expect(await reopened.checkHealth()).toBe(true)
    const recovered = new RunService({ store: reopened, retentionSeconds: 3_600 })
    expect(await recovered.getRun('tenant-postgres', created.run.id)).toMatchObject({ status: 'queued', revision: 2 })
    const events = await recovered.listEvents('tenant-postgres', created.run.id)
    expect(events.map((event) => event.type)).toEqual([
      'run.accepted',
      'stage.started',
    ])
    expect((await recovered.listEvents('tenant-postgres', created.run.id, events[0]?.eventId))
      .map((event) => event.type)).toEqual(['stage.started'])
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
    expect(await reopened.checkHealth()).toBe(false)
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
    const terminal = (await service.createRun('tenant-postgres', makeRequest('7'.repeat(64)))).run
    await service.uploadSource('tenant-postgres', terminal.id, sourcePart())
    await service.cancel('tenant-postgres', terminal.id, 1)
    const first = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now, durationMs: 100,
    })
    const takeover = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 1_100, durationMs: 100,
    })
    expect(first?.attempt).toBe(1)
    expect(takeover).toMatchObject({ attempt: 2, ownerId: 'worker-2' })

    now = 2_000
    expect(await service.cleanupExpired(10)).toEqual({ examined: 2, cleaned: 2, expired: 1 })
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ status: 'expired', revision: 2 })
    expect(await service.getRun('tenant-postgres', terminal.id)).toMatchObject({ status: 'cancelled', revision: 2 })
    expect(await rawPool!.query('SELECT 1 FROM analysis_source_parts WHERE run_id=$1', [run.id]))
      .toMatchObject({ rowCount: 0 })
    expect(await store.cleanupExpiredRun('tenant-postgres', run.id, now, () => undefined))
      .toEqual({ outcome: 'already_clean' })
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
    expect(await store.markSourceComplete('tenant-postgres', run.id, 'missing-source', 'f'.repeat(64)))
      .toBeUndefined()

    const sameOwner = await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 10, durationMs: 100,
    })
    expect((await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 20, durationMs: 100,
    }))?.attempt).toBe(sameOwner?.attempt)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 25, durationMs: 100,
    })).toBeUndefined()
    const renewed = await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 30, 100)
    expect(renewed?.expiresAt).toBe(130)
    expect(await store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 2,
    }, 40, 100)).toBeUndefined()
    await expect(store.renewLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 40, 0)).rejects.toThrow(/positive/)
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

  it('refuses a database schema newer than the service supports and closes failed pools', async () => {
    await rawPool!.query('INSERT INTO cat_analysis_schema_migrations(version) VALUES (999)')
    try {
      await expect(PostgresJobStore.connect({
        connectionString: databaseUrl!,
        ssl: 'disable',
        poolMax: 1,
        connectTimeoutMs: 10_000,
        cipher: new AesGcmContentCipher(key),
      })).rejects.toThrow(/newer than supported/)
    } finally {
      await rawPool!.query('DELETE FROM cat_analysis_schema_migrations WHERE version=999')
    }
  })

  it('encrypts exact evidence cache and graph data across restart and deletes derived content', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 10_000,
      createId: (() => { let id = 0; return () => `evidence-postgres-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest('8'.repeat(64)))
    await service.uploadSource('tenant-postgres', created.run.id, sourcePart())
    await service.startRun('tenant-postgres', created.run.id, 1)
    expect(await store.getSourceContent('tenant-postgres', created.run.id, 'source-postgres'))
      .toMatchObject({ text: plaintext, contentHash: hash(plaintext) })

    const snapshot = created.run.request.manifest.sources[0]!
    const chunks = planEvidenceChunks([{ snapshot, text: plaintext }], {
      version: 'postgres-evidence-v1',
      targetCharacters: 100,
      maxCharacters: 140,
      overlapCharacters: 10,
      minimumBoundaryRatio: 0.5,
    })
    const chunk = chunks[0]!
    const citationEnd = Math.min(chunk.end, chunk.start + 12)
    const citation = {
      version: 1 as const,
      provenance: 'source' as const,
      sourceId: chunk.sourceId,
      start: chunk.start,
      end: citationEnd,
      quote: plaintext.slice(chunk.start, citationEnd),
    }
    const card = evidenceCardSchema.parse({
      version: 1,
      chunkId: chunk.chunkId,
      chunkHash: chunk.chunkHash,
      sourceId: chunk.sourceId,
      titlePath: [],
      claims: [{ id: 'claim-local', kind: 'fact', statement: '持久证据正文', conceptIds: [], citations: [citation] }],
      terms: [],
      learningObjectives: [{ id: 'objective-local', text: '验证持久证据', evidenceIds: ['claim-local'] }],
    })
    const lease = await store.acquireLease({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      nodeKey: 'evidence:pipeline',
      ownerId: 'worker-evidence',
      now: 10_000,
      durationMs: 10_000,
    })
    expect(lease).toBeDefined()
    const identity = { tenantId: 'tenant-postgres', ...lease! }
    const cacheKey = hash('postgres-evidence-cache')
    const cardHash = hash(canonicalizeJson(card))
    await expect(store.storeEvidenceCard({
      tenantId: 'tenant-other',
      runId: created.run.id,
      lease: identity,
      now: 10_000,
      cacheKey,
      cardHash,
      chunk,
      card,
      expiresAt: 3_610_000,
    })).rejects.toThrow(/lease identity/)
    expect(await store.storeEvidenceCard({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      lease: identity,
      now: 10_000,
      cacheKey,
      cardHash,
      chunk,
      card,
      expiresAt: 3_610_000,
    })).toBe(true)
    expect(await store.getCachedEvidenceCard('tenant-other', cacheKey, 10_000)).toBeUndefined()
    await closeStore(store)

    const reopened = await connectStore()
    expect(await reopened.getCachedEvidenceCard('tenant-postgres', cacheKey, 10_000))
      .toMatchObject({ cardHash, card: { claims: [{ statement: '持久证据正文' }] } })
    expect(await reopened.listEvidenceCards('tenant-postgres', created.run.id)).toHaveLength(1)
    const transitioned = await reopened.transitionRun('tenant-postgres', created.run.id, 2, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 3,
        status: 'merging',
        stage: 'merging',
        updatedAt: 10_100,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'evidence-merging-event',
          runId: run.id,
          runRevision: 3,
          sequence,
          createdAt: 10_100,
          stage: 'merging',
        }),
      }
    })
    expect(transitioned.outcome).toBe('updated')
    const coverage = calculateEvidenceCoverage({
      selectedRanges: { 'source-postgres': { start: 0, end: plaintext.length } },
      chunks: [chunk],
      cards: [card],
    })
    const graph = mergeEvidenceCards({
      runId: created.run.id,
      chunks: [chunk],
      cards: [card],
      sourceContentHashes: [hash(plaintext)],
      coverage,
      missingChunkIds: [],
      chunkPlanHash: hashChunkPlan([chunk]),
      policyVersion: 'postgres-evidence-v1',
      promptVersion: 'evidence-map-v1',
      generatorProfile: 'fixture-v1',
      createdAt: 10_100,
    })
    await expect(reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph,
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          coverage: graph.coverage,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'evidence-merging-event',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toThrow()
    expect(await reopened.getEvidenceGraph('tenant-postgres', created.run.id)).toBeUndefined()
    expect(await reopened.getRun('tenant-postgres', created.run.id)).toMatchObject({ revision: 3, status: 'merging' })
    const committed = await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: identity,
      graph,
      now: 10_100,
      build: (run, sequence) => {
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: undefined,
          progress: 0.55,
          coverage: graph.coverage,
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'evidence-ready-event',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })
    expect(committed).toMatchObject({ outcome: 'updated', run: { revision: 4, status: 'generating' } })
    expect((await reopened.listEvents('tenant-postgres', created.run.id))?.at(-1))
      .toMatchObject({ type: 'evidence.ready', runRevision: 4, graphHash: graph.graphHash })
    await closeStore(reopened)

    const recovered = await connectStore()
    expect(await recovered.getEvidenceGraph('tenant-postgres', created.run.id))
      .toMatchObject({ graphHash: graph.graphHash, runId: created.run.id })
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_evidence_cache WHERE tenant_id=$1 AND cache_key=$2',
      ['tenant-postgres', cacheKey],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from('持久证据正文', 'utf8'))).toBe(false)
    expect(await recovered.deleteContent('tenant-postgres', created.run.id)).toBe(true)
    expect(await recovered.getEvidenceGraph('tenant-postgres', created.run.id)).toBeUndefined()
    expect(await recovered.listEvidenceCards('tenant-postgres', created.run.id)).toEqual([])
    expect(await recovered.getCachedEvidenceCard('tenant-postgres', cacheKey, 10_200)).toBeUndefined()
    await closeStore(recovered)
  })
})
