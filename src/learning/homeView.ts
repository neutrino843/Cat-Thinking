import type { CourseSnapshot } from './model'
import { type PlannedLearningTask } from './dailyPlan'
import { buildPersonalPlan, DEFAULT_PERSONAL_CAPACITY, type PersonalCapacity } from './personalPlan'
import { learningDate } from './reviewScheduler'
import type { TodayPlanPreference } from './todayPlanPreferences'

export interface HomeTask extends PlannedLearningTask { courseName: string }
/** Home displays persisted study facts and bounded plans; it makes no model requests. */
export function buildLearningHome(snapshots: readonly CourseSnapshot[], now: number, courseId = '', query = '', capacity: PersonalCapacity = DEFAULT_PERSONAL_CAPACITY, preferences: readonly TodayPlanPreference[] = []) {
  const personal = snapshots.filter((snapshot) => !snapshot.course.example)
  const filtered = personal.filter((snapshot) => !courseId || snapshot.course.id === courseId)
  const plan = buildPersonalPlan(personal, now, capacity, '', preferences)
  const tasks: HomeTask[] = plan.selected
    .filter((task) => !courseId || task.courseId === courseId)
    .map((task) => ({ ...task, courseName: personal.find((snapshot) => snapshot.course.id === task.courseId)?.course.name ?? '' }))
  let submittedToday = 0
  const courses = filtered.map((snapshot) => {
    const today = learningDate(now, snapshot.course.timeZone)
    submittedToday += snapshot.attempts.filter((attempt) => attempt.origin === 'practice' && attempt.submittedAt !== null && attempt.learningDate === today).length
    return { course: snapshot.course, documentCount: snapshot.documents.length, archiveCount: snapshot.archives.length,
      confirmedPoints: snapshot.points.filter((point) => point.status === 'active').length,
      attempts: snapshot.attempts.length, planned: tasks.filter((task) => task.courseId === snapshot.course.id).length }
  })
  const term = query.trim().toLocaleLowerCase()
  const backlog = plan.backlog.filter((task) => {
    if (courseId && task.courseId !== courseId) return false
    const courseName = personal.find((snapshot) => snapshot.course.id === task.courseId)?.course.name ?? ''
    return !term || `${task.title} ${courseName}`.toLocaleLowerCase().includes(term)
  })
  return { courses: courses.filter((row) => !term || `${row.course.name} ${row.course.goal}`.toLocaleLowerCase().includes(term)),
    tasks: tasks.filter((task) => !term || `${task.title} ${task.courseName}`.toLocaleLowerCase().includes(term)),
    plannedCount: tasks.length, reviewCount: tasks.filter((task) => task.type === 'review').length,
    remediationCount: tasks.filter((task) => task.type === 'remediation').length,
    submittedToday, deferred: backlog.filter((task) => task.deferredBecause === 'time-capacity' || task.deferredBecause === 'question-capacity').length,
    backlog, minutes: plan.minutes, questions: plan.questions, limits: plan.limits,
    reservedMinutes: plan.reservedMinutes, remainingMinutes: plan.remainingMinutes, reservedQuestions: plan.reservedQuestions,
    archiveCount: filtered.reduce((sum, snapshot) => sum + snapshot.archives.length, 0) }
}
