import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_LIMITS,
  ARTIFACT_KINDS,
  analysisRequestSchema,
  analysisRunSchema,
  cancelRunResultSchema,
  deleteRunContentResultSchema,
  engineCapabilitiesSchema,
  retryArtifactAcceptedSchema,
  runCreatedSchema,
  sourceReceiptSchema,
  uploadSourcePartSchema,
  type AnalysisEventV1,
  type AnalysisRequestV1,
  type AnalysisRunV1,
  type ArtifactKind,
  type CancelRunResultV1,
  type DeleteRunContentResultV1,
  type EngineCapabilitiesV1,
  type RetryArtifactAcceptedV1,
  type RunCreatedV1,
  type SourceReceiptV1,
  type UploadSourcePartV1,
} from '@cat-thinking/analysis-contracts'
import type { AnalysisEngineClient } from './engineClient'
import { sha256Hex } from './fingerprint'

export interface MockEngineOptions {
  events?: readonly AnalysisEventV1[]
  now?: () => number
  createRunId?: () => string
}

interface MockUploadState {
  contentHash: string
  partCount: number
  totalChars: number
  parts: Map<number, {
    start: number
    end: number
    text: string
    partHash: string
  }>
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

const createArtifactStates = (
  request: AnalysisRequestV1,
  now: number,
): AnalysisRunV1['artifactStates'] => {
  const states: AnalysisRunV1['artifactStates'] = {}
  for (const kind of request.artifacts) {
    states[kind] = { status: 'pending', attempt: 0, updatedAt: now }
  }
  return states
}

export class MockAnalysisEngineClient implements AnalysisEngineClient {
  private readonly runs = new Map<string, AnalysisRunV1>()
  private readonly requestKeys = new Map<string, string>()
  private readonly receivedParts = new Map<string, MockUploadState>()
  private readonly eventsToReplay: readonly AnalysisEventV1[]
  private readonly now: () => number
  private readonly createRunId: () => string

  constructor(options: MockEngineOptions = {}) {
    this.eventsToReplay = options.events ?? []
    this.now = options.now ?? (() => Date.now())
    this.createRunId = options.createRunId ?? (() => crypto.randomUUID())
  }

  async capabilities(signal: AbortSignal): Promise<EngineCapabilitiesV1> {
    throwIfAborted(signal)
    return engineCapabilitiesSchema.parse({
      service: 'cat-analysis-engine',
      serviceVersion: 'mock-1',
      acceptsRuns: true,
      degradedReasons: [],
      contractVersions: [ANALYSIS_CONTRACT_VERSION],
      qualityProfiles: ['economy', 'standard', 'high-quality'],
      artifactKinds: [...ARTIFACT_KINDS],
      maxSourcesPerRun: 20,
      maxSourceCharacters: 2_000_000,
      maxUploadPartBytes: ANALYSIS_LIMITS.maxUploadPartBytes,
      supportsSse: true,
      supportsCancellation: true,
      supportsExternalKnowledge: false,
      retentionSeconds: 0,
    })
  }

  async createRun(requestInput: AnalysisRequestV1, signal: AbortSignal): Promise<RunCreatedV1> {
    throwIfAborted(signal)
    const request = analysisRequestSchema.parse(requestInput)
    const existingId = this.requestKeys.get(request.requestKey)
    if (existingId) {
      const existing = this.requireRun(existingId)
      return runCreatedSchema.parse({ version: 1, run: existing, reused: true })
    }

    const now = this.now()
    const run = analysisRunSchema.parse({
      version: ANALYSIS_CONTRACT_VERSION,
      id: this.createRunId(),
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
      artifactStates: createArtifactStates(request, now),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicros: 0,
        currency: 'CNY',
      },
      createdAt: now,
      updatedAt: now,
    })
    this.runs.set(run.id, run)
    this.requestKeys.set(run.requestKey, run.id)
    return runCreatedSchema.parse({ version: 1, run, reused: false })
  }

  async uploadSource(
    runId: string,
    sourceInput: UploadSourcePartV1,
    signal: AbortSignal,
  ): Promise<SourceReceiptV1> {
    throwIfAborted(signal)
    const run = this.requireRun(runId)
    const source = uploadSourcePartSchema.parse(sourceInput)
    const snapshot = run.request.manifest.sources.find((candidate) => candidate.sourceId === source.sourceId)
    if (
      !snapshot
      || snapshot.contentHash !== source.contentHash
      || snapshot.charCount !== source.totalChars
    ) {
      throw new Error('Mock source does not match run manifest')
    }
    const key = `${runId}:${source.sourceId}`
    const upload = this.receivedParts.get(key) ?? {
      contentHash: source.contentHash,
      partCount: source.partCount,
      totalChars: source.totalChars,
      parts: new Map(),
    }
    if (
      upload.partCount !== source.partCount
      || upload.contentHash !== source.contentHash
      || upload.totalChars !== source.totalChars
    ) {
      throw new Error('Mock source upload metadata changed between parts')
    }

    const computedPartHash = await sha256Hex(source.text)
    if (computedPartHash !== source.partHash) throw new Error('Mock source part hash mismatch')

    const existingPart = upload.parts.get(source.partIndex)
    if (
      existingPart
      && (
        existingPart.start !== source.start
        || existingPart.end !== source.end
        || existingPart.text !== source.text
        || existingPart.partHash !== source.partHash
      )
    ) {
      throw new Error('Mock source part changed after upload')
    }
    upload.parts.set(source.partIndex, {
      start: source.start,
      end: source.end,
      text: source.text,
      partHash: source.partHash,
    })
    this.receivedParts.set(key, upload)
    const complete = upload.parts.size === source.partCount
    let computedHash: string | undefined
    if (complete) {
      let cursor = 0
      let combined = ''
      for (let index = 0; index < upload.partCount; index += 1) {
        const part = upload.parts.get(index)
        if (!part || part.start !== cursor) throw new Error('Mock source parts are not contiguous')
        cursor = part.end
        combined += part.text
      }
      if (cursor !== upload.totalChars) throw new Error('Mock source parts do not cover the source')
      computedHash = await sha256Hex(combined)
      if (computedHash !== upload.contentHash) throw new Error('Mock source content hash mismatch')
      if (new TextEncoder().encode(combined).byteLength !== snapshot.byteCount) {
        throw new Error('Mock source byte count mismatch')
      }
    }
    return sourceReceiptSchema.parse({
      version: 1,
      sourceId: source.sourceId,
      receivedParts: upload.parts.size,
      partCount: source.partCount,
      complete,
      computedHash,
    })
  }

  async startRun(runId: string, expectedRevision: number, signal: AbortSignal): Promise<AnalysisRunV1> {
    throwIfAborted(signal)
    const current = this.requireRevision(runId, expectedRevision)
    const missingSource = current.request.manifest.sources.find((source) => {
      const upload = this.receivedParts.get(`${runId}:${source.sourceId}`)
      return !upload || upload.parts.size !== upload.partCount
    })
    if (missingSource) throw new Error(`Mock source upload is incomplete: ${missingSource.sourceId}`)
    const now = this.now()
    const run = analysisRunSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: 'queued',
      stage: 'planning',
      updatedAt: now,
    })
    this.runs.set(runId, run)
    return run
  }

  async getRun(runId: string, signal: AbortSignal): Promise<AnalysisRunV1> {
    throwIfAborted(signal)
    return this.requireRun(runId)
  }

  async *events(
    runId: string,
    options: { lastEventId?: string; signal: AbortSignal },
  ): AsyncIterable<AnalysisEventV1> {
    this.requireRun(runId)
    const lastIndex = options.lastEventId === undefined
      ? -1
      : this.eventsToReplay.findIndex((event) => event.eventId === options.lastEventId)
    for (const event of this.eventsToReplay.slice(lastIndex + 1)) {
      throwIfAborted(options.signal)
      if (event.runId === runId) yield event
    }
  }

  async cancel(
    runId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<CancelRunResultV1> {
    throwIfAborted(signal)
    const current = this.requireRevision(runId, expectedRevision)
    const now = this.now()
    const run = analysisRunSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: 'cancelled',
      stage: undefined,
      updatedAt: now,
      completedAt: now,
    })
    this.runs.set(runId, run)
    return cancelRunResultSchema.parse({ version: 1, runId, revision: run.revision, accepted: true })
  }

  async retryArtifact(
    runId: string,
    kind: ArtifactKind,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<RetryArtifactAcceptedV1> {
    throwIfAborted(signal)
    const current = this.requireRevision(runId, expectedRevision)
    if (!current.request.artifacts.includes(kind)) throw new Error('Artifact was not requested')
    const revision = current.revision + 1
    const state = current.artifactStates[kind]
    if (!state) throw new Error('Artifact state is missing')
    const run = analysisRunSchema.parse({
      ...current,
      revision,
      status: 'queued',
      stage: 'planning',
      updatedAt: this.now(),
      artifactStates: {
        ...current.artifactStates,
        [kind]: { status: 'pending', attempt: state.attempt + 1, updatedAt: this.now() },
      },
    })
    this.runs.set(runId, run)
    return retryArtifactAcceptedSchema.parse({ version: 1, runId, kind, revision, accepted: true })
  }

  async deleteContent(runId: string, signal: AbortSignal): Promise<DeleteRunContentResultV1> {
    throwIfAborted(signal)
    this.requireRun(runId)
    for (const key of [...this.receivedParts.keys()]) {
      if (key.startsWith(`${runId}:`)) this.receivedParts.delete(key)
    }
    return deleteRunContentResultSchema.parse({ version: 1, runId, deleted: true })
  }

  private requireRun(runId: string): AnalysisRunV1 {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`Unknown mock run: ${runId}`)
    return run
  }

  private requireRevision(runId: string, expectedRevision: number): AnalysisRunV1 {
    const run = this.requireRun(runId)
    if (run.revision !== expectedRevision) throw new Error('Mock run revision conflict')
    return run
  }
}
