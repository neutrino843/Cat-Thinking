import type { CourseSnapshot, LearningBase } from './model'
import { learningDate } from './reviewScheduler'

export const ACHIEVEMENTS = [
  { id: 'first', title: '初次同行', detail: '导入自己的资料并完成第一道入门题。', reward: '同行书签' },
  { id: 'repair', title: '找到线索', detail: '完成原文补学、修正笔记和真实重试。', reward: '线索书签' },
  { id: 'recall', title: '再次想起', detail: '同一道正式题在两个不同日期独立成功，含已完成的自评。', reward: '回忆徽记' },
  { id: 'return', title: '愿意再来', detail: '累计五个不同日期有效学习，不要求连续。', reward: '猫咪休息姿势' },
  { id: 'explain', title: '说给自己听', detail: '为三个不同知识点保存个人解释。', reward: '笔记贴纸' },
  { id: 'apply', title: '用起来了', detail: '完成一个应用任务并保存产出。', reward: '桌面小书' },
] as const
export function learningAchievements(snapshots: CourseSnapshot[]) {
  const evidence = new Map<string, { courseId: string; date: string }>()
  const dates = new Set<string>(), explanations = new Set<string>(), seen = new Set<string>()
  const recalled = new Map<string, Set<string>>()
  const firstByDay = new Set<string>()
  const add = (id: string, courseId: string, date: string) => { if (!evidence.has(id)) evidence.set(id, { courseId, date }) }
  const fresh = (record: LearningBase) => { if (!record.originId || seen.has(record.originId)) return false; seen.add(record.originId); return true }
  for (const s of snapshots.filter((s) => !s.course.example)) {
    const day = (time: number) => learningDate(time, s.course.timeZone)
    if (s.course.firstStudyAt) add('first', s.course.id, day(s.course.firstStudyAt))
    for (const attempt of [...s.attempts].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))) {
      const assessment = s.assessments.filter((a) => a.attemptId === attempt.id).sort((a, b) => a.updatedAt - b.updatedAt).at(-1)
      if (attempt.submittedAt === null || attempt.origin !== 'practice' || !fresh(attempt) || assessment?.outcome === 'skipped') continue
      if (assessment?.selfAssessmentComplete && assessment.outcome !== 'disputed' && String(attempt.answer).trim()) dates.add(attempt.learningDate)
      const archive = s.archives.find((a) => a.id === attempt.question.archiveId)
      if (!archive?.originId) continue
      const key = `${archive.originId}/${attempt.question.artifactId}/${attempt.question.questionId}`
      const dailyKey = `${key}/${attempt.learningDate}`
      if (firstByDay.has(dailyKey)) continue
      firstByDay.add(dailyKey)
      const assistance = attempt.assistance
      const artifact = archive.artifacts.find((a) => a.id === attempt.question.artifactId)
      const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((q) => q.id === attempt.question.questionId) : undefined
      const correct = question?.type === 'multiple-choice' ? attempt.answer === question.answerIndex : question?.type === 'true-false' ? attempt.answer === question.answer : question?.type === 'short-answer' && typeof attempt.answer === 'string' && !!attempt.answer.trim() && assessment?.rubricChecks?.length === question.rubric.length && assessment.rubricChecks.every(Boolean)
      if (!correct || !assessment?.selfAssessmentComplete || assessment.outcome !== 'success' || assessment.difficulty === 'again' || attempt.answerRevealed || !assistance?.recorded || assistance.hints || assistance.sourceViewed || assistance.fullExplanation) continue
      const days = recalled.get(key) ?? new Set<string>(); days.add(attempt.learningDate); recalled.set(key, days)
      if (days.size >= 2) add('recall', s.course.id, attempt.learningDate)
    }
    for (const journey of s.journeys ?? []) {
      if (journey.status !== 'completed' || !journey.finishedAt || !journey.note.trim() || !fresh(journey)) continue
      const date = day(journey.finishedAt)
      if (journey.mode === 'reading') { dates.add(date); explanations.add(`${journey.originId}:personal`) }
      else {
        const retry = s.attempts.find((a) => a.id === journey.retryAttemptId && a.id !== journey.attemptId && a.submittedAt !== null)
        if (retry && s.assessments.some((a) => a.attemptId === retry.id && a.selfAssessmentComplete)) { dates.add(date); add('repair', s.course.id, date) }
      }
    }
    for (const session of s.sessions) {
      if (!session.originId || session.purpose === 'exam') continue
      for (const step of session.steps) if (step.action === 'explain' && step.status === 'completed' && step.note.trim()) {
        const point = s.points.find((p) => p.id === step.pointId)
        if (point?.originId) explanations.add(point.originId)
      }
    }
    for (const task of s.applicationTasks) if (task.status === 'completed' && task.response.trim() && fresh(task)) add('apply', s.course.id, task.learningDate ?? day(task.updatedAt))
    if (dates.size >= 5) add('return', s.course.id, [...dates].sort().at(-1) ?? '')
    if (explanations.size >= 3) add('explain', s.course.id, day(s.course.updatedAt))
  }
  return ACHIEVEMENTS.map((item) => ({ ...item, evidence: evidence.get(item.id) }))
}
