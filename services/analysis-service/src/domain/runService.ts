import { createHash, randomUUID } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
  analysisEventSchema,
  analysisRequestSchema,
  analysisRunSchema,
  canonicalizeJson,
  cancelRunResultSchema,
  deleteRunContentResultSchema,
  retryArtifactAcceptedSchema,
  runCreatedSchema,
  sourceReceiptSchema,
  startRunResultSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
  type AnalysisRequestV1,
  type AnalysisRunV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type CancelRunResultV1,
  type DeleteRunContentResultV1,
  type RetryArtifactAcceptedV1,
  type RunCreatedV1,
  type SourceReceiptV1,
  type StartRunResultV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import { ServiceHttpError, createContractError } from '../errors.js'
import { RunEventBroker } from './eventBroker.js'
import {
  JobStoreConflictError,
  JobStoreNotFoundError,
  type JobStore,
  type RunTransitionResult,
  type StoredSourceUpload,
} from './jobStore.js'

const TERMINAL_STATUSES = new Set<AnalysisRunV1['status']>([
  'partial',
  'succeeded',
  'cancelled',
  'failed',
  'expired',
])

export const isTerminalRun = (run: AnalysisRunV1): boolean => TERMINAL_STATUSES.has(run.status)

const artifactStatesFor = (
  request: AnalysisRequestV1,
  now: number,
): AnalysisRunV1['artifactStates'] => Object.fromEntries(
  request.artifacts.map((kind) => [kind, { status: 'pending', attempt: 0, updatedAt: now }]),
)

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const httpError = (
  statusCode: number,
  code: Parameters<typeof createContractError>[0],
  category: Parameters<typeof createContractError>[1],
  retryable: boolean,
  messageKey: string,
  details?: Parameters<typeof createContractError>[4],
): ServiceHttpError => new ServiceHttpError(
  statusCode,
  createContractError(code, category, retryable, messageKey, details),
)

const notFound = (): ServiceHttpError => httpError(
  404,
  'invalid_request',
  'client',
  false,
  'analysis.run.not_found',
)

const conflict = (messageKey: string, details?: Record<string, string | number | boolean | null>): ServiceHttpError =>
  httpError(409, 'conflict', 'conflict', false, messageKey, details)

const sourceMissing = (sourceId: string): ServiceHttpError => httpError(
  409,
  'source_missing',
  'validation',
  false,
  'analysis.source.missing',
  { sourceId },
)

const sourceHashMismatch = (sourceId: string): ServiceHttpError => httpError(
  422,
  'source_hash_mismatch',
  'validation',
  false,
  'analysis.source.hash_mismatch',
  { sourceId },
)

export interface RunServiceOptions {
  readonly store: JobStore
  readonly retentionSeconds: number
  readonly broker?: RunEventBroker
  readonly now?: () => number
  readonly createId?: () => string
}

export class RunService {
  readonly broker: RunEventBroker
  private readonly store: JobStore
  private readonly retentionSeconds: number
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: RunServiceOptions) {
    this.store = options.store
    this.retentionSeconds = options.retentionSeconds
    this.broker = options.broker ?? new RunEventBroker()
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  checkHealth(): Promise<boolean> {
    return this.store.checkHealth()
  }

  async createRun(tenantId: string, requestInput: AnalysisRequestV1): Promise<RunCreatedV1> {
    const request = analysisRequestSchema.parse(requestInput)
    const now = this.now()
    const run = analysisRunSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      id: this.createId(),
      docId: request.docId,
      requestKey: request.requestKey,
      request,
      revision: 1,
      status: 'receiving',
      stage: 'receiving',
      progress: 0,
      coverage: {
        input: 0,
        analysis: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksTotal: 0,
      },
      providerRoutes: [],
      artifactStates: artifactStatesFor(request, now),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicros: 0,
        currency: 'USD',
      },
      createdAt: now,
      updatedAt: now,
      expiresAt: this.retentionSeconds > 0 ? now + this.retentionSeconds * 1_000 : undefined,
    })
    const acceptedEvent = analysisEventSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      type: 'run.accepted',
      eventId: this.createId(),
      runId: run.id,
      runRevision: run.revision,
      sequence: 0,
      createdAt: now,
      requestKey: request.requestKey,
    })
    const created = await this.store.createRun(tenantId, run, acceptedEvent)
    if (created.reused && canonicalizeJson(created.run.request) !== canonicalizeJson(request)) {
      throw conflict('analysis.run.request_key_collision')
    }
    if (!created.reused) this.broker.publish(created.run.id)
    return runCreatedSchema.parse({ version: ANALYSIS_CONTRACT_VERSION, run: created.run, reused: created.reused })
  }

  async uploadSource(
    tenantId: string,
    runId: string,
    sourceInput: UploadSourcePartV1,
  ): Promise<SourceReceiptV1> {
    const run = await this.requireRun(tenantId, runId)
    if (run.status !== 'receiving') throw conflict('analysis.source.run_not_receiving')
    const part = uploadSourcePartSchema.parse(sourceInput)
    const snapshot = run.request.manifest.sources.find((candidate) => candidate.sourceId === part.sourceId)
    if (!snapshot) throw sourceMissing(part.sourceId)
    if (snapshot.contentHash !== part.contentHash || snapshot.charCount !== part.totalChars) {
      throw sourceHashMismatch(part.sourceId)
    }
    if (sha256(part.text) !== part.partHash) throw sourceHashMismatch(part.sourceId)

    let upload: StoredSourceUpload
    try {
      upload = await this.store.storeSourcePart({ tenantId, runId, byteCount: snapshot.byteCount, part })
    } catch (error) {
      if (error instanceof JobStoreNotFoundError) throw notFound()
      if (error instanceof JobStoreConflictError) throw conflict('analysis.source.upload_conflict')
      throw error
    }

    if (upload.parts.length === upload.partCount) {
      const combined = this.combineSource(upload)
      if (
        combined.length !== upload.totalChars
        || new TextEncoder().encode(combined).byteLength !== upload.byteCount
        || sha256(combined) !== upload.contentHash
      ) {
        throw sourceHashMismatch(part.sourceId)
      }
      upload = await this.store.markSourceComplete(tenantId, runId, part.sourceId, upload.contentHash)
        ?? upload
    }

    return sourceReceiptSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      sourceId: part.sourceId,
      receivedParts: upload.parts.length,
      partCount: upload.partCount,
      complete: upload.complete,
      computedHash: upload.computedHash,
    })
  }

  async startRun(tenantId: string, runId: string, expectedRevision: number): Promise<StartRunResultV1> {
    const current = await this.requireRun(tenantId, runId)
    if (current.status !== 'receiving') throw conflict('analysis.run.not_receiving')
    for (const source of current.request.manifest.sources) {
      const receipt = await this.store.getSourceReceipt(tenantId, runId, source.sourceId)
      if (!receipt?.complete || receipt.computedHash !== source.contentHash) throw sourceMissing(source.sourceId)
    }
    const transitioned = await this.store.transitionRun(
      tenantId,
      runId,
      expectedRevision,
      (run, nextSequence) => {
        if (run.status !== 'receiving') throw conflict('analysis.run.not_receiving')
        const now = this.now()
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'queued',
          stage: 'planning',
          updatedAt: now,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'stage.started',
            eventId: this.createId(),
            runId,
            runRevision: next.revision,
            sequence: nextSequence,
            createdAt: now,
            stage: 'planning',
          }),
        }
      },
    )
    const run = this.unwrapTransition(transitioned, expectedRevision)
    this.broker.publish(runId)
    return startRunResultSchema.parse({ version: ANALYSIS_CONTRACT_VERSION, run })
  }

  async getRun(tenantId: string, runId: string): Promise<AnalysisRunV1> {
    return this.requireRun(tenantId, runId)
  }

  async listEvents(
    tenantId: string,
    runId: string,
    afterEventId?: string,
  ): Promise<readonly AnalysisEventV1[]> {
    try {
      const events = await this.store.listEvents(tenantId, runId, afterEventId)
      if (!events) throw notFound()
      return events
    } catch (error) {
      if (error instanceof JobStoreNotFoundError && error.entity === 'event') {
        throw conflict('analysis.events.cursor_unknown', { eventId: afterEventId ?? '' })
      }
      throw error
    }
  }

  async cancel(
    tenantId: string,
    runId: string,
    expectedRevision: number,
  ): Promise<CancelRunResultV1> {
    const current = await this.requireRun(tenantId, runId)
    if (current.status === 'cancelled') {
      return cancelRunResultSchema.parse({
        version: ANALYSIS_CONTRACT_VERSION,
        runId,
        revision: current.revision,
        accepted: false,
      })
    }
    if (isTerminalRun(current)) throw conflict('analysis.run.terminal')
    const transitioned = await this.store.transitionRun(
      tenantId,
      runId,
      expectedRevision,
      (run, nextSequence) => {
        if (isTerminalRun(run)) throw conflict('analysis.run.terminal')
        const now = this.now()
        const artifactStates = { ...run.artifactStates }
        for (const kind of run.request.artifacts) {
          const state = artifactStates[kind]
          if (state && (state.status === 'pending' || state.status === 'running')) {
            artifactStates[kind] = { ...state, status: 'cancelled', updatedAt: now }
          }
        }
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'cancelled',
          stage: undefined,
          artifactStates,
          updatedAt: now,
          completedAt: now,
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'run.cancelled',
            eventId: this.createId(),
            runId,
            runRevision: next.revision,
            sequence: nextSequence,
            createdAt: now,
            effect: 'scheduling_stopped',
          }),
        }
      },
    )
    if (transitioned.outcome === 'revision_conflict' && transitioned.run.status === 'cancelled') {
      return cancelRunResultSchema.parse({
        version: ANALYSIS_CONTRACT_VERSION,
        runId,
        revision: transitioned.run.revision,
        accepted: false,
      })
    }
    const run = this.unwrapTransition(transitioned, expectedRevision)
    this.broker.publish(runId)
    return cancelRunResultSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      runId,
      revision: run.revision,
      accepted: true,
    })
  }

  async retryArtifact(
    tenantId: string,
    runId: string,
    kind: ArtifactKind,
    expectedRevision: number,
  ): Promise<RetryArtifactAcceptedV1> {
    const transitioned = await this.store.transitionRun(
      tenantId,
      runId,
      expectedRevision,
      (run, nextSequence) => {
        const state = run.artifactStates[kind]
        if (!state) throw conflict('analysis.artifact.not_requested', { kind })
        if (state.status !== 'failed' && state.status !== 'cancelled') {
          throw conflict('analysis.artifact.not_retryable', { kind })
        }
        const now = this.now()
        const next = analysisRunSchema.parse({
          ...run,
          revision: run.revision + 1,
          status: 'generating',
          stage: kind,
          updatedAt: now,
          completedAt: undefined,
          error: undefined,
          artifactStates: {
            ...run.artifactStates,
            [kind]: { status: 'pending', attempt: state.attempt + 1, updatedAt: now },
          },
        })
        return {
          run: next,
          event: analysisEventSchema.parse({
            version: ANALYSIS_CONTRACT_VERSION,
            type: 'stage.started',
            eventId: this.createId(),
            runId,
            runRevision: next.revision,
            sequence: nextSequence,
            createdAt: now,
            stage: kind,
          }),
        }
      },
    )
    const run = this.unwrapTransition(transitioned, expectedRevision)
    this.broker.publish(runId)
    return retryArtifactAcceptedSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      runId,
      kind,
      revision: run.revision,
      accepted: true,
    })
  }

  async getArtifact(tenantId: string, runId: string, kind: ArtifactKind): Promise<ArtifactEnvelopeV1> {
    await this.requireRun(tenantId, runId)
    const stored = await this.store.getArtifact(tenantId, runId, kind)
    if (!stored) throw httpError(404, 'invalid_request', 'client', false, 'analysis.artifact.not_found', { kind })
    return stored.artifact
  }

  async deleteContent(tenantId: string, runId: string): Promise<DeleteRunContentResultV1> {
    const deleted = await this.store.deleteContent(tenantId, runId)
    if (deleted === undefined) throw notFound()
    return deleteRunContentResultSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      runId,
      deleted,
    })
  }

  async cleanupExpired(limit: number): Promise<Readonly<{ examined: number; cleaned: number; expired: number }>> {
    const now = this.now()
    const references = await this.store.listExpiredRuns(now, limit)
    let cleaned = 0
    let expired = 0
    for (const reference of references) {
      const result = await this.store.cleanupExpiredRun(
        reference.tenantId,
        reference.runId,
        now,
        (run, nextSequence) => {
          if (isTerminalRun(run)) return undefined
          const artifactStates = { ...run.artifactStates }
          for (const kind of run.request.artifacts) {
            const state = artifactStates[kind]
            if (state && (state.status === 'pending' || state.status === 'running')) {
              artifactStates[kind] = { ...state, status: 'cancelled', updatedAt: now }
            }
          }
          const next = analysisRunSchema.parse({
            ...run,
            revision: run.revision + 1,
            status: 'expired',
            stage: undefined,
            artifactStates,
            updatedAt: now,
            completedAt: now,
          })
          return {
            run: next,
            event: analysisEventSchema.parse({
              version: ANALYSIS_CONTRACT_VERSION,
              type: 'run.expired',
              eventId: this.createId(),
              runId: run.id,
              runRevision: next.revision,
              sequence: nextSequence,
              createdAt: now,
              reason: 'retention_elapsed',
            }),
          }
        },
      )
      if (result.outcome !== 'cleaned') continue
      cleaned += 1
      if (result.event) {
        expired += 1
        this.broker.publish(reference.runId)
      }
    }
    return { examined: references.length, cleaned, expired }
  }

  private async requireRun(tenantId: string, runId: string): Promise<AnalysisRunV1> {
    const run = await this.store.getRun(tenantId, runId)
    if (!run) throw notFound()
    return run
  }

  private combineSource(upload: StoredSourceUpload): string {
    let cursor = 0
    let combined = ''
    for (let index = 0; index < upload.partCount; index += 1) {
      const part = upload.parts[index]
      if (!part || part.partIndex !== index || part.start !== cursor) {
        throw conflict('analysis.source.parts_not_contiguous', { sourceId: upload.sourceId })
      }
      cursor = part.end
      combined += part.text
    }
    if (cursor !== upload.totalChars) {
      throw conflict('analysis.source.parts_not_contiguous', { sourceId: upload.sourceId })
    }
    return combined
  }

  private unwrapTransition(result: RunTransitionResult, expectedRevision: number): AnalysisRunV1 {
    if (result.outcome === 'missing') throw notFound()
    if (result.outcome === 'revision_conflict') {
      throw conflict('analysis.run.revision_conflict', {
        expectedRevision,
        actualRevision: result.run.revision,
      })
    }
    return result.run
  }
}
