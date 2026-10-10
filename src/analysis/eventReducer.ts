import {
  type AnalysisErrorV1,
  type AnalysisEventV1,
  type AnalysisRunV1,
  type ArtifactEnvelopeV1,
  type ArtifactKind,
  type CoverageV1,
  type UsageV1,
} from '@cat-thinking/analysis-contracts'

export type MirrorRunStatus =
  | AnalysisRunV1['status']
  | 'connecting'
  | 'connection-lost'
  | 'interrupted'

export interface AnalysisRunMirror {
  runId: string
  requestKey?: string
  revision: number
  lastSequence: number
  lastEventId?: string
  connection: 'connecting' | 'connected' | 'lost'
  status: MirrorRunStatus
  stage?: AnalysisRunV1['stage']
  progress: number
  coverage?: CoverageV1
  usage?: UsageV1
  artifacts: Partial<Record<ArtifactKind, ArtifactEnvelopeV1>>
  artifactErrors: Partial<Record<ArtifactKind, AnalysisErrorV1>>
  error?: AnalysisErrorV1
}

export interface EventReduction {
  state: AnalysisRunMirror
  accepted: boolean
  reason?: 'run-mismatch' | 'stale-revision' | 'duplicate-or-out-of-order'
}

export const createRunMirror = (runId: string): AnalysisRunMirror => ({
  runId,
  revision: 0,
  lastSequence: -1,
  connection: 'connecting',
  status: 'connecting',
  progress: 0,
  artifacts: {},
  artifactErrors: {},
})

const statusForStage = (stage: AnalysisRunV1['stage']): AnalysisRunV1['status'] => {
  if (stage === 'receiving' || stage === 'planning' || stage === 'mapping' || stage === 'merging' || stage === 'validating') {
    return stage
  }
  return 'generating'
}

export const applyAnalysisEvent = (
  current: AnalysisRunMirror,
  event: AnalysisEventV1,
): EventReduction => {
  if (event.runId !== current.runId) {
    return { state: current, accepted: false, reason: 'run-mismatch' }
  }
  if (event.runRevision < current.revision) {
    return { state: current, accepted: false, reason: 'stale-revision' }
  }
  if (event.sequence <= current.lastSequence) {
    return { state: current, accepted: false, reason: 'duplicate-or-out-of-order' }
  }

  const next: AnalysisRunMirror = {
    ...current,
    revision: event.runRevision,
    lastSequence: event.sequence,
    lastEventId: event.eventId,
    connection: 'connected',
    artifacts: { ...current.artifacts },
    artifactErrors: { ...current.artifactErrors },
  }

  switch (event.type) {
    case 'run.accepted':
      next.requestKey = event.requestKey
      next.status = 'accepted'
      break
    case 'stage.started':
      next.stage = event.stage
      next.status = statusForStage(event.stage)
      break
    case 'progress.updated':
      next.stage = event.stage
      next.status = statusForStage(event.stage)
      next.progress = Math.max(next.progress, event.progress)
      break
    case 'evidence.progress':
      next.coverage = event.coverage
      break
    case 'evidence.ready':
      next.status = 'generating'
      next.stage = undefined
      next.coverage = event.coverage
      break
    case 'usage.updated':
      next.usage = event.usage
      break
    case 'artifact.ready':
      next.artifacts[event.artifact.kind] = event.artifact
      delete next.artifactErrors[event.artifact.kind]
      break
    case 'artifact.failed':
      next.artifactErrors[event.kind] = event.error
      break
    case 'run.completed':
      next.status = event.status
      next.progress = 1
      next.coverage = event.coverage
      break
    case 'run.cancelled':
      next.status = 'cancelled'
      break
    case 'run.failed':
      next.status = 'failed'
      next.error = event.error
      break
    case 'run.expired':
      next.status = 'expired'
      break
  }

  return { state: next, accepted: true }
}

const terminalStatuses = new Set<MirrorRunStatus>(['partial', 'succeeded', 'cancelled', 'failed', 'expired'])

export const markConnectionLost = (current: AnalysisRunMirror): AnalysisRunMirror => {
  if (terminalStatuses.has(current.status)) return current
  return { ...current, connection: 'lost', status: 'connection-lost' }
}

export const reconcileRunSnapshot = (
  current: AnalysisRunMirror,
  snapshot: AnalysisRunV1,
): AnalysisRunMirror => {
  if (snapshot.id !== current.runId || snapshot.revision < current.revision) return current
  return {
    ...current,
    requestKey: snapshot.requestKey,
    revision: snapshot.revision,
    connection: 'connected',
    status: snapshot.status,
    stage: snapshot.stage,
    progress: snapshot.progress,
    coverage: snapshot.coverage,
    usage: snapshot.usage,
    error: snapshot.error,
  }
}
