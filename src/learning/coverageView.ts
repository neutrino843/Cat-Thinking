import type { ApplicationTask, AssessmentEvent, KnowledgePoint, LearningArchive, PracticeAttempt, QuestionIssue, ReviewSchedule } from './model'
import { questionRefKey, resolveKnowledgePointId } from './knowledgeGraph'
import { parseLearningDate } from './reviewScheduler'
import type { KnowledgeMergeEvent } from './model'

export type SourceLearningStatus = 'valid' | 'changed' | 'pending' | 'missing'
export type PracticeCoverageStatus = 'no-questions' | 'recall-only' | 'has-explanation' | 'has-application'
export type LearningObservation = 'unpracticed' | 'needs-remediation' | 'awaiting-review' | 'delayed-success' | 'assessment-pending' | 'self-assessed' | 'practice-recorded' | 'paused'
export interface CoverageInput {
  points: readonly KnowledgePoint[]
  archives: readonly LearningArchive[]
  attempts: readonly PracticeAttempt[]
  assessments: readonly AssessmentEvent[]
  schedules: readonly ReviewSchedule[]
  applicationTasks?: readonly ApplicationTask[]
  issues?: readonly QuestionIssue[]
  sourceStatuses?: Readonly<Record<string, SourceLearningStatus>>
  delayedSuccessDays?: number
  merges?: readonly KnowledgeMergeEvent[]
}
export interface LearningEvidence {
  attemptId: string
  questionKey: string
  learningDate: string | null
  questionType: 'objective' | 'short-answer'
  level: 'recall' | 'explanation' | 'application'
  outcome: 'success' | 'partial' | 'failure' | 'unanswered' | 'disputed' | 'skipped' | 'assessment-pending'
  answerRevealed: boolean
  importedHistory: boolean
}
export interface KnowledgeCoverage {
  pointId: string
  title: string
  sourceStatus: SourceLearningStatus
  coverageStatus: PracticeCoverageStatus
  observation: LearningObservation
  confirmedQuestionCount: number
  availableQuestionCount: number
  disputedQuestionCount: number
  recallQuestionCount: number
  explanationQuestionCount: number
  applicationTaskCount: number
  completedApplicationSelfAssessments: number
  practiced: boolean
  delayedSuccessTargetCount: number
  needsApplicationVerification: boolean
  nextReviewDate?: string
  evidence: LearningEvidence[]
  reasons: string[]
}

function sourceStatus(point: KnowledgePoint, input: CoverageInput): SourceLearningStatus {
  const supplied = input.sourceStatuses?.[point.id]
  if (supplied) return supplied
  if (point.status === 'pending') return 'pending'
  if (!point.sourceRefs.length) return 'missing'
  for (const ref of point.sourceRefs) {
    const archive = input.archives.find((item) => item.id === ref.archiveId && item.courseId === point.courseId)
    const source = archive?.sources.find((item) => item.id === ref.sourceId)
    if (!source || ref.start < 0 || ref.end <= ref.start || ref.end > source.text.length) return 'missing'
  }
  return 'valid'
}

const latestAssessment = (attemptId: string, assessments: readonly AssessmentEvent[]) => assessments
  .filter((assessment) => assessment.attemptId === attemptId)
  .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0) || right.updatedAt - left.updatedAt || right.revision - left.revision || right.id.localeCompare(left.id))[0]

export function buildKnowledgeCoverage(input: CoverageInput): KnowledgeCoverage[] {
  const threshold = input.delayedSuccessDays ?? 2
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error('延迟成功须至少来自两个不同学习日。')
  return input.points.filter((point) => point.status !== 'retired').map((point) => {
    const refs = [...new Map(point.questionRefs.filter((question) => question.confirmed).map((question) => [questionRefKey(question), question])).values()]
    const reasons: string[] = []
    const materialStatus = sourceStatus(point, input)
    if (materialStatus !== 'valid') reasons.push('来源缺失、变化或待确认；学习状态与资料异常分别显示。')
    const disputedKeys = new Set((input.issues ?? []).filter((issue) => issue.courseId === point.courseId && issue.status === 'open')
      .map((issue) => questionRefKey(issue.question)))
    const available = refs.flatMap((ref) => {
      if (materialStatus !== 'valid' || disputedKeys.has(questionRefKey(ref))) return []
      const archive = input.archives.find((item) => item.id === ref.archiveId && item.courseId === point.courseId)
      const artifact = archive?.artifacts.find((item) => item.id === ref.artifactId)
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((item) => item.id === ref.questionId) : undefined
      return question ? [{ ref, question, key: questionRefKey(ref) }] : []
    })
    const evidence: LearningEvidence[] = []
    for (const { question, key } of available) {
      for (const attempt of input.attempts.filter((item) => item.courseId === point.courseId && questionRefKey(item.question) === key)) {
        const assessment = latestAssessment(attempt.id, input.assessments)
        let outcome: LearningEvidence['outcome']
        const answered = question.type === 'short-answer' ? typeof attempt.answer === 'string' && !!attempt.answer.trim() :
          question.type === 'multiple-choice' ? typeof attempt.answer === 'number' && Number.isInteger(attempt.answer) && attempt.answer >= 0 && attempt.answer < question.options.length :
            typeof attempt.answer === 'boolean'
        if (assessment?.outcome === 'disputed' || assessment?.outcome === 'skipped') outcome = assessment.outcome
        else if (!answered) outcome = 'unanswered'
        else if (question.type === 'short-answer') {
          if (!assessment?.selfAssessmentComplete) outcome = 'assessment-pending'
          else if (assessment.outcome === 'success' && assessment.rubricChecks?.some((checked) => !checked)) outcome = 'partial'
          else outcome = assessment.outcome
        } else {
          const correct = question.type === 'multiple-choice' ? attempt.answer === question.answerIndex : attempt.answer === question.answer
          outcome = correct ? 'success' : 'failure'
        }
        let date: string | null = null
        if (attempt.origin !== 'legacy' && attempt.submittedAt !== null) {
          try { parseLearningDate(attempt.learningDate); date = attempt.learningDate } catch { reasons.push('一条记录日期无效，未计入延迟成功。') }
        }
        evidence.push({ attemptId: attempt.id, questionKey: key, learningDate: date,
          questionType: question.type === 'short-answer' ? 'short-answer' : 'objective', level: point.questionLevels?.[key] ?? 'recall', outcome,
          answerRevealed: attempt.answerRevealed, importedHistory: attempt.origin === 'legacy' || attempt.submittedAt === null })
      }
    }
    evidence.sort((left, right) => (input.attempts.find((attempt) => attempt.id === right.attemptId)?.submittedAt ?? -1) -
      (input.attempts.find((attempt) => attempt.id === left.attemptId)?.submittedAt ?? -1) || right.attemptId.localeCompare(left.attemptId))
    const successfulDays = new Map<string, Set<string>>()
    const seenTargetDays = new Set<string>()
    for (const item of [...evidence].reverse()) {
      if (!item.learningDate || item.importedHistory || item.outcome === 'skipped') continue
      const targetDate = JSON.stringify([item.questionKey, item.learningDate])
      if (seenTargetDays.has(targetDate)) continue
      seenTargetDays.add(targetDate)
      if (item.level === 'application' || item.outcome !== 'success' || item.answerRevealed || !item.learningDate || item.importedHistory) continue
      const days = successfulDays.get(item.questionKey) ?? new Set<string>()
      days.add(item.learningDate)
      successfulDays.set(item.questionKey, days)
    }
    const delayedSuccessTargetCount = [...successfulDays.values()].filter((days) => days.size >= threshold).length
    const schedules = input.schedules.filter((schedule) => schedule.courseId === point.courseId && available.some((item) => item.key === questionRefKey(schedule.question)))
    const latest = evidence.find((item) => item.level !== 'application')
    const practiced = evidence.some((item) => !['unanswered', 'skipped', 'disputed'].includes(item.outcome))
    let observation: LearningObservation = 'unpracticed'
    if (schedules.length && schedules.every((schedule) => schedule.status === 'paused')) observation = 'paused'
    else if (latest?.outcome === 'failure' || latest?.outcome === 'partial' || schedules.some((schedule) => schedule.status === 'remediation')) observation = 'needs-remediation'
    else if (delayedSuccessTargetCount > 0) observation = 'delayed-success'
    else if (latest?.outcome === 'assessment-pending') observation = 'assessment-pending'
    else if (schedules.some((schedule) => schedule.status === 'active')) observation = 'awaiting-review'
    else if (latest?.questionType === 'short-answer' && latest.outcome === 'success') observation = 'self-assessed'
    else if (practiced) observation = 'practice-recorded'
    const level = (key: string) => point.questionLevels?.[key] ?? 'recall'
    const recallQuestionCount = available.filter((item) => level(item.key) === 'recall').length
    const explanationQuestionCount = available.filter((item) => level(item.key) === 'explanation').length
    const applicationQuestions = available.filter((item) => level(item.key) === 'application').length
    const tasks = (input.applicationTasks ?? []).filter((task) => task.courseId === point.courseId && task.pointIds.some((pointId) => resolveKnowledgePointId(pointId, input.merges) === point.id))
    const applicationTaskCount = tasks.length + applicationQuestions
    const completedApplicationSelfAssessments = tasks.filter((task) => task.status === 'completed' && !!task.response.trim() &&
      task.rubric.length > 0 && task.checks.length === task.rubric.length && task.checks.every(Boolean)).length
    const coverageStatus: PracticeCoverageStatus = applicationTaskCount ? 'has-application' : explanationQuestionCount ? 'has-explanation' :
      available.length ? 'recall-only' : 'no-questions'
    if (!available.length) reasons.push('当前没有可用且归属已确认的题目；共享引用或同名题目不计覆盖。')
    if (delayedSuccessTargetCount) reasons.push('关联练习在不同学习日出现有效成功；这不代表每个知识点都通过独立验证。')
    if (completedApplicationSelfAssessments) reasons.push('应用任务完成的是用户自评，不自动认定迁移能力达标。')
    if (refs.some((ref) => input.points.filter((other) => other.status !== 'retired' && other.questionRefs.some((otherRef) => otherRef.confirmed && questionRefKey(otherRef) === questionRefKey(ref))).length > 1)) {
      reasons.push('含多知识点共享题目，回答结果不等于各知识点分别通过验证。')
    }
    const disputedQuestionCount = refs.filter((ref) => disputedKeys.has(questionRefKey(ref))).length
    if (disputedQuestionCount) reasons.push(`${disputedQuestionCount} 道题有待解决的质量疑问，暂不用于有效覆盖和调度。`)
    const nextReviewDate = schedules.filter((schedule) => schedule.status === 'active').map((schedule) => schedule.dueDate).sort()[0]
    return { pointId: point.id, title: point.title, sourceStatus: materialStatus, coverageStatus, observation,
      confirmedQuestionCount: refs.length, availableQuestionCount: available.length, disputedQuestionCount,
      recallQuestionCount, explanationQuestionCount, applicationTaskCount, completedApplicationSelfAssessments, practiced,
      delayedSuccessTargetCount, needsApplicationVerification: completedApplicationSelfAssessments === 0, nextReviewDate, evidence, reasons }
  })
}

export function summarizeLearningCoverage(points: readonly KnowledgePoint[], coverage: readonly KnowledgeCoverage[], goalVersion: number) {
  const goalPoints = points.filter((point) => point.status === 'active' && point.goalIncluded === true)
  const goals = new Set(goalPoints.map((point) => point.id))
  const included = coverage.filter((item) => goals.has(item.pointId))
  return { goalVersion, confirmedGoalCount: goalPoints.length, practicedGoalCount: included.filter((item) => item.practiced).length,
    questionsCoveredGoalCount: included.filter((item) => item.availableQuestionCount > 0).length,
    missingApplicationVerificationCount: included.filter((item) => item.needsApplicationVerification).length,
    sourceIssueCount: included.filter((item) => item.sourceStatus !== 'valid').length,
    denominatorReason: '分母只使用当前目标版本中用户确认纳入的有效知识点。' }
}
