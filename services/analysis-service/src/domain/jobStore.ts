import type {
  AnalysisEventV1,
  AnalysisRunV1,
  SourceReceiptV1,
  UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'

export class JobStoreNotFoundError extends Error {
  constructor(readonly entity: 'run' | 'source' | 'event') {
    super(`${entity} not found`)
    this.name = 'JobStoreNotFoundError'
  }
}

export class JobStoreConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'JobStoreConflictError'
  }
}

export interface StoredSourcePart {
  readonly partIndex: number
  readonly partCount: number
  readonly start: number
  readonly end: number
  readonly totalChars: number
  readonly contentHash: string
  readonly partHash: string
  readonly text: string
}

export interface StoredSourceUpload {
  readonly sourceId: string
  readonly contentHash: string
  readonly totalChars: number
  readonly byteCount: number
  readonly partCount: number
  readonly complete: boolean
  readonly computedHash?: string
  readonly parts: readonly StoredSourcePart[]
}

export interface StoreSourcePartInput {
  readonly tenantId: string
  readonly runId: string
  readonly byteCount: number
  readonly part: UploadSourcePartV1
}

export interface RunTransition {
  readonly run: AnalysisRunV1
  readonly event: AnalysisEventV1
}

export type RunTransitionResult =
  | Readonly<{ outcome: 'updated'; run: AnalysisRunV1; event: AnalysisEventV1 }>
  | Readonly<{ outcome: 'missing' }>
  | Readonly<{ outcome: 'revision_conflict'; run: AnalysisRunV1 }>

export interface JobLease {
  readonly runId: string
  readonly nodeKey: string
  readonly ownerId: string
  readonly attempt: number
  readonly expiresAt: number
}

export interface LeaseRequest {
  readonly tenantId: string
  readonly runId: string
  readonly nodeKey: string
  readonly ownerId: string
  readonly now: number
  readonly durationMs: number
}

export interface LeaseIdentity {
  readonly tenantId: string
  readonly runId: string
  readonly nodeKey: string
  readonly ownerId: string
  readonly attempt: number
}

export interface ExpiredRunReference {
  readonly tenantId: string
  readonly runId: string
}

export type ExpiredRunCleanupResult =
  | Readonly<{ outcome: 'missing' | 'not_due' | 'already_clean' }>
  | Readonly<{ outcome: 'cleaned'; run: AnalysisRunV1; event?: AnalysisEventV1 }>

export interface JobStore {
  checkHealth(): Promise<boolean>
  createRun(
    tenantId: string,
    run: AnalysisRunV1,
    acceptedEvent: AnalysisEventV1,
  ): Promise<Readonly<{ run: AnalysisRunV1; reused: boolean; event?: AnalysisEventV1 }>>
  getRun(tenantId: string, runId: string): Promise<AnalysisRunV1 | undefined>
  transitionRun(
    tenantId: string,
    runId: string,
    expectedRevision: number,
    build: (current: AnalysisRunV1, nextSequence: number) => RunTransition,
  ): Promise<RunTransitionResult>
  storeSourcePart(input: StoreSourcePartInput): Promise<StoredSourceUpload>
  markSourceComplete(
    tenantId: string,
    runId: string,
    sourceId: string,
    computedHash: string,
  ): Promise<StoredSourceUpload | undefined>
  getSourceReceipt(tenantId: string, runId: string, sourceId: string): Promise<SourceReceiptV1 | undefined>
  deleteContent(tenantId: string, runId: string): Promise<boolean | undefined>
  listEvents(
    tenantId: string,
    runId: string,
    afterEventId?: string,
  ): Promise<readonly AnalysisEventV1[] | undefined>
  listExpiredRuns(now: number, limit: number): Promise<readonly ExpiredRunReference[]>
  cleanupExpiredRun(
    tenantId: string,
    runId: string,
    now: number,
    buildTransition: (current: AnalysisRunV1, nextSequence: number) => RunTransition | undefined,
  ): Promise<ExpiredRunCleanupResult>
  acquireLease(request: LeaseRequest): Promise<JobLease | undefined>
  renewLease(identity: LeaseIdentity, now: number, durationMs: number): Promise<JobLease | undefined>
  releaseLease(identity: LeaseIdentity): Promise<boolean>
  close(): Promise<void>
}
