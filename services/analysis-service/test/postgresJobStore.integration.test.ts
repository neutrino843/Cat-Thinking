import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  artifactEnvelopeSchema,
  canonicalizeJson,
  evidenceCardSchema,
  type AnalysisRequestV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { createArtifactDescriptor } from '../src/domain/artifactValidator.js'
import { hashChunkPlan, planEvidenceChunks } from '../src/domain/chunkPlanner.js'
import { calculateEvidenceCoverage, mergeEvidenceCards } from '../src/domain/evidenceMerger.js'
import { JobStoreConflictError, JobStoreNotFoundError } from '../src/domain/jobStore.js'
import { ServiceHttpError } from '../src/errors.js'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { ANALYSIS_SCHEMA_VERSION } from '../src/infrastructure/postgres/migrations.js'
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

const summaryArtifactFor = (runId: string) => artifactEnvelopeSchema.parse({
  version: 1,
  schemaVersion: 1,
  id: 'artifact-postgres-summary',
  runId,
  docId: 'doc-postgres',
  kind: 'summary',
  sourceContentHashes: [hash(plaintext)],
  payload: {
    overview: {
      id: 'summary-overview',
      text: 'Encrypted artifact marker',
      evidenceIds: ['claim-postgres'],
      citations: [{
        version: 1,
        provenance: 'source',
        sourceId: 'source-postgres',
        start: 0,
        end: 10,
      }],
    },
    keyPoints: [{
      id: 'summary-key-point',
      text: 'Persisted key point',
      evidenceIds: ['claim-postgres'],
      citations: [{
        version: 1,
        provenance: 'source',
        sourceId: 'source-postgres',
        start: 0,
        end: 10,
      }],
    }],
    confusions: [],
  },
  createdAt: 20_100,
  updatedAt: 20_100,
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

    await service.cancel('tenant-postgres', run.id, 1)
    expect(await store.acquireLease({
      tenantId: 'tenant-postgres', runId: run.id, nodeKey: 'planning', ownerId: 'late-worker', now: 200, durationMs: 100,
    })).toBeUndefined()

    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: true })
    expect(await service.deleteContent('tenant-postgres', run.id)).toMatchObject({ deleted: false })
    await expect(service.uploadSource('tenant-postgres', run.id, sourcePart()))
      .rejects.toMatchObject({ statusCode: 409 })
    await closeStore(store)
  })

  it('rolls back an invalid transition and reports direct cleanup edge cases', async () => {
    const store = await connectStore()
    const service = new RunService({ store, retentionSeconds: 1, now: () => 1_000 })
    const run = (await service.createRun('tenant-postgres', makeRequest())).run
    await service.uploadSource('tenant-postgres', run.id, sourcePart())
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
    const cleanupNow = 2_000
    await expect(store.cleanupExpiredRun('tenant-postgres', run.id, cleanupNow, (current, sequence) => {
      const next = analysisRunSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: 'expired',
        stage: undefined,
        artifactStates: {
          ...current.artifactStates,
          summary: { ...current.artifactStates.summary, status: 'cancelled', updatedAt: cleanupNow },
        },
        updatedAt: cleanupNow,
        completedAt: cleanupNow,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'run.expired',
          eventId: 'invalid-cleanup-transition',
          runId: current.id,
          runRevision: next.revision,
          sequence: sequence + 1,
          createdAt: cleanupNow,
          reason: 'retention_elapsed',
        }),
      }
    })).rejects.toThrow(/expired run transition/)
    expect(await store.getSourceReceipt('tenant-postgres', run.id, 'source-postgres'))
      .toMatchObject({ complete: true })
    expect(await service.getRun('tenant-postgres', run.id)).toMatchObject({ revision: 1, status: 'receiving' })
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

  it('upgrades an existing v2 schema through v4 without rebuilding earlier tables', async () => {
    await rawPool!.query('DROP TABLE analysis_provider_invocations')
    await rawPool!.query('DROP TABLE analysis_artifacts')
    await rawPool!.query('DELETE FROM cat_analysis_schema_migrations WHERE version >= 3')

    const upgraded = await connectStore()
    expect(await upgraded.checkHealth()).toBe(true)
    expect(await rawPool!.query<{ version: number }>(
      'SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations',
    )).toMatchObject({ rows: [{ version: 4 }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_artifacts'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_artifacts' }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_runs'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_runs' }] })
    expect(await rawPool!.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='analysis_provider_invocations'
    `)).toMatchObject({ rows: [{ table_name: 'analysis_provider_invocations' }] })
    await closeStore(upgraded)
  })

  it('atomically encrypts, restores, isolates, and deletes generated artifacts', async () => {
    const store = await connectStore()
    const service = new RunService({
      store,
      retentionSeconds: 3_600,
      now: () => 20_000,
      createId: (() => { let id = 0; return () => `artifact-postgres-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest('9'.repeat(64)))
    const generating = await store.transitionRun('tenant-postgres', created.run.id, 1, (run, sequence) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: 2,
        status: 'generating',
        stage: 'summary',
        progress: 0.55,
        artifactStates: {
          ...run.artifactStates,
          summary: { status: 'running', attempt: 1, updatedAt: 20_000 },
        },
        updatedAt: 20_000,
      })
      return {
        run: next,
        event: analysisEventSchema.parse({
          version: 1,
          type: 'stage.started',
          eventId: 'artifact-stage-started',
          runId: run.id,
          runRevision: next.revision,
          sequence,
          createdAt: 20_000,
          stage: 'summary',
        }),
      }
    })
    expect(generating.outcome).toBe('updated')
    const lease = await store.acquireLease({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      nodeKey: 'artifacts:dag',
      ownerId: 'artifact-worker',
      now: 20_000,
      durationMs: 10_000,
    })
    expect(lease).toBeDefined()
    const identity = { tenantId: 'tenant-postgres', ...lease! }
    const artifact = summaryArtifactFor(created.run.id)
    const descriptor = createArtifactDescriptor(artifact)
    const buildSuccess = (run: typeof created.run, sequence: number) => {
      const next = analysisRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        status: 'succeeded',
        stage: undefined,
        progress: 1,
        artifactStates: {
          ...run.artifactStates,
          summary: {
            status: 'succeeded',
            attempt: 1,
            artifactId: artifact.id,
            updatedAt: 20_100,
          },
        },
        updatedAt: 20_100,
        completedAt: 20_100,
      })
      return {
        run: next,
        events: [
          analysisEventSchema.parse({
            version: 1,
            type: 'artifact.ready',
            eventId: 'artifact-ready',
            runId: run.id,
            runRevision: next.revision,
            sequence,
            createdAt: 20_100,
            descriptor,
          }),
          analysisEventSchema.parse({
            version: 1,
            type: 'run.completed',
            eventId: 'artifact-run-completed',
            runId: run.id,
            runRevision: next.revision,
            sequence: sequence + 1,
            createdAt: 20_100,
            status: 'succeeded',
            coverage: next.coverage,
          }),
        ],
      }
    }
    const commitInput = {
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      kind: 'summary' as const,
      expectedRevision: 2,
      expectedAttempt: 1,
      lease: identity,
      now: 20_100,
      result: 'succeeded' as const,
      artifact,
      descriptor,
      build: buildSuccess,
    }

    await expect(store.commitArtifact({
      ...commitInput,
      descriptor: { ...descriptor, artifactHash: hash('incorrect artifact hash') },
    })).rejects.toMatchObject({
      name: 'ArtifactValidationError',
      issues: [{
        code: 'identity_invalid',
        path: 'descriptor',
        message: 'artifact descriptor does not match its payload',
      }],
    })
    expect(await store.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()
    expect(await store.getRun('tenant-postgres', created.run.id)).toMatchObject({ revision: 2, status: 'generating' })
    expect(await store.commitArtifact({ ...commitInput, expectedRevision: 1 })).toMatchObject({
      outcome: 'revision_conflict',
    })
    expect(await store.commitArtifact({
      ...commitInput,
      lease: { ...identity, ownerId: 'inactive-worker' },
    })).toEqual({ outcome: 'lease_conflict' })
    expect(await store.commitArtifact({ ...commitInput, expectedAttempt: 2 })).toEqual({
      outcome: 'attempt_conflict',
    })
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        return {
          ...transition,
          run: analysisRunSchema.parse({ ...transition.run, revision: transition.run.revision + 1 }),
        }
      },
    })).rejects.toThrow(/artifact transition identity/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        const first = transition.events[0]
        if (!first || first.type !== 'artifact.ready') throw new Error('expected ready event fixture')
        return {
          ...transition,
          events: [{
            ...first,
            descriptor: { ...first.descriptor, artifactHash: hash('wrong event descriptor') },
          }, ...transition.events.slice(1)],
        }
      },
    })).rejects.toThrow(/does not match its result/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        return {
          ...transition,
          events: transition.events.map((event, index) => index === 0
            ? { ...event, sequence: event.sequence + 1 }
            : event),
        }
      },
    })).rejects.toThrow(/artifact event identity/)
    await expect(store.commitArtifact({
      ...commitInput,
      build: (run, sequence) => {
        const transition = buildSuccess(run, sequence)
        const first = transition.events[0]
        if (!first) throw new Error('expected ready event fixture')
        return {
          ...transition,
          events: [first, analysisEventSchema.parse({
            version: 1,
            type: 'stage.started',
            eventId: 'invalid-artifact-terminal-event',
            runId: run.id,
            runRevision: transition.run.revision,
            sequence: sequence + 1,
            createdAt: 20_100,
            stage: 'summary',
          })],
        }
      },
    })).rejects.toThrow(/artifact terminal event/)
    expect(await store.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()

    const committed = await store.commitArtifact(commitInput)
    expect(committed).toMatchObject({ outcome: 'updated', run: { status: 'succeeded', revision: 3 } })
    expect(await store.getArtifact('tenant-other', created.run.id, 'summary')).toBeUndefined()
    expect(await store.listArtifactDescriptors('tenant-other', created.run.id)).toBeUndefined()
    await closeStore(store)

    const recovered = await connectStore()
    expect(await recovered.getArtifact('tenant-postgres', created.run.id, 'summary'))
      .toEqual({ artifact, descriptor })
    expect(await recovered.listArtifactDescriptors('tenant-postgres', created.run.id)).toEqual([descriptor])
    expect(await new RunService({ store: recovered, retentionSeconds: 3_600 })
      .getArtifact('tenant-postgres', created.run.id, 'summary')).toEqual(artifact)
    const encrypted = await rawPool!.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM analysis_artifacts WHERE tenant_id=$1 AND run_id=$2 AND kind=$3',
      ['tenant-postgres', created.run.id, 'summary'],
    )
    expect(encrypted.rows[0]?.ciphertext.includes(Buffer.from('Encrypted artifact marker', 'utf8'))).toBe(false)
    expect(await rawPool!.query<{ version: number }>(
      'SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations',
    )).toMatchObject({ rows: [{ version: ANALYSIS_SCHEMA_VERSION }] })
    expect(await recovered.deleteContent('tenant-postgres', created.run.id)).toBe(true)
    expect(await recovered.getArtifact('tenant-postgres', created.run.id, 'summary')).toBeUndefined()
    expect(await recovered.listArtifactDescriptors('tenant-postgres', created.run.id)).toEqual([])
    expect(await rawPool!.query('SELECT 1 FROM analysis_artifacts WHERE run_id=$1', [created.run.id]))
      .toMatchObject({ rowCount: 0 })
    await closeStore(recovered)
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
    const evidenceInput = {
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      lease: identity,
      now: 10_000,
      cacheKey,
      cardHash,
      chunk,
      card,
      expiresAt: 3_610_000,
    }
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      tenantId: 'tenant-other',
    })).rejects.toThrow(/lease identity/)
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      lease: { ...identity, runId: 'different-run' },
    })).rejects.toThrow(/lease identity/)
    expect(await store.storeEvidenceCard(evidenceInput)).toBe(true)
    expect(await store.storeEvidenceCard(evidenceInput)).toBe(true)

    const changedCard = evidenceCardSchema.parse({
      ...card,
      claims: [{ ...card.claims[0]!, statement: 'A different grounded claim' }],
    })
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      card: changedCard,
      cardHash: hash(canonicalizeJson(changedCard)),
    })).rejects.toBeInstanceOf(JobStoreConflictError)
    const conflictingCacheKey = hash('postgres-evidence-cache-conflict')
    await expect(store.storeEvidenceCard({
      ...evidenceInput,
      cacheKey: conflictingCacheKey,
    })).rejects.toBeInstanceOf(JobStoreConflictError)
    expect(await store.getCachedEvidenceCard('tenant-postgres', conflictingCacheKey, 10_000)).toBeUndefined()
    expect(await store.storeEvidenceCard({
      ...evidenceInput,
      lease: { ...identity, ownerId: 'inactive-worker' },
    })).toBe(false)
    expect(await store.getCachedEvidenceCard('tenant-other', cacheKey, 10_000)).toBeUndefined()
    expect(await store.getCachedEvidenceCard('tenant-postgres', cacheKey, 3_610_000)).toBeUndefined()
    expect(await store.listEvidenceCards('tenant-postgres', 'missing-evidence-run')).toBeUndefined()
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
      graph: { ...graph, runId: 'different-run' },
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).rejects.toThrow(/graph run identity/)
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: 'missing-evidence-run',
      expectedRevision: 3,
      lease: { ...identity, runId: 'missing-evidence-run' },
      graph: { ...graph, runId: 'missing-evidence-run' },
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toEqual({ outcome: 'missing' })
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 2,
      lease: identity,
      graph,
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toMatchObject({ outcome: 'revision_conflict', run: { revision: 3 } })
    expect(await reopened.commitEvidenceGraph({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      expectedRevision: 3,
      lease: { ...identity, ownerId: 'inactive-worker' },
      graph,
      now: 10_100,
      build: () => { throw new Error('must not build') },
    })).toEqual({ outcome: 'lease_conflict' })
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
          updatedAt: 10_100,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: 1,
            type: 'evidence.ready',
            eventId: 'invalid-evidence-sequence',
            runId: run.id,
            runRevision: next.revision,
            sequence: sequence + 1,
            createdAt: 10_100,
            graphHash: graph.graphHash,
            cardCount: graph.cards.length,
            claimCount: graph.claims.length,
            coverage: graph.coverage,
          }),
        }
      },
    })).rejects.toThrow(/evidence commit identity/)
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

  it('atomically reserves provider budgets and recovers stale invocation metadata without replay', async () => {
    const firstStore = await connectStore()
    const secondStore = await connectStore()
    const service = new RunService({
      store: firstStore,
      retentionSeconds: 3_600,
      now: () => 30_000,
      createId: (() => { let id = 0; return () => `provider-ledger-${++id}` })(),
    })
    const created = await service.createRun('tenant-postgres', makeRequest(hash('provider-ledger-request')))
    const reservation = (invocationId: string, nodeKey: string, now: number, maxTokens = 400) => ({
      tenantId: 'tenant-postgres',
      runId: created.run.id,
      invocationId,
      nodeKey,
      runAttempt: 1,
      role: 'evidence-map' as const,
      providerId: 'approved-provider',
      modelId: 'approved/model-v1',
      profileVersion: 'profile-v1',
      promptVersion: 'prompt-v1',
      estimatedInputTokens: 100,
      reservedOutputTokens: 200,
      estimatedCostMicros: 500,
      maxRunEstimatedTokens: maxTokens,
      maxRunEstimatedCostMicros: 10_000,
      staleAfterMs: 1_000,
      now,
    })

    const concurrent = await Promise.all([
      firstStore.reserveProviderInvocation(reservation('provider-call-a', 'provider-node-a', 30_000)),
      secondStore.reserveProviderInvocation(reservation('provider-call-b', 'provider-node-b', 30_000)),
    ])
    expect(concurrent.map((result) => result.outcome).sort()).toEqual(['budget_exceeded', 'reserved'])
    const reserved = concurrent.find((result) => result.outcome === 'reserved')
    if (!reserved || reserved.outcome !== 'reserved') throw new Error('expected one provider reservation')

    const completed = await firstStore.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: reserved.invocation.invocationId,
      transportAttempts: 1,
      now: 30_100,
      result: 'succeeded',
      actualInputTokens: 80,
      actualOutputTokens: 40,
      providerRequestId: 'provider-request-postgres',
    })
    expect(completed).toMatchObject({ outcome: 'updated', invocation: { status: 'succeeded' } })
    await expect(firstStore.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: reserved.invocation.invocationId,
      transportAttempts: 1,
      now: 30_200,
      result: 'failed',
      safeCode: 'must_not_overwrite',
    })).resolves.toMatchObject({ outcome: 'state_conflict', invocation: { status: 'succeeded' } })

    const staleId = reserved.invocation.invocationId === 'provider-call-a' ? 'provider-call-b' : 'provider-call-a'
    const staleNode = staleId === 'provider-call-a' ? 'provider-node-a' : 'provider-node-b'
    expect(await firstStore.reserveProviderInvocation(reservation(staleId, staleNode, 31_000, 1_000)))
      .toMatchObject({ outcome: 'reserved', invocation: { status: 'running' } })
    expect(await secondStore.reserveProviderInvocation(reservation(staleId, staleNode, 32_000, 1_000)))
      .toMatchObject({ outcome: 'existing', invocation: { status: 'outcome_unknown' } })
    await expect(firstStore.reserveProviderInvocation({
      ...reservation(staleId, 'different-node', 32_100, 1_000),
    })).rejects.toBeInstanceOf(JobStoreConflictError)

    await closeStore(firstStore)
    await closeStore(secondStore)
    const reopened = await connectStore()
    expect(await reopened.getProviderInvocation('tenant-postgres', reserved.invocation.invocationId))
      .toMatchObject({ status: 'succeeded', actualInputTokens: 80, actualOutputTokens: 40 })
    expect(await reopened.getProviderInvocation('tenant-postgres', staleId))
      .toMatchObject({ status: 'outcome_unknown' })
    expect(await reopened.completeProviderInvocation({
      tenantId: 'tenant-postgres',
      invocationId: 'missing-provider-call',
      transportAttempts: 0,
      now: 32_200,
      result: 'failed',
      safeCode: 'missing',
    })).toEqual({ outcome: 'missing' })

    const columns = await rawPool!.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='analysis_provider_invocations'
    `)
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      'prompt',
      'source_text',
      'raw_response',
      'api_key',
    ]))
    await closeStore(reopened)
  })
})
