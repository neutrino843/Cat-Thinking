import { describe, expect, it } from 'vitest'
import { buildLearningHome } from './homeView'
import { learningBase, type CourseSnapshot, type PracticeAttempt } from './model'

function snapshot(id: string, timeZone = 'Asia/Shanghai'): CourseSnapshot {
  return { course: { ...learningBase(id, id, 1), kind: 'course', name: id, goal: '考试复习', timeZone,
    dailyMinutes: 10, dailyQuestionLimit: 5, goalVersion: 1 }, documents: [], docs: [], points: [1, 2].map((n) => ({
      ...learningBase(id, `${id}-${n}`, 1), kind: 'point', title: `知识 ${n}`, definition: '', chapter: '', aliases: [], notes: '',
      sourceRefs: [], questionRefs: [], status: 'active', goalIncluded: true })), archives: [], attempts: [], assessments: [],
    schedules: [], relations: [], drafts: [], merges: [], sessions: [], applicationTasks: [], issues: [], bindings: [] }
}
describe('learning home persisted facts', () => {
  it('has honest zero statistics without courses', () => {
    expect(buildLearningHome([], 0)).toMatchObject({ courses: [], tasks: [], submittedToday: 0, minutes: 0, archiveCount: 0 })
  })
  it('applies each course budget before combining tasks and filters without changing statistics', () => {
    const a = snapshot('生物'); const b = snapshot('算法')
    const home = buildLearningHome([a, b], 0)
    expect(home.tasks).toHaveLength(2); expect(home.minutes).toBe(20); expect(home.deferred).toBe(2)
    expect(buildLearningHome([a, b], 0, '生物')).toMatchObject({ plannedCount: 1, minutes: 20 })
    const search = buildLearningHome([a, b], 0, '', ' 算法 ')
    expect(search.courses.map((row) => row.course.id)).toEqual(['算法'])
    expect(search.tasks.map((task) => task.courseId)).toEqual(['算法'])
    expect(search.plannedCount).toBe(2)
    expect(buildLearningHome([a], 0, '', 'missing').tasks).toEqual([])
  })
  it('treats the course selector as a view filter without replanning global capacity', () => {
    const snapshots = [snapshot('course-a'), snapshot('course-b'), snapshot('course-c')]
    const all = buildLearningHome(snapshots, 0, '', '', { minutes: 20, questions: 20 })
    const deferredCourse = all.backlog.find((task) => task.deferredReason.includes('跨课程'))?.courseId
    expect(deferredCourse).toBeTruthy()
    const filtered = buildLearningHome(snapshots, 0, deferredCourse, '', { minutes: 20, questions: 20 })
    expect(filtered.minutes).toBe(all.minutes)
    expect(filtered.tasks).toEqual([])
    expect(filtered.backlog).toHaveLength(2)
    expect(filtered.backlog.every((task) => task.courseId === deferredCourse)).toBe(true)
  })
  it('counts submitted practice attempts for the local date and excludes drafts and legacy attempts', () => {
    const a = snapshot('上海'); const b = snapshot('洛杉矶', 'America/Los_Angeles')
    const attempt: PracticeAttempt = { ...learningBase(a.course.id, 'practice', 1), kind: 'attempt',
      question: { archiveId: 'a', artifactId: 'q', questionId: '1', confirmed: true }, answer: 'answer',
      submittedAt: 1, learningDate: '2026-10-14', answerRevealed: true, origin: 'practice' }
    a.attempts = [attempt, { ...attempt, id: 'draft', submittedAt: null }, { ...attempt, id: 'legacy', origin: 'legacy' }]
    b.attempts = [{ ...attempt, courseId: b.course.id, learningDate: '2026-10-13' }]
    expect(buildLearningHome([a, b], Date.UTC(2026, 9, 14, 0)).submittedToday).toBe(2)
  })
})
