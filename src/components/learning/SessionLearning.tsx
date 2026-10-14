import { useEffect, useRef, useState } from 'react'
import type { CourseSnapshot, LearningSession } from '../../learning/model'
import { saveEntity } from '../../learning/repository'
import { advanceSession, bindSession, sessionInvalidReason, sessionStepIndex, STEP_LABELS } from '../../learning/session'
import { sameQuestion, sourceExcerpt } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'
import LearningPractice from './LearningPractice'
import { learningDate } from '../../learning/reviewScheduler'

export default function SessionLearning({ session, snapshot, action, busy }: {
  session: LearningSession; snapshot: CourseSnapshot; action: LearningAction; busy: boolean
}) {
  const [current, setCurrent] = useState(session)
  const latest = useRef(session)
  const region = useRef<HTMLElement>(null)
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { if (region.current) region.current.scrollTop = session.checkpoint?.position ?? 0 }, [session.id, session.checkpoint?.position])
  useEffect(() => () => clearTimeout(scrollTimer.current), [])
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const failed = useRef(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState(() => session.steps[sessionStepIndex(session)]?.note ?? '')
  const [plannedMinutes, setPlannedMinutes] = useState(session.planning?.minutes ?? 10)
  const index = sessionStepIndex(current)
  const step = current.steps[index]
  const point = snapshot.points.find((item) => item.id === step?.pointId)
  const reason = sessionInvalidReason(current, snapshot)
  const hidden = current.checkpoint?.hidden ?? step?.action === 'recall'
  const paused = current.checkpoint?.paused === true
  const practiced = snapshot.attempts.some((attempt) => attempt.sessionId === current.id && attempt.submittedAt !== null && point?.questionRefs.some((ref) => ref.confirmed && sameQuestion(ref, attempt.question)))
  const persist = (transform: (value: LearningSession) => LearningSession, nextStep = false) => {
    pending.current++; setWriting(true)
    queue.current = queue.current.then(async () => {
      if (failed.current) return
      const updated = transform(latest.current)
      if (updated.planning) updated.planning = { ...updated.planning, date: learningDate(Date.now()) }
      const saved = await saveEntity(updated, latest.current.revision)
      latest.current = saved; setCurrent(saved)
      if (nextStep) { clearTimeout(scrollTimer.current); if (region.current) region.current.scrollTop = 0; setNote(saved.steps[sessionStepIndex(saved)]?.note ?? '') }
    }).catch(() => { failed.current = true; setError('会话保存冲突或失败，当前文字仍在输入框中。请复制文字并重新读取会话。') }).finally(() => { pending.current--; if (!pending.current) setWriting(false) })
  }
  const checkpoint = (values: Partial<NonNullable<LearningSession['checkpoint']>>) => persist((value) => {
    const bound = value.checkpoint ? value : bindSession(value, snapshot)
    if (!bound.checkpoint) throw new Error('会话检查点不可用。')
    return { ...bound, checkpoint: { ...bound.checkpoint, ...values } }
  })
  if (!step || !point) return <p role="alert">会话知识内容不可用，请回到知识结构检查。</p>
  const written = step.action === 'recall' || step.action === 'explain'
  const blocked = busy || writing || !!error || !!reason || paused || current.status !== 'active'
  return <section ref={region} className="learning-section learning-session" data-learning-session onScroll={(event) => {
    if (failed.current || reason || current.status !== 'active') return
    const position = Math.round(event.currentTarget.scrollTop)
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => { if (latest.current.checkpoint?.position !== position) checkpoint({ position }) }, 300)
  }}>
    <h4>本次学习单元 · {current.title}</h4><p>第 {index + 1} / {current.steps.length} 步 · {point.title} · {STEP_LABELS[step.action]}</p>
    <progress value={current.steps.filter((item) => item.status !== 'pending').length} max={current.steps.length} aria-label="学习步骤进度" />
    <p role="status">{writing ? '正在保存会话…' : error ? '文字尚未确认保存' : paused ? '已暂停，下次可从首页继续' : current.status === 'active' ? '会话与文字已保存' : '本次学习已结束，记录已保留'}</p>
    <div className="learning-fields"><label>本会话预留分钟数<input type="number" min="0" max="1440" value={plannedMinutes} onChange={(event) => setPlannedMinutes(Number(event.target.value))} /></label><button className="tbtn" disabled={busy || writing || !!error || !Number.isInteger(plannedMinutes) || plannedMinutes < 0 || plannedMinutes > 1440} onClick={() => persist((value) => ({ ...value, planning: { date: learningDate(Date.now()), minutes: plannedMinutes } }))}>调整预留时间</button></div><p>预留时间用于当天跨课程安排，可调整；不会作为实际学习时长或掌握证据。</p>
    {error && <p role="alert">{error}</p>}
    {reason && <div role="alert"><p>{reason}</p><button className="tbtn" disabled={busy || writing} onClick={() => void action(async () => {
      const rebound = bindSession(session, snapshot)
      const invalid = sessionInvalidReason(rebound, snapshot); if (invalid) throw new Error(invalid)
      const saved = await saveEntity(rebound, session.revision); latest.current = saved; setCurrent(saved); failed.current = false; setError('')
    })}>已核对，重新确认续学</button></div>}
    {paused && !reason && <button className="tbtn primary" disabled={busy || writing || !!error} onClick={() => checkpoint({ paused: false })}>继续本次学习</button>}
    {!paused && current.status === 'active' && <>
      {step.action === 'read' && <blockquote>{point.definition || '尚无核心说明，可以展开原文阅读。'}</blockquote>}
      {written && <><label>{step.action === 'recall' ? '不看说明，我能回忆什么' : '用自己的话解释这个知识点'}<textarea maxLength={10000} disabled={busy || !!error || !!reason} value={note} onChange={(event) => {
        const value = event.target.value; setNote(value)
        persist((record) => ({ ...record, steps: record.steps.map((item, i) => i === index ? { ...item, note: value } : item) }))
      }} /></label>{step.action === 'recall' && <button className="tbtn" disabled={blocked} onClick={() => checkpoint({ hidden: !hidden })}>{hidden ? '显示说明，核对回忆' : '隐藏核心说明开始回忆'}</button>}{!hidden && <blockquote>{point.definition || '尚无核心说明，可以展开原文阅读。'}</blockquote>}</>}
      {step.action === 'practice' && <LearningPractice snapshot={snapshot} pointId={point.id} selectedQuestionKey={current.checkpoint?.questionKey ?? ''} action={action} busy={busy || !!reason || !!error || writing} sessionId={current.id}
        onKnowledge={() => checkpoint({ stepIndex: current.steps.findIndex((item) => item.pointId === point.id && item.action === 'source') })}
        onSelectedQuestion={(questionKey) => checkpoint({ questionKey })} />}
      <details className="learning-section" open={step.action === 'source'}><summary>展开本次保存的原文依据</summary>{point.sourceRefs.map((ref, i) => {
        const archive = snapshot.archives.find((item) => item.id === ref.archiveId); const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end)
        return <div key={i}><strong>{source?.name ?? '原文不可用'}</strong><small>{source?.location}</small><blockquote>{source?.quote}</blockquote></div>
      })}{!point.sourceRefs.length && <p>这是个人整理，尚无归档原文依据。</p>}</details>
      <div className="learning-actions"><button className="tbtn primary" disabled={blocked || written && !note.trim() || step.action === 'practice' && !practiced} onClick={() => persist((value) => advanceSession(value, 'completed', written ? note.trim() : step.note), true)}>完成这一步，下一步</button>
        <button className="tbtn" disabled={blocked} onClick={() => persist((value) => advanceSession(value, 'skipped', written ? note : step.note), true)}>跳过这一步</button>
        <button className="tbtn" disabled={blocked} onClick={() => checkpoint({ paused: true, position: Math.round(region.current?.scrollTop ?? 0) })}>暂停并保存</button></div>
      {step.action === 'source' && <button className="tbtn" disabled={blocked} onClick={() => checkpoint({ stepIndex: Math.max(0, current.steps.findIndex((item) => item.pointId === point.id && item.action === 'practice')) })}>返回本知识点练习</button>}
    </>}
    {error && <button className="tbtn" disabled={writing} onClick={() => { latest.current = session; setCurrent(session); setNote(session.steps[sessionStepIndex(session)]?.note ?? ''); failed.current = false; setError('') }}>重新读取会话</button>}
    {current.status === 'active' && <button className="tbtn" disabled={busy || writing || !!error} onClick={() => persist((value) => ({ ...value, status: 'ended', endedAt: Date.now(), ...(value.checkpoint ? { checkpoint: { ...value.checkpoint, endedReason: 'user' } } : {}) }))}>结束本次学习</button>}
    <p>跳过不计为答错。完成步骤不等于掌握；文字自动保存，冲突时保留当前输入供复制。</p>
  </section>
}
