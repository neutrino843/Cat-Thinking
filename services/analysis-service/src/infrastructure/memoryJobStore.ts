import {
  analysisEventSchema,
  analysisRunSchema,
  sourceReceiptSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
  type AnalysisRunV1,
  type SourceReceiptV1,
} from '@cat-thinking/analysis-contracts'
import {
  JobStoreConflictError,
  JobStoreNotFoundError,
  type ExpiredRunReference,
  type ExpiredRunCleanupResult,
  type JobLease,
  type JobStore,
  type LeaseIdentity,
  type LeaseRequest,
  type RunTransition,
  type RunTransitionResult,
  type StoreSourcePartInput,
  type StoredSourcePart,
  type StoredSourceUpload,
} from '../domain/jobStore.js'

interface StoredRunRecord {
  tenantId: string
  run: AnalysisRunV1
  events: AnalysisEventV1[]
  contentDeleted: boolean
}

interface MutableSourceUpload {
  sourceId: string
  contentHash: string
  totalChars: number
  byteCount: number
  partCount: number
  complete: boolean
  computedHash?: string
  parts: Map<number, StoredSourcePart>
}

const runKey = (tenantId: string, runId: string): string => `${tenantId}\u0000${runId}`
const requestKey = (tenantId: string, value: string): string => `${tenantId}\u0000${value}`
const sourceKey = (tenantId: string, runId: string, sourceId: string): string =>
  `${tenantId}\u0000${runId}\u0000${sourceId}`
const leaseKey = (tenantId: string, runId: string, nodeKey: string): string =>
  `${tenantId}\u0000${runId}\u0000${nodeKey}`

const cloneRun = (run: AnalysisRunV1): AnalysisRunV1 => analysisRunSchema.parse(run)
const cloneEvent = (event: AnalysisEventV1): AnalysisEventV1 => analysisEventSchema.parse(event)

const sourceView = (source: MutableSourceUpload): StoredSourceUpload => ({
  sourceId: source.sourceId,
  contentHash: source.contentHash,
  totalChars: source.totalChars,
  byteCount: source.byteCount,
  partCount: source.partCount,
  complete: source.complete,
  computedHash: source.computedHash,
  parts: [...source.parts.values()]
    .sort((left, right) => left.partIndex - right.partIndex)
    .map((part) => ({ ...part })),
})

export class InMemoryJobStore implements JobStore {
  private readonly runs = new Map<string, StoredRunRecord>()
  private readonly requestKeys = new Map<string, string>()
  private readonly sources = new Map<string, MutableSourceUpload>()
  private readonly leases = new Map<string, JobLease>()

  checkHealth(): Promise<boolean> {
    return Promise.resolve(true)
  }

  async createRun(
    tenantId: string,
    runInput: AnalysisRunV1,
    eventInput: AnalysisEventV1,
  ): Promise<Readonly<{ run: AnalysisRunV1; reused: boolean; event?: AnalysisEventV1 }>> {
    const run = cloneRun(runInput)
    const event = cloneEvent(eventInput)
    const existingRunId = this.requestKeys.get(requestKey(tenantId, run.requestKey))
    if (existingRunId) {
      const existing = this.runs.get(runKey(tenantId, existingRunId))
      if (!existing) throw new Error('in-memory request index is inconsistent')
      return { run: cloneRun(existing.run), reused: true }
    }
    if (event.runId !== run.id || event.runRevision !== run.revision || event.sequence !== 0) {
      throw new TypeError('accepted event does not match the new run')
    }
    this.runs.set(runKey(tenantId, run.id), {
      tenantId,
      run,
      events: [event],
      contentDeleted: false,
    })
    this.requestKeys.set(requestKey(tenantId, run.requestKey), run.id)
    return { run: cloneRun(run), reused: false, event: cloneEvent(event) }
  }

  async getRun(tenantId: string, runId: string): Promise<AnalysisRunV1 | undefined> {
    const record = this.runs.get(runKey(tenantId, runId))
    return record ? cloneRun(record.run) : undefined
  }

  async transitionRun(
    tenantId: string,
    runId: string,
    expectedRevision: number,
    build: (current: AnalysisRunV1, nextSequence: number) => RunTransition,
  ): Promise<RunTransitionResult> {
    const record = this.runs.get(runKey(tenantId, runId))
    if (!record) return { outcome: 'missing' }
    if (record.run.revision !== expectedRevision) {
      return { outcome: 'revision_conflict', run: cloneRun(record.run) }
    }
    const nextSequence = (record.events.at(-1)?.sequence ?? -1) + 1
    const transition = build(cloneRun(record.run), nextSequence)
    const run = cloneRun(transition.run)
    const event = cloneEvent(transition.event)
    if (
      run.id !== runId
      || run.revision !== expectedRevision + 1
      || event.runId !== runId
      || event.runRevision !== run.revision
      || event.sequence !== nextSequence
    ) {
      throw new TypeError('run transition identity, revision, or event sequence is invalid')
    }
    record.run = run
    record.events.push(event)
    return { outcome: 'updated', run: cloneRun(run), event: cloneEvent(event) }
  }

  async storeSourcePart(input: StoreSourcePartInput): Promise<StoredSourceUpload> {
    const record = this.runs.get(runKey(input.tenantId, input.runId))
    if (!record) throw new JobStoreNotFoundError('run')
    if (record.contentDeleted) throw new JobStoreConflictError('run content was deleted')
    const part = uploadSourcePartSchema.parse(input.part)
    const key = sourceKey(input.tenantId, input.runId, part.sourceId)
    const source = this.sources.get(key) ?? {
      sourceId: part.sourceId,
      contentHash: part.contentHash,
      totalChars: part.totalChars,
      byteCount: input.byteCount,
      partCount: part.partCount,
      complete: false,
      parts: new Map<number, StoredSourcePart>(),
    }
    if (
      source.contentHash !== part.contentHash
      || source.totalChars !== part.totalChars
      || source.byteCount !== input.byteCount
      || source.partCount !== part.partCount
    ) {
      throw new JobStoreConflictError('source upload metadata changed')
    }
    const storedPart: StoredSourcePart = {
      partIndex: part.partIndex,
      partCount: part.partCount,
      start: part.start,
      end: part.end,
      totalChars: part.totalChars,
      contentHash: part.contentHash,
      partHash: part.partHash,
      text: part.text,
    }
    const existing = source.parts.get(part.partIndex)
    if (existing && JSON.stringify(existing) !== JSON.stringify(storedPart)) {
      throw new JobStoreConflictError('source part changed after upload')
    }
    source.parts.set(part.partIndex, storedPart)
    this.sources.set(key, source)
    return sourceView(source)
  }

  async markSourceComplete(
    tenantId: string,
    runId: string,
    sourceId: string,
    computedHash: string,
  ): Promise<StoredSourceUpload | undefined> {
    const source = this.sources.get(sourceKey(tenantId, runId, sourceId))
    if (!source) return undefined
    if (source.computedHash !== undefined && source.computedHash !== computedHash) {
      throw new JobStoreConflictError('source completion hash changed')
    }
    source.complete = true
    source.computedHash = computedHash
    return sourceView(source)
  }

  async getSourceReceipt(
    tenantId: string,
    runId: string,
    sourceId: string,
  ): Promise<SourceReceiptV1 | undefined> {
    const source = this.sources.get(sourceKey(tenantId, runId, sourceId))
    if (!source) return undefined
    return sourceReceiptSchema.parse({
      version: 1,
      sourceId,
      receivedParts: source.parts.size,
      partCount: source.partCount,
      complete: source.complete,
      computedHash: source.computedHash,
    })
  }

  async deleteContent(tenantId: string, runId: string): Promise<boolean | undefined> {
    const record = this.runs.get(runKey(tenantId, runId))
    if (!record) return undefined
    if (record.contentDeleted) return false
    for (const key of [...this.sources.keys()]) {
      if (key.startsWith(`${tenantId}\u0000${runId}\u0000`)) this.sources.delete(key)
    }
    record.contentDeleted = true
    return true
  }

  async listEvents(
    tenantId: string,
    runId: string,
    afterEventId?: string,
  ): Promise<readonly AnalysisEventV1[] | undefined> {
    const record = this.runs.get(runKey(tenantId, runId))
    if (!record) return undefined
    let start = 0
    if (afterEventId !== undefined) {
      const index = record.events.findIndex((event) => event.eventId === afterEventId)
      if (index < 0) throw new JobStoreNotFoundError('event')
      start = index + 1
    }
    return record.events.slice(start).map(cloneEvent)
  }

  async listExpiredRuns(now: number, limit: number): Promise<readonly ExpiredRunReference[]> {
    const result: ExpiredRunReference[] = []
    for (const record of this.runs.values()) {
      if (!record.contentDeleted && record.run.expiresAt !== undefined && record.run.expiresAt <= now) {
        result.push({ tenantId: record.tenantId, runId: record.run.id })
        if (result.length >= limit) break
      }
    }
    return result
  }

  async cleanupExpiredRun(
    tenantId: string,
    runId: string,
    now: number,
    buildTransition: (current: AnalysisRunV1, nextSequence: number) => RunTransition | undefined,
  ): Promise<ExpiredRunCleanupResult> {
    const record = this.runs.get(runKey(tenantId, runId))
    if (!record) return { outcome: 'missing' }
    if (record.contentDeleted) return { outcome: 'already_clean' }
    if (record.run.expiresAt === undefined || record.run.expiresAt > now) return { outcome: 'not_due' }
    for (const key of [...this.sources.keys()]) {
      if (key.startsWith(`${tenantId}\u0000${runId}\u0000`)) this.sources.delete(key)
    }
    record.contentDeleted = true
    const nextSequence = (record.events.at(-1)?.sequence ?? -1) + 1
    const transition = buildTransition(cloneRun(record.run), nextSequence)
    if (!transition) return { outcome: 'cleaned', run: cloneRun(record.run) }
    const run = cloneRun(transition.run)
    const event = cloneEvent(transition.event)
    if (
      run.revision !== record.run.revision + 1
      || event.runId !== runId
      || event.runRevision !== run.revision
      || event.sequence !== nextSequence
    ) throw new TypeError('expired run transition is invalid')
    record.run = run
    record.events.push(event)
    return { outcome: 'cleaned', run: cloneRun(run), event: cloneEvent(event) }
  }

  async acquireLease(request: LeaseRequest): Promise<JobLease | undefined> {
    if (request.durationMs <= 0) throw new RangeError('lease duration must be positive')
    if (!this.runs.has(runKey(request.tenantId, request.runId))) return undefined
    const key = leaseKey(request.tenantId, request.runId, request.nodeKey)
    const current = this.leases.get(key)
    if (current && current.expiresAt > request.now && current.ownerId !== request.ownerId) return undefined
    const attempt = current
      ? current.ownerId === request.ownerId && current.expiresAt > request.now
        ? current.attempt
        : current.attempt + 1
      : 1
    const lease = Object.freeze({
      runId: request.runId,
      nodeKey: request.nodeKey,
      ownerId: request.ownerId,
      attempt,
      expiresAt: request.now + request.durationMs,
    })
    this.leases.set(key, lease)
    return lease
  }

  async renewLease(identity: LeaseIdentity, now: number, durationMs: number): Promise<JobLease | undefined> {
    if (durationMs <= 0) throw new RangeError('lease duration must be positive')
    const key = leaseKey(identity.tenantId, identity.runId, identity.nodeKey)
    const current = this.leases.get(key)
    if (
      !current
      || current.ownerId !== identity.ownerId
      || current.attempt !== identity.attempt
      || current.expiresAt <= now
    ) return undefined
    const lease = Object.freeze({ ...current, expiresAt: now + durationMs })
    this.leases.set(key, lease)
    return lease
  }

  async releaseLease(identity: LeaseIdentity): Promise<boolean> {
    const key = leaseKey(identity.tenantId, identity.runId, identity.nodeKey)
    const current = this.leases.get(key)
    if (!current || current.ownerId !== identity.ownerId || current.attempt !== identity.attempt) return false
    return this.leases.delete(key)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
