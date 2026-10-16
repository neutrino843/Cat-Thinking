import { useEffect, useRef, useState } from 'react'
import type { CourseSnapshot, LearningSession } from '../../learning/model'
import { saveEntity } from '../../learning/repository'
import { bindSession, sessionInvalidReason, sessionStepIndex, STEP_LABELS } from '../../learning/session'
import { sameQuestion } from '../../learning/workspaceView'
import { SessionRunner, SESSION_SAVE_ERROR } from '../../learning/sessionRunner'

export { STEP_LABELS }

/**
 * v2.1 需求3：引导学习会话的 React 状态外壳。
 * 串行持久化、冲突熔断在 SessionRunner（框架无关）内完成；
 * 本 hook 只负责 current/note/plannedMinutes 等渲染状态与滚动检查点。
 * ImmersiveLearning（全屏沉浸）消费该行为。
 */
export function useSessionRunner(session: LearningSession, snapshot: CourseSnapshot, busy: boolean) {
  const [current, setCurrent] = useState(session)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState('')
  const [note, setNoteState] = useState(() => session.steps[sessionStepIndex(session)]?.note ?? '')
  const [plannedMinutes, setPlannedMinutes] = useState(session.planning?.minutes ?? 10)
  const [runner] = useState(() => new SessionRunner(session, snapshot))

  const region = useRef<HTMLElement>(null)
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { if (region.current) region.current.scrollTop = session.checkpoint?.position ?? 0 }, [session.id, session.checkpoint?.position])
  useEffect(() => () => clearTimeout(scrollTimer.current), [])

  const track = async (job: Promise<LearningSession | undefined>, afterSave?: (saved: LearningSession) => void) => {
    setWriting(true)
    try {
      const saved = await job
      if (saved) { setCurrent(saved); afterSave?.(saved); return true }
      return false
    } catch {
      setError(SESSION_SAVE_ERROR)
      return false
    } finally {
      setWriting(runner.isWriting)
    }
  }

  const index = sessionStepIndex(current)
  const step = current.steps[index]
  const point = snapshot.points.find((item) => item.id === step?.pointId)
  const reason = sessionInvalidReason(current, snapshot)
  const hidden = current.checkpoint?.hidden ?? step?.action === 'recall'
  const paused = current.checkpoint?.paused === true
  const practiced = !!point && snapshot.attempts.some((attempt) => attempt.sessionId === current.id && attempt.submittedAt !== null
    && point.questionRefs.some((ref) => ref.confirmed && sameQuestion(ref, attempt.question)))
  const blocked = busy || writing || !!error || !!reason || paused || current.status !== 'active'
  const planningValid = Number.isInteger(plannedMinutes) && plannedMinutes >= 0 && plannedMinutes <= 1440
  const statusText = writing ? '正在保存会话…'
    : error ? '文字尚未确认保存'
      : paused ? '已暂停，下次可从首页继续'
        : current.status === 'active' ? '会话与文字已保存'
          : '本次学习已结束，记录已保留'

  const persistNote = (text: string) => { setNoteState(text); void track(runner.writeNote(text)) }
  const savePlanning = () => { void track(runner.setPlanning(plannedMinutes)) }
  const toggleHidden = () => { void track(runner.checkpoint({ hidden: !hidden }, snapshot)) }
  const selectQuestion = (questionKey: string) => { void track(runner.checkpoint({ questionKey }, snapshot)) }
  const goKnowledge = () => { void track(runner.goToPointStep('source', snapshot)) }
  const goPractice = () => { void track(runner.goToPointStep('practice', snapshot)) }
  const advance = (kind: 'completed' | 'skipped') => {
    const text = kind === 'completed' ? note.trim() : note
    void track(runner.step(kind, text), (saved) => {
      clearTimeout(scrollTimer.current)
      if (region.current) region.current.scrollTop = 0
      setNoteState(saved.steps[sessionStepIndex(saved)]?.note ?? '')
    })
  }
  const pause = () => track(runner.checkpoint({ paused: true, position: Math.round(region.current?.scrollTop ?? 0) }, snapshot))
  const resume = () => { void track(runner.checkpoint({ paused: false }, snapshot)) }
  const end = () => { void track(runner.end()) }
  const onScroll = (event: React.UIEvent<HTMLElement>) => {
    if (event.currentTarget.dataset.deskViewport || runner.hasFailed || reason || current.status !== 'active') return
    const position = Math.round(event.currentTarget.scrollTop)
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => { if (runner.latest.checkpoint?.position !== position) void track(runner.checkpoint({ position }, snapshot)) }, 300)
  }
  /** 目标版本/知识变化后的重新绑定（调用方包在 action 中，失败由 action 统一提示）。 */
  const rebind = async (): Promise<void> => {
    const rebound = bindSession(session, snapshot)
    const invalid = sessionInvalidReason(rebound, snapshot)
    if (invalid) throw new Error(invalid)
    const saved = await saveEntity(rebound, session.revision)
    runner.reset(saved); setCurrent(saved); setError('')
  }
  const reload = () => {
    runner.reset(session); setCurrent(session)
    setNoteState(session.steps[sessionStepIndex(session)]?.note ?? '')
    setError('')
  }

  return {
    region, current, index, step, point, reason, hidden, paused, practiced, blocked,
    writing, error, statusText, note, plannedMinutes, planningValid,
    setPlannedMinutes, persistNote, savePlanning, toggleHidden, selectQuestion, goKnowledge, goPractice,
    advance, pause, resume, end, onScroll, rebind, reload,
  }
}

export type SessionRunnerApi = ReturnType<typeof useSessionRunner>
