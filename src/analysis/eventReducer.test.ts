import { describe, expect, it } from 'vitest'
import {
  analysisRequestSchema,
  analysisRunSchema,
  summaryArtifactEnvelopeSchema,
  type AnalysisErrorV1,
  type AnalysisEventV1,
} from '@cat-thinking/analysis-contracts'
import requestFixture from '../../packages/analysis-contracts/fixtures/analysis-request.valid.json'
import summaryFixture from '../../packages/analysis-contracts/fixtures/summary-artifact.valid.json'
import {
  applyAnalysisEvent,
  createRunMirror,
  markConnectionLost,
  reconcileRunSnapshot,
} from './eventReducer'

const error: AnalysisErrorV1 = {
  version: 1,
  code: 'provider_timeout',
  category: 'provider',
  retryable: true,
  messageKey: 'analysis.provider_timeout',
  stage: 'summary',
}

const acceptedEvent = (overrides: Partial<AnalysisEventV1> = {}): AnalysisEventV1 => ({
  version: 1,
  type: 'run.accepted',
  eventId: 'event-0',
  runId: 'run-1',
  runRevision: 1,
  sequence: 0,
  createdAt: 1791500000000,
  requestKey: 'a'.repeat(64),
  ...overrides,
} as AnalysisEventV1)

describe('analysis event reducer', () => {
  it('accepts ordered events and mirrors progress monotonically', () => {
    const initial = createRunMirror('run-1')
    const accepted = applyAnalysisEvent(initial, acceptedEvent())
    const progressed = applyAnalysisEvent(accepted.state, {
      version: 1,
      type: 'progress.updated',
      eventId: 'event-1',
      runId: 'run-1',
      runRevision: 1,
      sequence: 1,
      createdAt: 1791500000100,
      stage: 'mapping',
      progress: 0.4,
    })
    const lowerProgress = applyAnalysisEvent(progressed.state, {
      version: 1,
      type: 'progress.updated',
      eventId: 'event-2',
      runId: 'run-1',
      runRevision: 1,
      sequence: 2,
      createdAt: 1791500000200,
      stage: 'mapping',
      progress: 0.2,
    })

    expect(accepted.accepted).toBe(true)
    expect(lowerProgress.state.status).toBe('mapping')
    expect(lowerProgress.state.progress).toBe(0.4)
    expect(lowerProgress.state.lastEventId).toBe('event-2')
  })

  it('rejects wrong-run, stale-revision, duplicate and out-of-order events', () => {
    const accepted = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state

    expect(applyAnalysisEvent(accepted, acceptedEvent({ runId: 'run-2', sequence: 1 })).reason).toBe('run-mismatch')
    expect(applyAnalysisEvent(accepted, acceptedEvent({ runRevision: 0, sequence: 1 })).reason).toBe('stale-revision')
    expect(applyAnalysisEvent(accepted, acceptedEvent({ eventId: 'event-duplicate' })).reason).toBe(
      'duplicate-or-out-of-order',
    )
  })

  it('records artifact-local failure without failing the whole run', () => {
    const accepted = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const failed = applyAnalysisEvent(accepted, {
      version: 1,
      type: 'artifact.failed',
      eventId: 'event-1',
      runId: 'run-1',
      runRevision: 1,
      sequence: 1,
      createdAt: 1791500000100,
      kind: 'summary',
      error,
    })

    expect(failed.state.artifactErrors.summary).toEqual(error)
    expect(failed.state.status).toBe('accepted')
  })

  it('marks only active runs as connection-lost', () => {
    const active = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const lost = markConnectionLost(active)
    const completed = applyAnalysisEvent(lost, {
      version: 1,
      type: 'run.completed',
      eventId: 'event-3',
      runId: 'run-1',
      runRevision: 2,
      sequence: 3,
      createdAt: 1791500000300,
      status: 'succeeded',
      coverage: {
        input: 1,
        analysis: 1,
        citation: 1,
        chunksCompleted: 2,
        chunksFailed: 0,
        chunksTotal: 2,
      },
    }).state

    expect(lost.status).toBe('connection-lost')
    expect(markConnectionLost(completed)).toBe(completed)
  })

  it('accepts a new revision only when its sequence moves forward', () => {
    const accepted = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const cancelled = applyAnalysisEvent(accepted, {
      version: 1,
      type: 'run.cancelled',
      eventId: 'event-1',
      runId: 'run-1',
      runRevision: 2,
      sequence: 1,
      createdAt: 1791500000100,
      effect: 'scheduling_stopped',
    })

    expect(cancelled.accepted).toBe(true)
    expect(cancelled.state.revision).toBe(2)
    expect(cancelled.state.status).toBe('cancelled')
  })

  it('mirrors stage, evidence, usage and a recovered artifact independently', () => {
    const accepted = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const stage = applyAnalysisEvent(accepted, {
      version: 1,
      type: 'stage.started',
      eventId: 'event-1',
      runId: 'run-1',
      runRevision: 1,
      sequence: 1,
      createdAt: 1791500000100,
      stage: 'summary',
    }).state
    const evidence = applyAnalysisEvent(stage, {
      version: 1,
      type: 'evidence.progress',
      eventId: 'event-2',
      runId: 'run-1',
      runRevision: 1,
      sequence: 2,
      createdAt: 1791500000200,
      coverage: {
        input: 1,
        analysis: 0.5,
        chunksCompleted: 1,
        chunksFailed: 0,
        chunksTotal: 2,
      },
      missingChunkIds: ['chunk-2'],
    }).state
    const usage = applyAnalysisEvent(evidence, {
      version: 1,
      type: 'usage.updated',
      eventId: 'event-3',
      runId: 'run-1',
      runRevision: 1,
      sequence: 3,
      createdAt: 1791500000300,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostMicros: 30,
        actualCostMicros: 25,
        currency: 'CNY',
      },
    }).state
    const failed = applyAnalysisEvent(usage, {
      version: 1,
      type: 'artifact.failed',
      eventId: 'event-4',
      runId: 'run-1',
      runRevision: 1,
      sequence: 4,
      createdAt: 1791500000400,
      kind: 'summary',
      error,
    }).state
    const artifact = summaryArtifactEnvelopeSchema.parse(summaryFixture)
    const recovered = applyAnalysisEvent(failed, {
      version: 1,
      type: 'artifact.ready',
      eventId: 'event-5',
      runId: 'run-1',
      runRevision: 1,
      sequence: 5,
      createdAt: 1791500000500,
      artifact,
    }).state

    expect(stage.status).toBe('generating')
    expect(evidence.coverage?.chunksCompleted).toBe(1)
    expect(usage.usage?.actualCostMicros).toBe(25)
    expect(recovered.artifacts.summary?.id).toBe('artifact-summary-1')
    expect(recovered.artifactErrors.summary).toBeUndefined()
  })

  it('records terminal run failure', () => {
    const accepted = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const failed = applyAnalysisEvent(accepted, {
      version: 1,
      type: 'run.failed',
      eventId: 'event-1',
      runId: 'run-1',
      runRevision: 1,
      sequence: 1,
      createdAt: 1791500000100,
      error,
    }).state

    expect(failed.status).toBe('failed')
    expect(failed.error).toEqual(error)
  })

  it('reconciles only a matching non-stale server snapshot', () => {
    const request = analysisRequestSchema.parse(requestFixture)
    const artifactState = { status: 'pending' as const, attempt: 0, updatedAt: 1791500000000 }
    const snapshot = analysisRunSchema.parse({
      version: 1,
      id: 'run-1',
      docId: request.docId,
      requestKey: request.requestKey,
      request,
      revision: 2,
      status: 'mapping',
      stage: 'mapping',
      progress: 0.3,
      coverage: {
        input: 1,
        analysis: 0.3,
        chunksCompleted: 1,
        chunksFailed: 0,
        chunksTotal: 3,
      },
      providerRoutes: [],
      artifactStates: {
        summary: artifactState,
        outline: artifactState,
        mindmap: artifactState,
        quiz: artifactState,
        knowledge: artifactState,
      },
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        estimatedCostMicros: 2,
        currency: 'CNY',
      },
      createdAt: 1791500000000,
      updatedAt: 1791500000100,
    })
    const current = applyAnalysisEvent(createRunMirror('run-1'), acceptedEvent()).state
    const reconciled = reconcileRunSnapshot(current, snapshot)

    expect(reconciled.revision).toBe(2)
    expect(reconciled.progress).toBe(0.3)
    expect(reconcileRunSnapshot(reconciled, { ...snapshot, id: 'run-other', revision: 3 })).toBe(reconciled)
    expect(reconcileRunSnapshot(reconciled, { ...snapshot, revision: 1 })).toBe(reconciled)
  })
})
