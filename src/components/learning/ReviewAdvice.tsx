import type { AssessmentEvent, CourseSnapshot, PracticeAttempt, ReviewSchedule } from '../../learning/model'
import { learningBase } from '../../learning/model'
import { proposeReviewSchedule, REVIEW_RULE_VERSION } from '../../learning/reviewScheduler'
import { sameQuestion } from '../../learning/workspaceView'
import { saveEntity } from '../../learning/repository'
import type { LearningAction } from './CourseOverview'

export default function ReviewAdvice({ snapshot, attempt, assessment, shortAnswer, action, busy }: { snapshot: CourseSnapshot; attempt: PracticeAttempt; assessment?: AssessmentEvent; shortAnswer: boolean; action: LearningAction; busy: boolean }) {
  const previous = snapshot.schedules.find((s) => sameQuestion(s.question, attempt.question))
  const issue = snapshot.issues.some((i) => sameQuestion(i.question, attempt.question) && i.status === 'open')
  if (!assessment?.selfAssessmentComplete || attempt.submittedAt === null) return <p>完成自评后，可以查看复习日期建议。</p>
  if (previous && (previous.manual || previous.lastLearningDate && previous.lastLearningDate > attempt.learningDate || previous.lastAttemptId && previous.lastAttemptId !== attempt.id && previous.updatedAt > attempt.submittedAt)) return <section className="review-advice" aria-label="本题复习建议"><h4>已有复习安排</h4><p>{previous.dueDate} · {previous.manual ? '保留你手动选择的日期。' : '这次作答之后已有更新的记录，保留当前安排。'}</p><p>查看历史回答不会重新计算日期。</p></section>
  const initial: ReviewSchedule = previous ?? { ...learningBase(snapshot.course.id), kind: 'schedule', question: attempt.question, status: 'active', dueDate: attempt.learningDate, stage: 0, manual: false, ruleVersion: REVIEW_RULE_VERSION }
  const proposed = proposeReviewSchedule(initial, { utcTimestamp: attempt.submittedAt, timeZone: snapshot.course.timeZone, attemptId: attempt.id, outcome: assessment.outcome, answerProvided: String(attempt.answer).trim().length > 0, answerRevealedBeforeSubmit: attempt.answerRevealed || !!attempt.assistance?.hints || !!attempt.assistance?.sourceViewed || !!attempt.assistance?.fullExplanation, questionType: shortAnswer ? 'short-answer' : 'objective', selfAssessmentComplete: assessment.selfAssessmentComplete, recallDifficulty: assessment.difficulty })
  return <section className="review-advice" aria-label="本题复习建议"><h4>隔一段时间，再试着回忆</h4>
    <p>{issue || previous?.status === 'paused' ? '这道题有疑问或已暂停，请先核对。' : proposed.reason}</p>
    <p>{previous ? `已有安排：${previous.dueDate}${previous.manual ? '（手动指定，保留）' : ''}。` : `建议日期：${proposed.schedule.dueDate}。尚未保存安排。`}</p>
    <p className="focus-muted">先回忆，再核对原文；借助提示的回答留到以后独立验证。当前使用固定间隔规则，日期是建议，不是掌握证明。</p>
    {!previous?.manual && !issue && previous?.status !== 'paused' && <button className="tbtn" disabled={busy || previous?.lastAttemptId === attempt.id} onClick={() => void action(() => saveEntity(proposed.schedule, previous?.revision ?? null))}>采用本次建议日期</button>}
    <p className="focus-muted">也可在下方自己选日期，或暂不新增安排。采用一次建议不会开启自动复习。</p>
  </section>
}
