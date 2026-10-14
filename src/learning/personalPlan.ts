import { buildDailyPlan, compareDailyTasks, type DeferredLearningTask, type PlannedLearningTask } from './dailyPlan'
import { coursePlanCandidates } from './planCandidates'
import { learningDate, LearningRuleError } from './reviewScheduler'
import type { CourseSnapshot } from './model'
import { todayPlanTaskKey, type TodayPlanPreference } from './todayPlanPreferences'

export interface PersonalCapacity { minutes: number; questions: number }
export const DEFAULT_PERSONAL_CAPACITY: PersonalCapacity = { minutes: 30, questions: 20 }
export function parsePersonalCapacity(input: unknown): PersonalCapacity {
  if (!input || typeof input !== 'object') throw new LearningRuleError('invalid_capacity', '请设置当天总时间和题数。')
  const value = input as PersonalCapacity
  if (!Number.isInteger(value.minutes) || value.minutes < 0 || value.minutes > 1440 || !Number.isInteger(value.questions) || value.questions < 0 || value.questions > 1000) throw new LearningRuleError('invalid_capacity', '总时间为 0–1440 分钟，题数为 0–1000。')
  return { minutes: value.minutes, questions: value.questions }
}
/** Each course keeps its local calendar and limits; all courses share one personal capacity. */
export function buildPersonalPlan(snapshots: readonly CourseSnapshot[], now: number, capacity: PersonalCapacity, courseId = '', preferences: readonly TodayPlanPreference[] = []) {
  const limits = parsePersonalCapacity(capacity)
  const today = learningDate(now)
  const decisions = new Map(preferences.filter((item) => item.date === today).map((item) => [todayPlanTaskKey(item.courseId, item.taskId), item.action]))
  let reservedMinutes = 0; let reservedQuestions = 0
  const usage = new Map<string, { minutes: number; questions: number }>()
  for (const snapshot of snapshots.filter((item) => !item.course.example)) {
    const sessions = snapshot.sessions.filter((session) => session.planning?.date === today)
    const attempts = snapshot.attempts.filter((attempt) => attempt.origin === 'practice' && attempt.submittedAt !== null && learningDate(attempt.submittedAt) === today)
    let amount = sessions.reduce((sum, session) => sum + (session.planning?.minutes ?? 0), 0)
    for (const attempt of attempts.filter((item) => !sessions.some((session) => session.id === item.sessionId))) {
      const artifact = snapshot.archives.find((archive) => archive.id === attempt.question.archiveId)?.artifacts.find((item) => item.id === attempt.question.artifactId)
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((item) => item.id === attempt.question.questionId) : undefined
      if (question) amount += question.type === 'short-answer' ? 5 : 2
    }
    usage.set(snapshot.course.id, { minutes: amount, questions: attempts.length }); reservedMinutes += amount; reservedQuestions += attempts.length
  }
  const remainingMinutes = Math.max(0, limits.minutes - reservedMinutes); const remainingQuestions = Math.max(0, limits.questions - reservedQuestions)
  const candidates: PlannedLearningTask[] = []; const backlog: DeferredLearningTask[] = []
  for (const snapshot of snapshots.filter((item) => !item.course.example && (!courseId || item.course.id === courseId))) {
    const used = usage.get(snapshot.course.id)
    const source = coursePlanCandidates(snapshot)
    const options = { learningDate: learningDate(now, snapshot.course.timeZone), timeBudgetMinutes: Math.max(0, snapshot.course.dailyMinutes - (used?.minutes ?? 0)), questionLimit: Math.max(0, snapshot.course.dailyQuestionLimit - (used?.questions ?? 0)) }
    const initial = buildDailyPlan(source, options)
    const deferredByUser = initial.selected.filter((task) => decisions.get(todayPlanTaskKey(task.courseId, task.id)) === 'tomorrow')
    const deferredKeys = new Set(deferredByUser.map((task) => todayPlanTaskKey(task.courseId, task.id)))
    const plan = deferredKeys.size ? buildDailyPlan(source.filter((task) => !deferredKeys.has(todayPlanTaskKey(task.courseId, task.id))), options) : initial
    candidates.push(...plan.selected); backlog.push(...plan.backlog)
    backlog.push(...deferredByUser.map((task) => ({ ...task, deferredBecause: 'user-deferred' as const, deferredReason: '你选择了明天再做；今天不占用容量，也不修改原复习日期。' })))
  }
  const selected: PlannedLearningTask[] = []; let minutes = 0; let questions = 0
  for (const task of candidates.sort(compareDailyTasks)) {
    if (minutes + task.estimatedMinutes > remainingMinutes) { backlog.push({ ...task, deferredBecause: 'time-capacity', deferredReason: '超过跨课程的当天总时间，保留待安排。' }); continue }
    if (questions + task.questionCount > remainingQuestions) { backlog.push({ ...task, deferredBecause: 'question-capacity', deferredReason: '超过跨课程的当天总题数，保留待安排。' }); continue }
    selected.push(task); minutes += task.estimatedMinutes; questions += task.questionCount
  }
  const arranged = [...selected.filter((task) => decisions.get(todayPlanTaskKey(task.courseId, task.id)) !== 'later'), ...selected.filter((task) => decisions.get(todayPlanTaskKey(task.courseId, task.id)) === 'later')]
  return { selected: arranged, backlog, minutes, questions, limits, reservedMinutes, reservedQuestions, remainingMinutes, remainingQuestions }
}
