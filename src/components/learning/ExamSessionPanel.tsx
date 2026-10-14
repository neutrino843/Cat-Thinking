import type { CourseSnapshot } from '../../learning/model'
import { learningBase } from '../../learning/model'
import type { ExamQuestionSelection } from '../../learning/examPlan'
import { examSessionReport } from '../../learning/examReport'
import { questionKey } from '../../learning/workspaceView'
import { saveEntity } from '../../learning/repository'
import type { LearningAction } from './CourseOverview'

const STATUS = { missing: '归档已不可用', disputed: '题目待核对', unanswered: '尚未回答', 'self-assessed': '已自评', 'pending-self-assessment': '等待简答自评', consistent: '客观题与参考一致', inconsistent: '客观题与参考不一致' }
export default function ExamSessionPanel({ snapshot, selection, scope, action, busy, onPractice }: { snapshot: CourseSnapshot; selection?: ExamQuestionSelection; scope: string[]; action: LearningAction; busy: boolean; onPractice: (pointId?: string, questionId?: string, sessionId?: string) => void }) {
  const sessions = snapshot.sessions.filter((session) => session.purpose === 'exam').sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  return <section>{selection && <button className="tbtn primary" disabled={busy || !selection.selected.length} onClick={() => void action(async () => {
    const session = await saveEntity({ ...learningBase(snapshot.course.id), kind: 'session', purpose: 'exam', title: `模拟练习 · ${selection.selected.length} 题`, pointIds: scope, status: 'active', steps: [], questions: selection.selected.map((item) => item.question) }, null)
    onPractice('', questionKey(selection.selected[0].question), session.id)
  })}>开始这组模拟练习</button>}
    {sessions.map((session) => { const report = examSessionReport(snapshot, session); return <details className="learning-section" key={session.id} open={session.status === 'active'}><summary>{session.title} · {session.status === 'active' ? '进行中' : '已结束'} · {new Date(session.createdAt).toLocaleString('zh-CN')}</summary>
      <p>客观比较：一致 {report.counts.consistent}，不一致 {report.counts.inconsistent}。简答：已自评 {report.counts['self-assessed']}，待自评 {report.counts['pending-self-assessment']}。未答 {report.counts.unanswered}，问题题目 {report.counts.disputed}，归档缺失 {report.counts.missing}。</p>
      <p>报告只使用这组练习中的回答，客观比较与个人自评分开，不推算考试成绩。</p><ol>{report.items.map((item) => <li key={questionKey(item.question)}>{item.title} · {STATUS[item.status as keyof typeof STATUS]}{item.assessment?.reason && ` · ${item.assessment.reason}`}
        {session.status === 'active' && item.status !== 'missing' && item.status !== 'disputed' && <button className="tbtn" onClick={() => onPractice('', questionKey(item.question), session.id)}>打开本组题目</button>}</li>)}</ol>
      {session.status === 'active' && <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...session, status: report.items.every((item) => !['unanswered', 'pending-self-assessment', 'missing', 'disputed'].includes(item.status)) ? 'completed' : 'ended', endedAt: Date.now() }, session.revision))}>结束并保留本组报告</button>}
    </details> })}
  </section>
}
