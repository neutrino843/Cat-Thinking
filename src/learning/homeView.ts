import type { CourseSnapshot } from './model'
import { buildDailyPlan, compareDailyTasks, type PlannedLearningTask } from './dailyPlan'
import { coursePlanCandidates } from './planCandidates'
import { learningDate } from './reviewScheduler'

export interface HomeTask extends PlannedLearningTask { courseName: string }
/** Home displays persisted study facts and bounded plans; it makes no model requests. */
export function buildLearningHome(snapshots: readonly CourseSnapshot[], now: number, courseId = '', query = '') {
  const filtered = snapshots.filter((snapshot) => !courseId || snapshot.course.id === courseId)
  const tasks: HomeTask[] = []
  let submittedToday = 0; let deferred = 0; let minutes = 0; let questions = 0
  const courses = filtered.map((snapshot) => {
    const today = learningDate(now, snapshot.course.timeZone)
    const plan = buildDailyPlan(coursePlanCandidates(snapshot), { learningDate: today,
      timeBudgetMinutes: snapshot.course.dailyMinutes, questionLimit: snapshot.course.dailyQuestionLimit })
    tasks.push(...plan.selected.map((task) => ({ ...task, courseName: snapshot.course.name })))
    submittedToday += snapshot.attempts.filter((attempt) => attempt.origin === 'practice' && attempt.submittedAt !== null && attempt.learningDate === today).length
    deferred += plan.unscheduledCount; minutes += plan.estimatedMinutes; questions += plan.questionCount
    return { course: snapshot.course, documentCount: snapshot.documents.length, archiveCount: snapshot.archives.length,
      confirmedPoints: snapshot.points.filter((point) => point.status === 'active').length,
      attempts: snapshot.attempts.length, planned: plan.selected.length }
  })
  tasks.sort(compareDailyTasks)
  const term = query.trim().toLocaleLowerCase()
  return { courses: courses.filter((row) => !term || `${row.course.name} ${row.course.goal}`.toLocaleLowerCase().includes(term)),
    tasks: tasks.filter((task) => !term || `${task.title} ${task.courseName}`.toLocaleLowerCase().includes(term)),
    plannedCount: tasks.length, reviewCount: tasks.filter((task) => task.type === 'review').length,
    remediationCount: tasks.filter((task) => task.type === 'remediation').length,
    submittedToday, deferred, minutes, questions, archiveCount: filtered.reduce((sum, snapshot) => sum + snapshot.archives.length, 0) }
}
