import { LearningRuleError, parseLearningDate } from './reviewScheduler'

export type LearningTaskType = 'review' | 'remediation' | 'prerequisite' | 'new' | 'application'
export interface DailyPlanCandidate {
  id: string
  courseId: string
  pointId?: string
  targetId?: string
  type: LearningTaskType
  title: string
  reason?: string
  estimatedMinutes: number
  questionCount: number
  dueDate?: string
  pinned?: boolean
  paused?: boolean
  sourceStatus?: 'valid' | 'changed' | 'missing' | 'pending'
  order?: number
}
export interface DailyPlanOptions { learningDate: string; timeBudgetMinutes: number; questionLimit: number }
export interface PlannedLearningTask extends DailyPlanCandidate { recommendationReason: string }
export interface DeferredLearningTask extends PlannedLearningTask {
  deferredBecause: 'not-due' | 'paused' | 'source-invalid' | 'time-capacity' | 'question-capacity'
  deferredReason: string
}
export interface DailyPlan {
  learningDate: string
  selected: PlannedLearningTask[]
  backlog: DeferredLearningTask[]
  estimatedMinutes: number
  questionCount: number
  eligibleCount: number
  unscheduledCount: number
  limits: { timeBudgetMinutes: number; questionLimit: number }
}

function rank(task: DailyPlanCandidate): number {
  if (task.pinned) return 0
  return { remediation: 1, review: 1, prerequisite: 2, new: 3, application: 4 }[task.type]
}
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export function compareDailyTasks(left: DailyPlanCandidate, right: DailyPlanCandidate): number {
  return rank(left) - rank(right) || compareText(left.dueDate ?? '9999-12-31', right.dueDate ?? '9999-12-31') ||
    (left.order ?? 0) - (right.order ?? 0) || compareText(left.id, right.id)
}

function recommendation(task: DailyPlanCandidate): string {
  if (task.pinned) return task.reason ? `用户固定项：${task.reason}` : '用户固定项，优先安排。'
  if (task.reason) return task.reason
  return { review: `到期复习${task.dueDate ? `（${task.dueDate}）` : ''}，先答后回查。`,
    remediation: '上次练习需要补学，回查原文后再验证。',
    prerequisite: '这是已确认的前置知识，建议先补齐。',
    new: '按当前章节顺序学习尚未练习的知识点。',
    application: '可选应用任务，单独验证解释与迁移。' }[task.type]
}

/** Every excluded item remains visible; capacity never turns a skip into failure. */
export function buildDailyPlan(candidates: readonly DailyPlanCandidate[], options: DailyPlanOptions): DailyPlan {
  parseLearningDate(options.learningDate)
  if (!Number.isFinite(options.timeBudgetMinutes) || options.timeBudgetMinutes < 0 ||
    !Number.isInteger(options.questionLimit) || options.questionLimit < 0) {
    throw new LearningRuleError('invalid_capacity', '每日时间须非负，题数上限须为非负整数。')
  }
  const candidateIds = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.id || candidateIds.has(candidate.id) || !Number.isFinite(candidate.estimatedMinutes) || candidate.estimatedMinutes <= 0 ||
      !Number.isInteger(candidate.questionCount) || candidate.questionCount < 0) {
      throw new LearningRuleError('invalid_capacity', '学习任务须有唯一身份、正数预计时间和非负整数题数。')
    }
    if (candidate.dueDate) parseLearningDate(candidate.dueDate)
    candidateIds.add(candidate.id)
  }
  const selected: PlannedLearningTask[] = []
  const backlog: DeferredLearningTask[] = []
  let estimatedMinutes = 0
  let questionCount = 0
  let eligibleCount = 0
  for (const candidate of [...candidates].sort(compareDailyTasks)) {
    const task = { ...candidate, recommendationReason: recommendation(candidate) }
    const defer = (deferredBecause: DeferredLearningTask['deferredBecause'], deferredReason: string) => backlog.push({ ...task, deferredBecause, deferredReason })
    if (candidate.paused) { defer('paused', '用户已暂停，恢复后再安排。'); continue }
    if (candidate.sourceStatus && candidate.sourceStatus !== 'valid') { defer('source-invalid', '来源缺失、变化或待确认，修复前不安排练习。'); continue }
    if (candidate.dueDate && candidate.dueDate > options.learningDate && !candidate.pinned) { defer('not-due', '尚未到复习日期。'); continue }
    eligibleCount += 1
    if (questionCount + task.questionCount > options.questionLimit) { defer('question-capacity', '超过今日题数上限，保留待安排。'); continue }
    if (estimatedMinutes + task.estimatedMinutes > options.timeBudgetMinutes) { defer('time-capacity', '超过今日时间预算，保留待安排。'); continue }
    selected.push(task)
    estimatedMinutes += task.estimatedMinutes
    questionCount += task.questionCount
  }
  return { learningDate: options.learningDate, selected, backlog, estimatedMinutes, questionCount, eligibleCount,
    unscheduledCount: backlog.filter((task) => task.deferredBecause === 'time-capacity' || task.deferredBecause === 'question-capacity').length,
    limits: { timeBudgetMinutes: options.timeBudgetMinutes, questionLimit: options.questionLimit } }
}
