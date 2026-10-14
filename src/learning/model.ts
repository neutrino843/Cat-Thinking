import type { ArtifactEnvelopeV1, SourceManifestV1 } from '@cat-thinking/analysis-contracts'
import type { DocMeta, SourceDocument } from '../types'

/** Versioned local learning records. No provider secrets or resumable network tasks belong here. */
export interface LearningBase { version: 1; id: string; courseId: string; revision: number; createdAt: number; updatedAt: number }
export interface Course extends LearningBase { kind: 'course'; name: string; goal: string; timeZone: string; dailyMinutes: number; dailyQuestionLimit: number; examDate?: string; goalVersion: number; automaticReviews?: boolean }
export interface CourseDocument extends LearningBase { kind: 'document'; docId: string; chapter: string }
export interface ArchivedSourceRef { archiveId: string; sourceId: string; start: number; end: number }
export interface QuestionRef { archiveId: string; artifactId: string; questionId: string; confirmed: boolean }
export type QuestionLevel = 'recall' | 'explanation' | 'application'
export interface KnowledgePoint extends LearningBase {
  kind: 'point'; title: string; definition: string; chapter: string; parentId?: string; aliases: string[]; notes: string
  sourceRefs: ArchivedSourceRef[]; questionRefs: QuestionRef[]; status: 'active' | 'pending' | 'retired'; docId?: string; nodeId?: string
  questionLevels?: Record<string, QuestionLevel>; goalIncluded?: boolean
  archiveId?: string; generatedNodeId?: string
}
export interface LearningArchive extends LearningBase {
  kind: 'archive'; originDocId: string; provenanceDocId: string; runId: string; title: string
  manifest: SourceManifestV1; sources: SourceDocument[]; artifacts: ArtifactEnvelopeV1[]; contentHash: string
}
export interface PracticeAttempt extends LearningBase {
  kind: 'attempt'; question: QuestionRef; answer: string | number | boolean | string[]; submittedAt: number | null
  learningDate: string; answerRevealed: boolean; origin: 'practice' | 'legacy'; confidence?: number; sessionId?: string
}
export interface PracticeDraft extends LearningBase { kind: 'draft'; question: QuestionRef; answer: string | number | boolean; answerRevealed: boolean; attemptId: string }
export interface AssessmentEvent extends LearningBase {
  kind: 'assessment'; attemptId: string; outcome: 'success' | 'partial' | 'failure' | 'disputed' | 'skipped'
  difficulty: 'again' | 'hard' | 'good' | 'easy'; selfAssessmentComplete: boolean; reason?: string; rubricChecks?: boolean[]; sequence?: number
}
export interface ReviewSchedule extends LearningBase {
  kind: 'schedule'; question: QuestionRef; status: 'active' | 'paused' | 'remediation'; dueDate: string; stage: number
  lastLearningDate?: string; lastAttemptId?: string; manual: boolean; ruleVersion: string; successfulLearningDates?: string[]; suspendedReason?: string
}
export type KnowledgeRelationType = 'prerequisite' | 'part' | 'step' | 'comparison' | 'cause' | 'application'
export interface KnowledgeRelation extends LearningBase { kind: 'relation'; fromPointId: string; toPointId: string; type: KnowledgeRelationType; confirmed: boolean; sourceRefs?: ArchivedSourceRef[] }
export interface KnowledgeMergeEvent extends LearningBase {
  kind: 'merge'; fromPointId: string; toPointId: string; action: 'merge' | 'undo'; undoOf?: string
  beforePoints?: KnowledgePoint[]; beforeRelations?: KnowledgeRelation[]; afterPointRevisions?: Record<string, number>
  afterRelationRevisions?: Record<string, number>
  undoDisabledReason?: string
}
export interface LearningSession extends LearningBase { kind: 'session'; title: string; pointIds: string[]; status: 'active' | 'completed' | 'ended'; steps: { pointId: string; action: 'read' | 'recall' | 'practice' | 'source' | 'explain'; status: 'pending' | 'completed' | 'skipped'; note: string }[]; endedAt?: number; purpose?: 'guided' | 'exam'; questions?: QuestionRef[] }
export interface ApplicationTask extends LearningBase { kind: 'application'; pointIds: string[]; title: string; prompt: string; response: string; rubric: string[]; checks: boolean[]; status: 'pending' | 'completed' | 'skipped'; learningDate?: string }
export interface QuestionIssue extends LearningBase { kind: 'issue'; question: QuestionRef; reason: 'answer' | 'ambiguous' | 'outside-source'; note: string; status: 'open' | 'resolved' }
export interface NodeBinding extends LearningBase { kind: 'binding'; docId: string; archiveId: string; artifactId: string; mappings: { generatedNodeId: string; localNodeId: string; pointId: string; originalText: string; originalNote?: string }[]; status: 'active' | 'pending' | 'retired' }
export type LearningEntity = Course | CourseDocument | KnowledgePoint | LearningArchive | PracticeAttempt | PracticeDraft | AssessmentEvent | ReviewSchedule | KnowledgeRelation | KnowledgeMergeEvent | LearningSession | ApplicationTask | QuestionIssue | NodeBinding
export type LearningKind = LearningEntity['kind']
export type EntityOf<K extends LearningKind> = Extract<LearningEntity, { kind: K }>
export interface CourseSnapshot {
  course: Course; documents: CourseDocument[]; docs: DocMeta[]; points: KnowledgePoint[]; archives: LearningArchive[]
  attempts: PracticeAttempt[]; assessments: AssessmentEvent[]; schedules: ReviewSchedule[]; relations: KnowledgeRelation[]
  drafts: PracticeDraft[]
  merges: KnowledgeMergeEvent[]; sessions: LearningSession[]; applicationTasks: ApplicationTask[]; issues: QuestionIssue[]; bindings: NodeBinding[]
}
export const newLearningId = (): string => crypto.randomUUID()
export function learningBase(courseId: string, id = newLearningId(), now = Date.now()): LearningBase {
  return { version: 1, id, courseId, revision: 1, createdAt: now, updatedAt: now }
}
export class LearningError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'missing' | 'corrupt' | 'limit' | 'password', message: string) { super(message); this.name = 'LearningError' }
}
