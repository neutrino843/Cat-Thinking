import { randomUUID } from 'node:crypto'
import { analysisEventSchema, analysisRunSchema, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import type { RunTransition } from './jobStore.js'

/** Content deletion preserves historical terminal results; active scheduling is cancelled. */
export function abandonmentTransition(current: AnalysisRunV1, sequence: number, now: number): RunTransition | undefined {
  if (['partial', 'succeeded', 'cancelled', 'failed', 'expired'].includes(current.status)) return undefined
  const run = analysisRunSchema.parse({ ...current, revision: current.revision + 1,
    status: 'cancelled', stage: undefined, updatedAt: now, completedAt: now,
    artifactStates: Object.fromEntries(Object.entries(current.artifactStates).map(([kind, state]) => [kind,
      state.status === 'pending' || state.status === 'running' ? { ...state, status: 'cancelled', updatedAt: now } : state])),
  })
  return { run, event: analysisEventSchema.parse({ version: 1, type: 'run.cancelled', eventId: randomUUID(),
    runId: current.id, runRevision: run.revision, sequence, createdAt: now, effect: 'scheduling_stopped' }) }
}
