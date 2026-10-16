import { useState } from 'react'
import type { CourseSnapshot } from '../../learning/model'
import { deletePracticeHistory, saveEntity } from '../../learning/repository'
import { archivedQuestions, questionKey, sameQuestion } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'

export default function LearningRecords({ snapshot, action, busy, onPractice, onJourney }: { snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onPractice: (pointId?: string, questionKey?: string) => void; onJourney?: (id: string) => void }) {
  const [clearing, setClearing] = useState(false)
  const questions = archivedQuestions(snapshot.archives)
  return <section><h3>学习记录</h3><p>每次提交独立保留。自评、错因和争议以修订记录保存；一次答对不代表整个知识点已经掌握。</p>
    <ol className="learning-list">{[...snapshot.attempts].sort((a, b) => (b.submittedAt ?? b.createdAt) - (a.submittedAt ?? a.createdAt)).map((attempt) => {
      const question = questions.find((q) => sameQuestion(q.ref, attempt.question))
      const assessment = snapshot.assessments.filter((e) => e.attemptId === attempt.id).at(-1)
      return <li key={attempt.id}><strong>{question?.question.prompt ?? '原题不可用'}</strong><span>{attempt.submittedAt === null ? '旧记录导入 无精确提交时间' : new Date(attempt.submittedAt).toLocaleString('zh-CN')} · {attempt.learningDate}</span>
        <p>回答：{typeof attempt.answer === 'boolean' ? attempt.answer ? '正确' : '错误' : String(attempt.answer)}</p>
        <p>{attempt.assistance ? `辅助记录：提示 ${attempt.assistance.hints} 次；${attempt.assistance.fullExplanation ? '看过完整解释' : '未看完整解释'}；${attempt.assistance.sourceViewed ? '提交前回看过原文' : '未回看原文'}。` : '旧记录未记录辅助情况。'}{attempt.confidence !== undefined && ` 提交前信心 ${attempt.confidence}%。`}</p>
        <p>{assessment ? ({ success: '本次参考答案比较一致或已完成自评', partial: '自评未完成', failure: '建议补学', disputed: '答案待核对', skipped: '已跳过' })[assessment.outcome] : '等待自评'}{assessment?.reason ? ` · ${assessment.reason}` : ''}</p>
        {assessment?.origin === 'ai-review' && <p>包含用户核对后的 AI 反馈记录；原始回答、比较与自评状态保留。</p>}
        <details><summary>查看自评与错因修订</summary>{snapshot.assessments.filter((e) => e.attemptId === attempt.id).map((e) => <p key={e.id}>{new Date(e.createdAt).toLocaleString('zh-CN')} · {e.outcome} {e.reason ?? ''}</p>)}</details>
        <button className="tbtn" disabled={!question} onClick={() => onPractice('', questionKey(attempt.question))}>再次练习</button></li>
    })}</ol>{!snapshot.attempts.length && <p>尚无长期作答记录。从保存的学习资料进入练习后，提交会记录在这里。</p>}
    <h4>待核对题目</h4><ul className="learning-list">{snapshot.issues.filter((issue) => issue.status === 'open').map((issue) => <li key={issue.id}><strong>{questions.find((q) => sameQuestion(q.ref, issue.question))?.question.prompt ?? '题目不可用'}</strong><p>{issue.note}</p>
      <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...issue, status: 'resolved' }, issue.revision))}>我已核对 解除疑问</button><p>解除后仍需在今日页明确恢复已暂停的队列。</p></li>)}</ul>
    <h4>阅读与补学记录</h4><ul className="learning-list">{(snapshot.journeys ?? []).map((item) => <li key={item.id}><strong>{item.title} · {item.mode === 'reading' ? '阅读' : '补学'}</strong><p>{item.note || '尚未记录个人解释'}</p><p>{item.status === 'completed' ? '已结束' : '可继续'}{item.dueDate && ` · 下次回看 ${item.dueDate}`}</p>{item.blockedReason && <p role="status">{item.blockedReason}</p>}<button className="tbtn" onClick={() => onJourney?.(item.id)}>查看或继续这一轮</button></li>)}</ul>
    <h4>学习单元记录</h4><ul>{snapshot.sessions.map((session) => <li key={session.id}>{session.title} · {session.steps.filter((s) => s.status === 'completed').length}/{session.steps.length} 步完成 · {session.status === 'active' ? '进行中' : '已结束'}</li>)}</ul>
    <div className="learning-danger"><button className="tbtn" disabled={busy} onClick={() => setClearing(!clearing)}>清除本课程作答历史</button>{clearing && <div><p>将删除 {snapshot.attempts.length} 次回答与自评修订，重置并暂停复习队列。原文、导图与个人笔记保留。</p><button className="tbtn" disabled={busy} onClick={() => void action(async () => { await deletePracticeHistory(snapshot.course.id, snapshot.course.revision); setClearing(false) })}>确认清除回答与自评历史</button><button className="tbtn" onClick={() => setClearing(false)}>取消</button></div>}</div>
  </section>
}
