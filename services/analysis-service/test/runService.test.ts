import { createHash } from 'node:crypto'
import {
  analysisEventSchema,
  analysisRequestSchema,
  type AnalysisRequestV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it } from 'vitest'
import { RunEventBroker } from '../src/domain/eventBroker.js'
import { RunService } from '../src/domain/runService.js'
import { ServiceHttpError } from '../src/errors.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const createIds = (): (() => string) => {
  let sequence = 0
  return () => `generated-${++sequence}`
}

const sourceText = '光合🌱作用'

const makeRequest = (requestKey = 'a'.repeat(64)): AnalysisRequestV1 => analysisRequestSchema.parse({
  version: 1,
  requestKey,
  docId: 'doc-1',
  manifest: {
    version: 1,
    sources: [{
      version: 1,
      sourceId: 'source-1',
      kind: 'text',
      extractor: 'test@1',
      contentHash: hash(sourceText),
      charCount: sourceText.length,
      byteCount: new TextEncoder().encode(sourceText).byteLength,
    }],
  },
  artifacts: ['summary', 'quiz'],
  options: {
    locale: 'zh-CN',
    qualityProfile: 'standard',
    summaryDetail: 'standard',
    quizQuestionCount: 2,
    externalKnowledge: false,
  },
})

const partFor = (text = sourceText): UploadSourcePartV1 => ({
  version: 1,
  sourceId: 'source-1',
  contentHash: hash(sourceText),
  partHash: hash(text),
  partIndex: 0,
  partCount: 1,
  start: 0,
  end: text.length,
  totalChars: sourceText.length,
  text,
})

const setup = () => {
  const store = new InMemoryJobStore()
  const broker = new RunEventBroker()
  const service = new RunService({
    store,
    broker,
    retentionSeconds: 3_600,
    now: () => 1_791_700_000_000,
    createId: createIds(),
  })
  return { store, broker, service }
}

const expectServiceError = async (
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> => {
  try {
    await promise
    throw new Error('expected service error')
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceHttpError)
    expect(error).toMatchObject({ statusCode, contractError: { code } })
  }
}

describe('durable run service with the reference store', () => {
  it('deduplicates a request key per tenant without crossing tenant boundaries', async () => {
    const { service } = setup()
    const first = await service.createRun('tenant-1', makeRequest())
    const reused = await service.createRun('tenant-1', makeRequest())
    const otherTenant = await service.createRun('tenant-2', makeRequest())

    expect(first.reused).toBe(false)
    expect(reused).toMatchObject({ reused: true, run: { id: first.run.id } })
    expect(otherTenant.reused).toBe(false)
    expect(otherTenant.run.id).not.toBe(first.run.id)
    await expectServiceError(service.getRun('tenant-2', first.run.id), 404, 'invalid_request')
  })

  it('rejects a reused request key when the claimed request identity differs', async () => {
    const { service } = setup()
    await service.createRun('tenant-1', makeRequest())
    const changed = { ...makeRequest(), docId: 'doc-changed' }
    await expectServiceError(service.createRun('tenant-1', changed), 409, 'conflict')
  })

  it('verifies part and complete content hashes and keeps exact duplicate uploads idempotent', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    const invalid = { ...partFor(), partHash: 'b'.repeat(64) }

    await expectServiceError(service.uploadSource('tenant-1', created.run.id, invalid), 422, 'source_hash_mismatch')
    const receipt = await service.uploadSource('tenant-1', created.run.id, partFor())
    const duplicate = await service.uploadSource('tenant-1', created.run.id, partFor())

    expect(receipt).toMatchObject({ complete: true, receivedParts: 1, computedHash: hash(sourceText) })
    expect(duplicate).toEqual(receipt)
  })

  it('rejects changed upload content and incomplete source starts', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    await expectServiceError(service.startRun('tenant-1', created.run.id, 1), 409, 'source_missing')

    await service.uploadSource('tenant-1', created.run.id, partFor())
    const changed = { ...partFor(), text: '改变内容', end: 4, partHash: hash('改变内容') }
    await expectServiceError(service.uploadSource('tenant-1', created.run.id, changed), 409, 'conflict')
  })

  it('rejects sources outside the manifest and altered manifest identity', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    await expectServiceError(service.uploadSource('tenant-1', created.run.id, {
      ...partFor(), sourceId: 'source-other',
    }), 409, 'source_missing')
    await expectServiceError(service.uploadSource('tenant-1', created.run.id, {
      ...partFor(), contentHash: '0'.repeat(64),
    }), 422, 'source_hash_mismatch')
  })

  it('accepts out-of-order multipart upload only after ranges form a complete source', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    const split = 3
    const left = sourceText.slice(0, split)
    const right = sourceText.slice(split)
    const rightReceipt = await service.uploadSource('tenant-1', created.run.id, {
      ...partFor(right),
      partIndex: 1,
      partCount: 2,
      start: split,
      end: sourceText.length,
      totalChars: sourceText.length,
    })
    expect(rightReceipt).toMatchObject({ complete: false, receivedParts: 1 })
    const complete = await service.uploadSource('tenant-1', created.run.id, {
      ...partFor(left),
      partIndex: 0,
      partCount: 2,
      start: 0,
      end: split,
      totalChars: sourceText.length,
    })
    expect(complete).toMatchObject({ complete: true, receivedParts: 2 })
  })

  it('starts with revision compare-and-swap and replays persisted events from a cursor', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    await service.uploadSource('tenant-1', created.run.id, partFor())
    const started = await service.startRun('tenant-1', created.run.id, 1)

    expect(started.run).toMatchObject({ revision: 2, status: 'queued', stage: 'planning' })
    await expectServiceError(service.startRun('tenant-1', created.run.id, 1), 409, 'conflict')
    const events = await service.listEvents('tenant-1', created.run.id)
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'run.accepted'],
      [1, 'stage.started'],
    ])
    const replay = await service.listEvents('tenant-1', created.run.id, events[0]?.eventId)
    expect(replay.map((event) => event.type)).toEqual(['stage.started'])
    await expectServiceError(service.listEvents('tenant-1', created.run.id, 'unknown-event'), 409, 'conflict')
  })

  it('cancels once, rejects stale changes, and allows only a cancelled artifact to retry', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    const cancelled = await service.cancel('tenant-1', created.run.id, 1)
    const duplicate = await service.cancel('tenant-1', created.run.id, cancelled.revision)

    expect(cancelled).toMatchObject({ accepted: true, revision: 2 })
    expect(duplicate).toMatchObject({ accepted: false, revision: 2 })
    const retried = await service.retryArtifact('tenant-1', created.run.id, 'summary', 2)
    const run = await service.getRun('tenant-1', created.run.id)
    expect(retried).toMatchObject({ accepted: true, revision: 3, kind: 'summary' })
    expect(run).toMatchObject({
      status: 'generating',
      stage: 'summary',
      artifactStates: { summary: { status: 'pending', attempt: 1 } },
    })
    await expectServiceError(service.retryArtifact('tenant-1', created.run.id, 'summary', 3), 409, 'conflict')
    await expectServiceError(service.retryArtifact('tenant-1', created.run.id, 'mindmap', 3), 409, 'conflict')
    await expectServiceError(service.retryArtifact('tenant-1', 'missing-run', 'summary', 1), 404, 'invalid_request')
  })

  it('deletes source content idempotently while retaining run metadata', async () => {
    const { service } = setup()
    const created = await service.createRun('tenant-1', makeRequest())
    await service.uploadSource('tenant-1', created.run.id, partFor())

    expect(await service.deleteContent('tenant-1', created.run.id)).toMatchObject({ deleted: true })
    expect(await service.deleteContent('tenant-1', created.run.id)).toMatchObject({ deleted: false })
    expect((await service.getRun('tenant-1', created.run.id)).id).toBe(created.run.id)
    await expectServiceError(service.uploadSource('tenant-1', created.run.id, partFor()), 409, 'conflict')
  })

  it('notifies waiters without losing a publish between observation and wait', async () => {
    const broker = new RunEventBroker()
    const observed = broker.version('run-1')
    broker.publish('run-1')
    await expect(broker.wait('run-1', observed, 60_000)).resolves.toBeUndefined()
  })

  it('uses expiring leases to reject parallel and stale workers', async () => {
    const { store, service } = setup()
    const run = (await service.createRun('tenant-1', makeRequest())).run
    const first = await store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 100, durationMs: 50,
    })
    const blocked = await store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 120, durationMs: 50,
    })
    const takeover = await store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', now: 150, durationMs: 50,
    })

    expect(first).toMatchObject({ attempt: 1, ownerId: 'worker-1', expiresAt: 150 })
    expect(blocked).toBeUndefined()
    expect(takeover).toMatchObject({ attempt: 2, ownerId: 'worker-2' })
    expect(await store.renewLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 160, 50)).toBeUndefined()
    expect(await store.releaseLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    })).toBe(false)
    expect(await store.releaseLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-2', attempt: 2,
    })).toBe(true)
    expect(await store.acquireLease({
      tenantId: 'tenant-1', runId: 'missing-run', nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 1,
    })).toBeUndefined()
    await expect(store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker', now: 1, durationMs: 0,
    })).rejects.toThrow(/positive/)
  })

  it('covers direct store idempotency, cleanup, renewal, and close edge cases', async () => {
    const { store, service } = setup()
    const run = (await service.createRun('tenant-1', makeRequest())).run
    expect(await store.getSourceReceipt('tenant-1', run.id, 'missing-source')).toBeUndefined()
    expect(await store.deleteContent('tenant-1', 'missing-run')).toBeUndefined()
    expect(await store.cleanupExpiredRun('tenant-1', 'missing-run', 1, () => undefined))
      .toEqual({ outcome: 'missing' })
    expect(await store.cleanupExpiredRun('tenant-1', run.id, 1, () => undefined))
      .toEqual({ outcome: 'not_due' })

    const lease = await store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 10, durationMs: 100,
    })
    expect((await store.acquireLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', now: 20, durationMs: 100,
    }))?.attempt).toBe(1)
    const renewed = await store.renewLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: lease!.attempt,
    }, 30, 100)
    expect(renewed?.expiresAt).toBe(130)
    await expect(store.renewLease({
      tenantId: 'tenant-1', runId: run.id, nodeKey: 'planning', ownerId: 'worker-1', attempt: 1,
    }, 30, 0)).rejects.toThrow(/positive/)
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('keeps the expiration event in the strict shared event union', () => {
    const event = analysisEventSchema.parse({
      version: 1,
      type: 'run.expired',
      eventId: 'event-expired',
      runId: 'run-1',
      runRevision: 2,
      sequence: 1,
      createdAt: 123,
      reason: 'retention_elapsed',
    })
    expect(event.type).toBe('run.expired')
  })

  it('atomically expires active runs, deletes content, and leaves terminal status unchanged', async () => {
    let now = 1_000
    const store = new InMemoryJobStore()
    const service = new RunService({
      store,
      retentionSeconds: 1,
      now: () => now,
      createId: createIds(),
    })
    const active = await service.createRun('tenant-1', makeRequest('f'.repeat(64)))
    await service.uploadSource('tenant-1', active.run.id, partFor())
    const terminal = await service.createRun('tenant-1', makeRequest('9'.repeat(64)))
    await service.uploadSource('tenant-1', terminal.run.id, partFor())
    await service.cancel('tenant-1', terminal.run.id, 1)

    now = 2_000
    const cleaned = await service.cleanupExpired(10)
    const activeSnapshot = await service.getRun('tenant-1', active.run.id)
    const terminalSnapshot = await service.getRun('tenant-1', terminal.run.id)

    expect(cleaned).toEqual({ examined: 2, cleaned: 2, expired: 1 })
    expect(activeSnapshot).toMatchObject({ status: 'expired', revision: 2, completedAt: 2_000 })
    expect(terminalSnapshot).toMatchObject({ status: 'cancelled', revision: 2 })
    expect((await service.listEvents('tenant-1', active.run.id)).at(-1)?.type).toBe('run.expired')
    expect((await service.listEvents('tenant-1', terminal.run.id)).map((event) => event.type)).toEqual([
      'run.accepted',
      'run.cancelled',
    ])
    expect(await service.cleanupExpired(10)).toEqual({ examined: 0, cleaned: 0, expired: 0 })
  })
})
