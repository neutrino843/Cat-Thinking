import type {
  AnalysisEventV1,
  AnalysisRunV1,
  ArtifactDescriptorV1,
  ArtifactEnvelopeV1,
  ArtifactKind,
  EvidenceCardV1,
  EvidenceChunkV1,
  EvidenceGraphV1,
  SourceReceiptV1,
  UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import type { ProviderInvocationLedger } from '../providers/invocationLedger.js'

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

export interface StoredSourceContent {
  readonly sourceId: string
  readonly contentHash: string
  readonly text: string
}

export interface StoredEvidenceCard {
  readonly cacheKey: string
  readonly cardHash: string
  readonly chunk: EvidenceChunkV1
  readonly card: EvidenceCardV1
  readonly expiresAt: number
}

export interface StoreEvidenceCardInput extends StoredEvidenceCard {
  readonly tenantId: string
  readonly runId: string
  readonly lease: LeaseIdentity
  readonly now: number
}

export interface CommitEvidenceGraphInput {
  readonly tenantId: string
  readonly runId: string
  readonly expectedRevision: number
  readonly lease: LeaseIdentity
  readonly graph: EvidenceGraphV1
  readonly now: number
  readonly build: (current: AnalysisRunV1, nextSequence: number) => RunTransition
}

export interface StoredArtifact {
  readonly descriptor: ArtifactDescriptorV1
  readonly artifact: ArtifactEnvelopeV1
}

export interface ArtifactTransition {
  readonly run: AnalysisRunV1
  readonly events: readonly AnalysisEventV1[]
}

interface CommitArtifactInputBase {
  readonly tenantId: string
  readonly runId: string
  readonly kind: ArtifactKind
  readonly expectedRevision: number
  readonly expectedAttempt: number
  readonly lease: LeaseIdentity
  readonly now: number
  readonly build: (current: AnalysisRunV1, nextSequence: number) => ArtifactTransition
}

export type CommitArtifactInput = CommitArtifactInputBase & (
  | Readonly<{
      result: 'succeeded'
      descriptor: ArtifactDescriptorV1
      artifact: ArtifactEnvelopeV1
    }>
  | Readonly<{
      result: 'failed'
    }>
)

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

export type EvidenceGraphCommitResult =
  | RunTransitionResult
  | Readonly<{ outcome: 'lease_conflict' }>

export type ArtifactCommitResult =
  | Readonly<{ outcome: 'updated'; run: AnalysisRunV1; events: readonly AnalysisEventV1[] }>
  | Readonly<{ outcome: 'missing' }>
  | Readonly<{ outcome: 'revision_conflict'; run: AnalysisRunV1 }>
  | Readonly<{ outcome: 'lease_conflict' | 'attempt_conflict' }>

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

export interface JobStore extends ProviderInvocationLedger {
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
  getSourceContent(tenantId: string, runId: string, sourceId: string): Promise<StoredSourceContent | undefined>
  getCachedEvidenceCard(tenantId: string, cacheKey: string, now: number): Promise<StoredEvidenceCard | undefined>
  storeEvidenceCard(input: StoreEvidenceCardInput): Promise<boolean>
  listEvidenceCards(tenantId: string, runId: string): Promise<readonly StoredEvidenceCard[] | undefined>
  commitEvidenceGraph(input: CommitEvidenceGraphInput): Promise<EvidenceGraphCommitResult>
  getEvidenceGraph(tenantId: string, runId: string): Promise<EvidenceGraphV1 | undefined>
  getArtifact(tenantId: string, runId: string, kind: ArtifactKind): Promise<StoredArtifact | undefined>
  listArtifactDescriptors(
    tenantId: string,
    runId: string,
  ): Promise<readonly ArtifactDescriptorV1[] | undefined>
  commitArtifact(input: CommitArtifactInput): Promise<ArtifactCommitResult>
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
