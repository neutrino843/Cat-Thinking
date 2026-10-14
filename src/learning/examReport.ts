import type { CourseSnapshot, LearningSession } from './model'
import { archivedQuestions, sameQuestion } from './workspaceView'

/** Classifies only attempts explicitly belonging to this exam, never unrelated subsequent practice. */
export function examSessionReport(snapshot: CourseSnapshot, session: LearningSession) {
  const items = (session.questions ?? []).map((question) => {
    const item = archivedQuestions(snapshot.archives).find((q) => sameQuestion(q.ref, question))
    const attempt = snapshot.attempts.filter((a) => a.sessionId === session.id && sameQuestion(a.question, question))
      .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0) || a.id.localeCompare(b.id)).at(-1)
    const assessment = attempt && snapshot.assessments.filter((e) => e.attemptId === attempt.id).at(-1)
    const disputed = snapshot.issues.some((issue) => issue.status === 'open' && sameQuestion(issue.question, question))
    const status = !item ? 'missing' : disputed ? 'disputed' : !attempt ? 'unanswered' : item.question.type === 'short-answer'
      ? assessment?.selfAssessmentComplete ? 'self-assessed' : 'pending-self-assessment'
      : assessment?.outcome === 'success' ? 'consistent' : 'inconsistent'
    return { question, title: item?.question.prompt ?? '归档题目已不可用', status, attempt, assessment }
  })
  return { items, counts: Object.fromEntries(['missing', 'disputed', 'unanswered', 'self-assessed', 'pending-self-assessment', 'consistent', 'inconsistent'].map((status) => [status, items.filter((item) => item.status === status).length])) }
}
