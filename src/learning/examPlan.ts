import type { KnowledgePoint, LearningArchive, QuestionIssue, QuestionLevel, QuestionRef } from './model'
import { buildDailyPlan, type DailyPlan, type DailyPlanCandidate } from './dailyPlan'
import { addLearningDays, LearningRuleError, parseLearningDate } from './reviewScheduler'
import { questionRefKey } from './knowledgeGraph'

export interface ExamPlanOptions {
  startDate: string
  examDate: string
  scopePointIds: readonly string[]
  priorityPointIds?: readonly string[]
  timeBudgetMinutes: number
  questionLimit: number
  includeExamDate?: boolean
}
export interface ExamPlan {
  days: DailyPlan[]
  remaining: DailyPlanCandidate[]
  outsideScope: DailyPlanCandidate[]
  pausedOrUnavailable: DailyPlanCandidate[]
  scopePointIds: string[]
  noTaskPointIds: string[]
  unplannedCount: number
  reasons: string[]
}

/** Plans only the explicit scope and existing tasks; no additional questions are generated. */
export function buildExamPlan(points: readonly KnowledgePoint[], candidates: readonly DailyPlanCandidate[], options: ExamPlanOptions): ExamPlan {
  const start = parseLearningDate(options.startDate)
  const exam = parseLearningDate(options.examDate)
  if (exam < start) throw new LearningRuleError('invalid_date', '考试日期早于计划开始日期。')
  const dayCount = Math.floor((exam - start) / 86_400_000) + (options.includeExamDate ? 1 : 0)
  if (dayCount > 366) throw new LearningRuleError('invalid_date', '考前计划最多预览 366 天，请缩短计划范围。')
  const scope = [...new Set(options.scopePointIds)]
  if (scope.some((pointId) => !points.some((point) => point.id === pointId && point.status === 'active'))) {
    throw new Error('考试范围包含不存在或已停用的知识点。')
  }
  const priority = new Set(options.priorityPointIds ?? [])
  const outsideScope = candidates.filter((candidate) => !candidate.pointId || !scope.includes(candidate.pointId))
  const inScope = candidates.filter((candidate) => candidate.pointId && scope.includes(candidate.pointId))
    .map((candidate) => ({ ...candidate, order: (candidate.order ?? 0) - (priority.has(candidate.pointId ?? '') ? 100_000 : 0) }))
  const pausedOrUnavailable = inScope.filter((candidate) => candidate.paused || (candidate.sourceStatus && candidate.sourceStatus !== 'valid'))
  let remaining = inScope.filter((candidate) => !pausedOrUnavailable.some((item) => item.id === candidate.id))
  const days: DailyPlan[] = []
  // Validate capacities and task identities even when the exam is today (zero available days).
  buildDailyPlan(inScope, { learningDate: options.startDate, timeBudgetMinutes: options.timeBudgetMinutes, questionLimit: options.questionLimit })
  for (let day = 0; day < dayCount; day += 1) {
    const plan = buildDailyPlan(remaining, { learningDate: addLearningDays(options.startDate, day),
      timeBudgetMinutes: options.timeBudgetMinutes, questionLimit: options.questionLimit })
    days.push(plan)
    const selected = new Set(plan.selected.map((task) => task.id))
    remaining = remaining.filter((task) => !selected.has(task.id))
  }
  const noTaskPointIds = scope.filter((pointId) => !inScope.some((candidate) => candidate.pointId === pointId && !candidate.paused && (!candidate.sourceStatus || candidate.sourceStatus === 'valid')))
  const reasons = ['考试范围来自用户选择；每天按时间和题数上限安排，考试日默认不计学习时间。']
  if (!dayCount) reasons.push('考试前没有可用学习日，尚未安排任何任务。')
  if (remaining.length) reasons.push(`按当前容量仍有 ${remaining.length} 项未排入；可增加时间、减少新学习或缩小目标。`)
  if (noTaskPointIds.length) reasons.push(`${noTaskPointIds.length} 个范围内知识点没有可用任务，未用重复题目或新生成内容补足。`)
  if (pausedOrUnavailable.length) reasons.push(`${pausedOrUnavailable.length} 项暂停或来源异常，未纳入计划。`)
  return { days, remaining, outsideScope, pausedOrUnavailable, scopePointIds: scope, noTaskPointIds,
    unplannedCount: remaining.length + pausedOrUnavailable.length, reasons }
}

export interface ExamQuestionCandidate {
  question: QuestionRef
  title?: string
  pointIds: string[]
  level: QuestionLevel
  type: 'multiple-choice' | 'true-false' | 'short-answer'
  available: boolean
  /** Equal content is not an independent new question even when archive identities differ. */
  contentFingerprint?: string
}
export interface ExamQuestionSelection {
  selected: ExamQuestionCandidate[]
  requestedCount: number
  availableCount: number
  missingCount: number
  coveredPointIds: string[]
  uncoveredPointIds: string[]
  typeCounts: Record<ExamQuestionCandidate['type'], number>
  levelCounts: Record<QuestionLevel, number>
  reasons: string[]
  generatedQuestionCount: 0
}

export function examQuestionInventory(points: readonly KnowledgePoint[], archives: readonly LearningArchive[], issues: readonly QuestionIssue[] = []): ExamQuestionCandidate[] {
  const openIssues = new Set(issues.filter((issue) => issue.status === 'open').map((issue) => questionRefKey(issue.question)))
  const inventory = new Map<string, ExamQuestionCandidate>()
  for (const point of points.filter((item) => item.status === 'active')) {
    for (const ref of point.questionRefs.filter((item) => item.confirmed)) {
      const key = questionRefKey(ref)
      const existing = inventory.get(key)
      if (existing) { if (!existing.pointIds.includes(point.id)) existing.pointIds.push(point.id); continue }
      const archive = archives.find((item) => item.id === ref.archiveId && item.courseId === point.courseId)
      const artifact = archive?.artifacts.find((item) => item.id === ref.artifactId && item.kind === 'quiz')
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((item) => item.id === ref.questionId) : undefined
      if (!question) continue
      inventory.set(key, { question: { ...ref }, title: question.prompt, pointIds: [point.id], level: point.questionLevels?.[key] ?? 'recall', type: question.type,
        available: !openIssues.has(key), contentFingerprint: JSON.stringify([question.type, question.prompt,
          question.type === 'multiple-choice' ? question.options : null,
          question.type === 'multiple-choice' ? question.answerIndex : question.answer]) })
    }
  }
  return [...inventory.values()]
}

export function assembleExamQuestions(candidates: readonly ExamQuestionCandidate[], options: { scopePointIds: readonly string[]; count: number }): ExamQuestionSelection {
  if (!Number.isInteger(options.count) || options.count < 0 || options.count > 1000) throw new Error('模拟题数须为 0 到 1000 的整数。')
  const scope = [...new Set(options.scopePointIds)]
  const seenIdentities = new Set<string>()
  const seenContent = new Set<string>()
  const eligible: ExamQuestionCandidate[] = []
  for (const candidate of [...candidates].sort((left, right) => questionRefKey(left.question).localeCompare(questionRefKey(right.question)))) {
    const key = questionRefKey(candidate.question)
    if (!candidate.question.confirmed || !candidate.available || !candidate.pointIds.some((id) => scope.includes(id)) ||
      seenIdentities.has(key) || candidate.contentFingerprint && seenContent.has(candidate.contentFingerprint)) continue
    seenIdentities.add(key)
    if (candidate.contentFingerprint) seenContent.add(candidate.contentFingerprint)
    eligible.push({ ...candidate, question: { ...candidate.question }, pointIds: [...candidate.pointIds] })
  }
  const remaining = [...eligible]
  const covered = new Set<string>()
  const selected: ExamQuestionCandidate[] = []
  while (selected.length < options.count && remaining.length) {
    remaining.sort((left, right) => right.pointIds.filter((id) => scope.includes(id) && !covered.has(id)).length -
      left.pointIds.filter((id) => scope.includes(id) && !covered.has(id)).length || questionRefKey(left.question).localeCompare(questionRefKey(right.question)))
    const next = remaining.shift()
    if (!next) break
    selected.push(next)
    next.pointIds.filter((id) => scope.includes(id)).forEach((id) => covered.add(id))
  }
  const typeCounts = { 'multiple-choice': 0, 'true-false': 0, 'short-answer': 0 }
  const levelCounts = { recall: 0, explanation: 0, application: 0 }
  selected.forEach((question) => { typeCounts[question.type] += 1; levelCounts[question.level] += 1 })
  const missingCount = Math.max(0, options.count - selected.length)
  const reasons: string[] = []
  if (missingCount) reasons.push(`题库只有 ${eligible.length} 道可用且不重复的题目，距目标题量缺 ${missingCount} 道；未自动生成。`)
  const uncoveredPointIds = scope.filter((id) => !covered.has(id))
  if (uncoveredPointIds.length) reasons.push(`${uncoveredPointIds.length} 个知识点没有被本组现有题目覆盖。`)
  return { selected, requestedCount: options.count, availableCount: eligible.length, missingCount,
    coveredPointIds: scope.filter((id) => covered.has(id)), uncoveredPointIds, typeCounts, levelCounts, reasons, generatedQuestionCount: 0 }
}
