import type { LearningBase } from './model'
import type { SourceLocator } from '../types'

export interface NodeSourceRef { snapshotId: string; start: number; end: number }
export interface NodeSourceSnapshot {
  id: string; originDocId: string; originSourceId: string; name: string
  provenanceDocId?: string; provenanceSourceId?: string
  role: 'slides' | 'textbook' | 'notes'; text: string; contentHash: string; locators: SourceLocator[]
  anchors?: { nodeId: string; start: number; end: number }[]
}
export interface NodeChapter { id: string; title: string }
export interface NodeBindingState { pointId: string; chapterId: string; refs: NodeSourceRef[]; originKey?: string }
export interface NodeRound {
  id: string; pointId: string; question: string; input: string; inputRevision: number
  refs: NodeSourceRef[]; status: 'active' | 'paused' | 'completed'; updatedAt: number
}
export interface NodeNoteRevision { id: string; pointId: string; text: string; createdAt: number; roundId?: string }
export interface NodeRoundEvent {
  id: string; roundId: string; inputRevision: number; type: 'hint-viewed' | 'source-viewed' | 'collected'
  createdAt: number; supportId?: string; level?: 1 | 2 | 3
}
export interface NodeSupport {
  id: string; roundId: string; inputRevision: number; question: string; learnerInput: string
  level: 1 | 2 | 3; docId: string; refs: NodeSourceRef[]; sourceIds: string[]
  createdAt: number; archiveId?: string; restored?: boolean
}
/** One CAS-protected course aggregate. Nested objects retain independent stable IDs. */
export interface NodeLearningState extends LearningBase {
  kind: 'node-workspace'; chapters: NodeChapter[]; sources: NodeSourceSnapshot[]
  bindings: NodeBindingState[]; rounds: NodeRound[]; notes: NodeNoteRevision[]
  events: NodeRoundEvent[]; supports: NodeSupport[]; lastPointId?: string
  lastRoundId?: string
}
