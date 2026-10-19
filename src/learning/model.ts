import type { ArtifactEnvelopeV1, SourceManifestV1 } from '@cat-thinking/analysis-contracts'
import type { DocMeta, SourceDocument } from '../types'
import type { NodeLearningState } from './nodeTypes'

/** Versioned local learning records. No provider secrets or resumable network tasks belong here. */
export interface LearningBase { originId?: string; version: 1; id: string; courseId: string; revision: number; createdAt: number; updatedAt: number }
export interface CourseGoal { id: string; title: string; level: QuestionLevel; priority: 'normal' | 'important' | 'required'; pointIds: string[]; confirmed: boolean }
export interface Course extends LearningBase { kind: 'course'; firstStudyAt?: number; name: string; goal: string; timeZone: string; dailyMinutes: number; dailyQuestionLimit: number; examDate?: string; goalVersion: number; automaticReviews?: boolean; goals?: CourseGoal[]; example?: boolean; learningMode?: 'nodes' | 'legacy' }
export interface CourseDocument extends LearningBase { kind: 'document'; docId: string; chapter: string; role?: 'syllabus' | 'slides' | 'textbook' | 'notes' }
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
export interface PracticeAssistance { hints: number; fullExplanation: boolean; sourceViewed: boolean; recorded: boolean }
export interface PracticeAttempt extends LearningBase {
  kind: 'attempt'; question: QuestionRef; answer: string | number | boolean | string[]; submittedAt: number | null
  learningDate: string; answerRevealed: boolean; origin: 'practice' | 'legacy'; confidence?: number; sessionId?: string
  assistance?: PracticeAssistance
  recallText?: string
}
export interface PracticeDraft extends LearningBase { kind: 'draft'; question: QuestionRef; answer: string | number | boolean | null; answerRevealed: boolean; attemptId: string; assistance?: PracticeAssistance; recallText?: string }
export interface AssessmentEvent extends LearningBase {
  kind: 'assessment'; attemptId: string; outcome: 'success' | 'partial' | 'failure' | 'disputed' | 'skipped'
  difficulty: 'again' | 'hard' | 'good' | 'easy'; selfAssessmentComplete: boolean; reason?: string; rubricChecks?: boolean[]; sequence?: number
  feedbackArchiveId?: string; origin?: 'self' | 'ai-review'
}
export interface ReviewSchedule extends LearningBase {
  kind: 'schedule'; question: QuestionRef; status: 'active' | 'paused' | 'remediation'; dueDate: string; stage: number
  lastLearningDate?: string; lastAttemptId?: string; manual: boolean; ruleVersion: string; successfulLearningDates?: string[]; suspendedReason?: string
}
export type KnowledgeRelationType = 'prerequisite' | 'part' | 'step' | 'comparison' | 'cause' | 'application'
export interface KnowledgeRelation extends LearningBase { kind: 'relation'; fromPointId: string; toPointId: string; type: KnowledgeRelationType; confirmed: boolean; sourceRefs?: ArchivedSourceRef[]; reason?: string }
export interface KnowledgeMergeEvent extends LearningBase {
  kind: 'merge'; fromPointId: string; toPointId: string; action: 'merge' | 'undo'; undoOf?: string
  beforePoints?: KnowledgePoint[]; beforeRelations?: KnowledgeRelation[]; afterPointRevisions?: Record<string, number>
  afterRelationRevisions?: Record<string, number>
  undoDisabledReason?: string
}
export interface SessionCheckpoint { stepIndex: number; paused: boolean; hidden: boolean; goalVersion: number; pointRevisions: Record<string, number>; archiveHashes: Record<string, string>; questionKey?: string; position?: number; endedReason?: 'completed' | 'user' }
export interface LearningSession extends LearningBase { kind: 'session'; title: string; pointIds: string[]; status: 'active' | 'completed' | 'ended'; steps: { pointId: string; action: 'read' | 'recall' | 'practice' | 'source' | 'explain'; status: 'pending' | 'completed' | 'skipped'; note: string }[]; endedAt?: number; purpose?: 'guided' | 'exam'; questions?: QuestionRef[]; checkpoint?: SessionCheckpoint; examConfig?: { durationMinutes: number; mode: 'simulation' | 'guided' }; planning?: { date: string; minutes: number } }
export interface ApplicationTask extends LearningBase { kind: 'application'; pointIds: string[]; title: string; prompt: string; response: string; rubric: string[]; checks: boolean[]; status: 'pending' | 'completed' | 'skipped'; learningDate?: string }
export interface QuestionIssue extends LearningBase { kind: 'issue'; question: QuestionRef; reason: 'answer' | 'ambiguous' | 'outside-source'; note: string; status: 'open' | 'resolved' }
export interface NodeBinding extends LearningBase { kind: 'binding'; docId: string; archiveId: string; artifactId: string; mappings: { generatedNodeId: string; localNodeId: string; pointId: string; originalText: string; originalNote?: string }[]; status: 'active' | 'pending' | 'retired' }
export type SupportMode = 'explain' | 'compare' | 'hint' | 'feedback' | 'goals' | 'variation' | 'supplement'
export interface LearningSupport extends LearningBase { kind: 'support'; mode: SupportMode; docId: string; pointIds: string[]; sourceRefs: ArchivedSourceRef[]; prompt: string; learnerAnswer?: string; hintLevel?: number; quizType?: 'mixed' | 'multiple-choice' | 'true-false' | 'short-answer'; difficulty?: 'easy' | 'medium' | 'hard'; status: 'prepared' | 'viewed' | 'accepted' | 'rejected'; generatedArchiveId?: string; questionRef?: QuestionRef; attemptId?: string; sessionId?: string; viewedAt?: number }
/** Reading and remediation checkpoints are not quiz submissions or mastery evidence. */
export interface LearningJourney extends LearningBase {
  kind: 'journey'; mode: 'reading' | 'remediation'; title: string; status: 'active' | 'paused' | 'completed'
  step: number; note: string; position: number; scroll: number; dueDate?: string; finishedAt?: number
  source?: { docId: string; sourceId: string; sourceHash: string }
  questionRef?: QuestionRef; archiveHash?: string; attemptId?: string; retryAttemptId?: string
  parentSessionId?: string; originSessionId?: string; blockedReason?: string
  planning?: { date: string; minutes: number }
}
export type LearningEntity = Course | CourseDocument | KnowledgePoint | LearningArchive | PracticeAttempt | PracticeDraft | AssessmentEvent | ReviewSchedule | KnowledgeRelation | KnowledgeMergeEvent | LearningSession | ApplicationTask | QuestionIssue | NodeBinding | LearningSupport | LearningJourney | NodeLearningState
export type LearningKind = LearningEntity['kind']
export type EntityOf<K extends LearningKind> = Extract<LearningEntity, { kind: K }>
export interface CourseSnapshot {
  course: Course; documents: CourseDocument[]; docs: DocMeta[]; points: KnowledgePoint[]; archives: LearningArchive[]
  attempts: PracticeAttempt[]; assessments: AssessmentEvent[]; schedules: ReviewSchedule[]; relations: KnowledgeRelation[]
  drafts: PracticeDraft[]
  merges: KnowledgeMergeEvent[]; sessions: LearningSession[]; applicationTasks: ApplicationTask[]; issues: QuestionIssue[]; bindings: NodeBinding[]
  supports?: LearningSupport[]
  journeys?: LearningJourney[]
  nodeWorkspace?: NodeLearningState
}
export const newLearningId = (): string => crypto.randomUUID()
export function learningBase(courseId: string, id = newLearningId(), now = Date.now()): LearningBase {
  return { version: 1, id, originId: id, courseId, revision: 1, createdAt: now, updatedAt: now }
}
export class LearningError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'missing' | 'corrupt' | 'limit' | 'password', message: string) { super(message); this.name = 'LearningError' }
}
