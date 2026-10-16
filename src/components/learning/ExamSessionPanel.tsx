import type { CourseSnapshot } from '../../learning/model'
import { learningBase } from '../../learning/model'
import type { ExamQuestionSelection } from '../../learning/examPlan'
import { examSessionReport } from '../../learning/examReport'
import { questionKey } from '../../learning/workspaceView'
import { saveEntity } from '../../learning/repository'
import type { LearningAction } from './CourseOverview'
import { archivedQuestions, referenceAnswer, sameQuestion } from '../../learning/workspaceView'
import { appendAssessment } from '../../learning/repository'
import { useState } from 'react'
import { learningDate } from '../../learning/reviewScheduler'

export function AttemptAnswerReview({ snapshot, attemptId, action, busy, exam = true }: { snapshot: CourseSnapshot; attemptId: string; action: LearningAction; busy: boolean; exam?: boolean }) {
  const attempt = snapshot.attempts.find((item) => item.id === attemptId)
  const item = attempt && archivedQuestions(snapshot.archives).find((question) => sameQuestion(question.ref, attempt.question))
  const [checks, setChecks] = useState<boolean[]>(item?.question.type === 'short-answer' ? item.question.rubric.map(() => false) : [])
  if (!attempt || !item) return null
  return <details><summary>结束后核对本题</summary><p>我的回答：{String(attempt.answer)}</p><p>参考：{referenceAnswer(item)}</p><p>{item.question.explanation}</p>{item.question.type === 'short-answer' && <>{item.question.rubric.map((criterion, index) => <label className="learning-option" key={index}><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks(checks.map((value, i) => i === index ? event.target.checked : value))} />{criterion}</label>)}<button className="tbtn" disabled={busy} onClick={() => void action(() => appendAssessment({ ...learningBase(snapshot.course.id), kind: 'assessment', attemptId, outcome: checks.every(Boolean) ? 'success' : checks.some(Boolean) ? 'partial' : 'failure', difficulty: checks.every(Boolean) ? 'good' : 'again', selfAssessmentComplete: true, rubricChecks: checks }))}>{exam ? '保存本场简答自评' : '保存这次简答自评'}</button></>}</details>
}

const STATUS = { missing: '归档已不可用', disputed: '题目待核对', unanswered: '尚未回答', 'self-assessed': '已自评', 'pending-self-assessment': '等待简答自评', consistent: '客观题与参考一致', inconsistent: '客观题与参考不一致' }
export default function ExamSessionPanel({ snapshot, selection, scope, action, busy, onPractice, durationMinutes = 30, onRemediate, reportSessionId }: { snapshot: CourseSnapshot; selection?: ExamQuestionSelection; scope: string[]; action: LearningAction; busy: boolean; onPractice: (pointId?: string, questionId?: string, sessionId?: string, reportId?: string) => void; durationMinutes?: number; onRemediate?: (attemptId: string, reportId?: string) => void; reportSessionId?: string }) {
  const sessions = snapshot.sessions.filter((session) => session.purpose === 'exam').sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  return <section>{selection && <button className="tbtn primary" disabled={busy || !selection.selected.length || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180} onClick={() => void action(async () => {
    const base = learningBase(snapshot.course.id)
    const session = await saveEntity({ ...base, kind: 'session', purpose: 'exam', title: `模拟练习 · ${selection.selected.length} 题`, pointIds: scope, status: 'active', steps: [], questions: selection.selected.map((item) => item.question), examConfig: { mode: 'simulation', durationMinutes }, planning: { date: learningDate(base.createdAt), minutes: durationMinutes } }, null)
    onPractice('', questionKey(selection.selected[0].question), session.id)
  })}>开始这组模拟练习</button>}
    {sessions.map((session) => { const report = examSessionReport(snapshot, session); return <details className="learning-section" key={session.id} open={session.status === 'active' || session.id === reportSessionId} data-report-session={session.id}><summary>{session.title} · {session.status === 'active' ? '进行中' : '已结束'} · {new Date(session.createdAt).toLocaleString('zh-CN')}</summary>
      <p>客观比较：一致 {report.counts.consistent}，不一致 {report.counts.inconsistent}。简答：已自评 {report.counts['self-assessed']}，待自评 {report.counts['pending-self-assessment']}。未答 {report.counts.unanswered}，问题题目 {report.counts.disputed}，归档缺失 {report.counts.missing}。</p>
      <p>报告只使用这组练习中的回答，客观比较与个人自评分开，不推算考试成绩。</p><ol>{report.items.map((item) => <li key={questionKey(item.question)}>{item.title} · {STATUS[item.status as keyof typeof STATUS]}{item.assessment?.reason && ` · ${item.assessment.reason}`}
        {session.status !== 'active' && <p>{item.status === 'missing' ? '原题已缺失，请到资料页检查归档。' : item.status === 'disputed' ? '有疑问的题先到记录页核对，暂停安排会保留。' : item.status === 'pending-self-assessment' ? '先在下方核对本题并保存自评，再决定补学。' : item.status === 'unanswered' ? '这次未作答，可开启新的练习，原报告仍记为未答。' : '可针对这一题回原文补学，新增练习不会改写本场报告。'}</p>}
        {session.status !== 'active' && item.status === 'unanswered' && <button className="tbtn" onClick={() => onPractice('', questionKey(item.question), '', session.id)}>新练习这道未答题</button>}
        {session.status !== 'active' && item.attempt && !['missing', 'disputed', 'pending-self-assessment'].includes(item.status) && <button className="tbtn" disabled={busy} onClick={() => item.attempt && onRemediate?.(item.attempt.id, session.id)}>针对这题补学</button>}
        {session.status === 'active' && item.status !== 'missing' && item.status !== 'disputed' && <button className="tbtn" onClick={() => onPractice('', questionKey(item.question), session.id)}>打开本组题目</button>}</li>)}</ol>
      {session.status !== 'active' && report.items.map((item) => item.attempt && <AttemptAnswerReview key={item.attempt.id} snapshot={snapshot} attemptId={item.attempt.id} action={action} busy={busy} />)}
      {session.status === 'active' && <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...session, status: report.items.every((item) => !['unanswered', 'pending-self-assessment', 'missing', 'disputed'].includes(item.status)) ? 'completed' : 'ended', endedAt: Date.now() }, session.revision))}>结束并保留本组报告</button>}
    </details> })}
  </section>
}
