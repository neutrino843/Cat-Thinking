import { useState } from 'react'
import type { CourseSnapshot, KnowledgePoint, LearningSession } from '../../learning/model'
import { saveEntity } from '../../learning/repository'
import { sameQuestion, sourceExcerpt } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'

const LABELS = { read: '阅读核心说明', recall: '隐藏说明，主动回忆', practice: '完成已有练习', source: '回看原文', explain: '写自己的解释' }
function GuidedStep({ session, index, snapshot, point, action, busy, onPractice, hidden, onHide }: {
  session: LearningSession; index: number; snapshot: CourseSnapshot; point: KnowledgePoint; action: LearningAction; busy: boolean
  onPractice: () => void; hidden: boolean; onHide: (value: boolean) => void
}) {
  const step = session.steps[index]
  const [note, setNote] = useState(step.note)
  const [baseline, setBaseline] = useState(step.note)
  const practiced = snapshot.attempts.some((attempt) => attempt.submittedAt !== null && attempt.submittedAt >= session.createdAt && point.questionRefs.some((ref) => ref.confirmed && sameQuestion(ref, attempt.question)))
  const written = step.action === 'recall' || step.action === 'explain'
  const stale = step.note !== baseline
  const complete = () => void action(() => saveEntity({ ...session, steps: session.steps.map((s, i) => i === index ? { ...s, status: 'completed', note: written ? note.trim() : s.note } : s) }, session.revision).then((saved) => setBaseline(saved.steps[index].note)))
  return <section className="learning-section"><h5>{LABELS[step.action]} · {step.status === 'completed' ? '已完成' : step.status === 'skipped' ? '已跳过' : '待进行'}</h5>
    {step.action === 'read' && !hidden && <blockquote>{point.definition || '尚无核心说明，可阅读已保存原文，或先整理说明。'}</blockquote>}
    {step.action === 'recall' && <button className="tbtn" disabled={busy} onClick={() => onHide(!hidden)}>{hidden ? '显示说明，核对回忆' : '隐藏核心说明开始回忆'}</button>}
    {written && <label>{step.action === 'recall' ? '不看说明，我能回忆什么' : '用自己的话解释这个知识点'}<textarea maxLength={10000} value={note} onChange={(e) => setNote(e.target.value)} /></label>}
    {step.action === 'practice' && <><button className="tbtn" onClick={onPractice}>打开这个知识点的练习</button><p>{practiced ? '本次学习开始后已有提交，可记录此步骤。' : '先提交一道已有题，再记录已练；没有题目时可跳过。'}</p></>}
    {step.action === 'source' && <details><summary>展开本次保存的原文依据</summary>{point.sourceRefs.map((ref, i) => { const archive = snapshot.archives.find((a) => a.id === ref.archiveId); const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end); return <div key={i}><strong>{source?.name ?? '原文不可用'}</strong><blockquote>{source?.quote}</blockquote></div> })}{!point.sourceRefs.length && <p>这个个人知识点尚无归档依据，可以跳过。</p>}</details>}
    {stale && <p role="status">这一步的笔记已更新，请重新读取后编辑。</p>}
    <div className="learning-actions"><button className="tbtn" disabled={busy || stale || written && !note.trim() || step.action === 'practice' && !practiced} onClick={complete}>{written ? '保存文字并完成步骤' : '记为完成'}</button>
      <button className="tbtn" disabled={busy || stale} onClick={() => void action(() => saveEntity({ ...session, steps: session.steps.map((s, i) => i === index ? { ...s, status: 'skipped', note: written ? note.trim() : s.note } : s) }, session.revision).then((saved) => setBaseline(saved.steps[index].note)))}>跳过</button>
      {stale && <button className="tbtn" onClick={() => { setNote(step.note); setBaseline(step.note) }}>重新读取步骤</button>}</div>
  </section>
}

export default function GuidedLearning(props: { session: LearningSession; snapshot: CourseSnapshot; point: KnowledgePoint; action: LearningAction; busy: boolean; onPractice: () => void; hidden: boolean; onHide: (value: boolean) => void }) {
  const { session, action, busy } = props
  return <section className="learning-section"><h4>本次学习单元</h4><p>回忆和解释会保存为学习笔记。步骤可以跳过；读过与实际提交分别记录。</p>
    {session.steps.map((_, index) => <GuidedStep key={`${session.id}/${index}`} {...props} index={index} />)}
    <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...session, status: session.steps.every((s) => s.status === 'completed') ? 'completed' : 'ended', endedAt: Date.now() }, session.revision))}>结束本次学习</button>
  </section>
}
