import SourceHelp from './SourceHelp'
import SegmentedAnswer from './SegmentedAnswer'
import YesterdayNote from './YesterdayNote'
import PagedText from './PagedText'
import { useEffect, useRef, useState } from 'react'
import type { CourseSnapshot, LearningSession } from '../../learning/model'
import type { LearningAction } from './CourseOverview'
import LearningPractice from './LearningPractice'
import { AttemptAnswerReview } from './ExamSessionPanel'
import { questionKey } from '../../learning/workspaceView'
import { STEP_LABELS, useSessionRunner } from './useSessionRunner'
import { useGuide } from '../../onboarding/guide'
import { sourceExcerpt } from '../../learning/workspaceView'

/**
 * v2.1 需求3：沉浸式一体化学习层。
 * 默认使用页面沉浸层；浏览器全屏只在用户主动选择时开启。
 * 三段式：顶部进度 / 中部聚焦卡（单步单任务）/ 底部动作条；会话行为由 useSessionRunner 提供。
 */
export default function ImmersiveLearning({ session, snapshot, action, busy, onExit, onRemediate, onTools, onSchedule }: {
  session: LearningSession; snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onExit: () => void; onRemediate?: (attemptId: string) => void; onSchedule?: (questionKey: string) => void; onTools?: (view: 'knowledge' | 'application' | 'records' | 'backup') => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [practiceWriting, setPracticeWriting] = useState(false)
  const [practiceError, setPracticeError] = useState('')
  const runner = useSessionRunner(session, snapshot, busy)
  const { region, current, index, step, point, reason, hidden, paused, practiced, blocked: runnerBlocked, writing: sessionWriting, error: sessionError, statusText: sessionStatusText,
    note, persistNote, toggleHidden, selectQuestion, goKnowledge, goPractice, advance, pause, resume, end, onScroll, rebind, reload } = runner

  const writing = sessionWriting || practiceWriting
  const error = sessionError || practiceError
  const blocked = runnerBlocked || practiceWriting || !!practiceError
  const statusText = practiceError ? '本题草稿尚未确认保存，请先保留回答' : practiceWriting ? '正在保存本题草稿…' : sessionStatusText

  useEffect(() => {
    const el = root.current
    if (!el) return
    const onChange = () => setIsFullscreen(document.fullscreenElement === el)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  useEffect(() => { card.current?.focus() }, [index, step?.action, current.status])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const topDialog = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1)
      if (event.key !== 'Escape' || event.defaultPrevented || document.fullscreenElement || (topDialog && !topDialog.contains(root.current)) || useGuide.getState().expanded) return
      event.preventDefault()
      if (!busy && !writing && !error) void pause().then((saved) => { if (saved) onExit() })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit, busy, writing, error, pause])

  useEffect(() => {
    if (!writing && !error) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [writing, error])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined)
    else void root.current?.requestFullscreen?.().catch(() => undefined)
  }
  const leave = () => {
    if (busy || writing || error) return
    const exit = () => { if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined); onExit() }
    if (current.status === 'active') void pause().then((saved) => { if (saved) exit() })
    else exit()
  }
  /** 焦点陷阱：沉浸层为 aria-modal，Tab（含 Shift+Tab）循环限制在层内可聚焦控件之间 */
  const trapTab = (event: React.KeyboardEvent) => {
    const topDialog = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1)
    if (event.key !== 'Tab' || !root.current || (topDialog && !topDialog.contains(root.current))) return
    const items = Array.from(root.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((item) => item.offsetParent !== null || item === document.activeElement)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !root.current.contains(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || !root.current.contains(active))) { event.preventDefault(); first.focus() }
  }
  const doneCount = current.steps.filter((item) => item.status !== 'pending').length
  const allDone = current.status === 'completed'
  const ended = current.status !== 'active'
  const written = step?.action === 'recall' || step?.action === 'explain'

  return <div ref={root} className="immersive-learning" data-immersive-learning data-session-id={current.id} data-native-fullscreen={isFullscreen ? 'true' : 'false'}
    role="dialog" aria-modal="true" aria-label="沉浸式学习" tabIndex={-1} onKeyDown={trapTab}>
    <header className="immersive-top">
      <div className="immersive-heading">
        <p className="learning-eyebrow">{snapshot.course.name}</p>
        <h2>{current.title}</h2>
      </div>
      <div className="immersive-top-actions">
        {step && !ended && <span className="immersive-step-count">第 {index + 1} / {current.steps.length} 步 · {STEP_LABELS[step.action]}</span>}
        <button type="button" className="tbtn" onClick={toggleFullscreen}>{isFullscreen ? '退出全屏' : '进入全屏'}</button>
        {!ended && <button type="button" className="tbtn" disabled={busy || writing || !!error} onClick={() => { end(); }}>结束本次学习</button>}
        <button type="button" className="tbtn" disabled={busy || writing || !!error} onClick={leave}>退出沉浸</button>
      </div>
      <progress className="immersive-progress" value={doneCount} max={current.steps.length} aria-label="学习步骤进度" />
    </header>

    <section ref={region} className="immersive-body" onScroll={onScroll} data-step-action={step?.action ?? 'done'}>
      {error && <p role="alert" className="immersive-alert">{error}</p>}
      {reason && <div role="alert" className="immersive-alert"><p>{reason}</p><button type="button" className="tbtn" disabled={busy || writing} onClick={() => void action(async () => { await rebind() })}>已核对，重新确认续学</button></div>}
      {!step || !point ? <article ref={card} className="immersive-card" tabIndex={-1}><h3>会话知识内容不可用</h3><p>请退出沉浸，回到知识结构检查。</p></article>
        : ended ? <article ref={card} className="immersive-card immersive-card-done" tabIndex={-1} data-immersive-done>
          <h3>{allDone ? '本次学习全部完成' : '本次学习已结束'}</h3>
          <p>{current.title} · 已保留 {doneCount} / {current.steps.length} 步记录。完成步骤不等于掌握，可按计划继续复习。</p>
          <h4>接下来做什么</h4><ul>{snapshot.attempts.filter((item) => item.sessionId === current.id).map((attempt) => { const assessment = snapshot.assessments.filter((item) => item.attemptId === attempt.id).at(-1); const schedule = snapshot.schedules.find((item) => item.question.archiveId === attempt.question.archiveId && item.question.artifactId === attempt.question.artifactId && item.question.questionId === attempt.question.questionId); return <li key={attempt.id}>{assessment?.selfAssessmentComplete ? assessment.outcome === 'failure' ? '这道题建议补学。' : '本次作答已记录，稍后再验证。' : '这道简答尚待自评。'}{schedule ? ` 下次复习 ${schedule.dueDate}${schedule.manual ? '（手动）' : ''}` : ' 尚未安排复习日期。'}{!assessment?.selfAssessmentComplete && <AttemptAnswerReview snapshot={snapshot} attemptId={attempt.id} action={action} busy={busy} exam={false} />}<button className="tbtn" onClick={() => onSchedule?.(questionKey(attempt.question))}>设置本题复习日期</button><button className="tbtn" disabled={busy || !assessment?.selfAssessmentComplete} onClick={() => onRemediate?.(attempt.id)}>回原文补学这道题</button></li> })}</ul><p>复习日期可在练习页自行指定；课程自动安排默认关闭。</p><div className="learning-actions">{(['knowledge', 'application', 'records', 'backup'] as const).map((view) => <button className="tbtn" key={view} onClick={() => onTools?.(view)}>{({ knowledge: '目标与知识结构', application: '应用验证任务', records: '本轮学习记录', backup: '备份这门课程' })[view]}</button>)}</div>
          <button type="button" className="tbtn primary" onClick={leave}>退出沉浸学习</button>
        </article>
        : paused ? <article ref={card} className="immersive-card" tabIndex={-1}>
          <h3>已暂停，下次可从首页继续</h3>
          <p>会话与文字均已保存在本机。</p>
          <button type="button" className="tbtn primary" disabled={busy || writing || !!error} onClick={resume}>继续本次学习</button>
        </article>
        : <article ref={card} className="immersive-card" tabIndex={-1}>
          <p className="immersive-step-label">{STEP_LABELS[step.action]}</p>
          <h3>{point.title}</h3>{step.action !== 'practice' && <div className="focus-perch" data-isis-perch data-task-perch />}
          {step.action === 'read' && <PagedText text={point.definition || '尚无核心说明，可以展开原文阅读。'} label="知识说明" />}
          {written && <>{step.action === 'explain' && <p>教伊希斯：用自己的话说清原因，或者举一个例子；写完可回原文核对。</p>}
            <label>{step.action === 'recall' ? '不看说明，我能回忆什么' : '用自己的话解释这个知识点'}
              <SegmentedAnswer label={step.action === 'recall' ? '不看说明，我能回忆什么' : '用自己的话解释这个知识点'} disabled={busy || !!error || !!reason} value={note} onChange={persistNote} />
            </label>
            {step.action === 'recall' && <YesterdayNote note={snapshot.sessions.filter((s) => s.id !== current.id).sort((a, b) => b.updatedAt - a.updatedAt).flatMap((s) => s.steps).find((s) => s.pointId === point.id && s.action === 'explain' && s.status === 'completed')?.note ?? ''} />}
            {step.action === 'recall' && <div className="immersive-card-actions"><button type="button" className="tbtn" disabled={blocked} onClick={toggleHidden}>{hidden ? '显示说明，核对回忆' : '隐藏核心说明开始回忆'}</button></div>}
            {!hidden && <PagedText text={point.definition || '尚无核心说明，可以展开原文阅读。'} label="知识说明" />}
          </>}
          {step.action === 'practice' && <LearningPractice snapshot={snapshot} pointId={point.id} selectedQuestionKey={current.checkpoint?.questionKey ?? ''} action={action} busy={busy || !!reason || !!error || sessionWriting} sessionId={current.id} onWritingChange={setPracticeWriting} onDraftError={setPracticeError} onKnowledge={() => { if (current.steps.some((s) => s.pointId === point.id && s.action === 'source')) goKnowledge(); else { const help = root.current?.querySelector<HTMLElement>('[data-source-help]'); if (help) window.dispatchEvent(new CustomEvent('msz:source-action', { detail: { id: help.dataset.sourceHelp, action: 'related' } })) } }} onSelectedQuestion={selectQuestion} onRemediate={(id) => { if (!blocked) void pause().then((saved) => { if (saved) onRemediate?.(id) }) }} />}
          {step.action !== 'practice' && <SourceHelp documents={point.sourceRefs.flatMap((ref) => { const archive = snapshot.archives.find((a) => a.id === ref.archiveId); const source = archive?.sources.find((s) => s.id === ref.sourceId); return source ? [{ id: `${ref.archiveId}:${source.id}`, name: source.name, text: source.text, start: ref.start, end: ref.end }] : [] })} passages={point.sourceRefs.flatMap((ref) => { const archive = snapshot.archives.find((a) => a.id === ref.archiveId); const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end); return source ? [{ name: source.name, quote: source.quote }] : [] })} />}
          {step.action === 'source' && <div className="immersive-sources">
            {point.sourceRefs.map((ref, i) => {
              const archive = snapshot.archives.find((item) => item.id === ref.archiveId)
              const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end)
              return <div key={i}><strong>{source?.name ?? '原文不可用'}</strong><small>{source?.location}</small><blockquote>{source?.quote}</blockquote></div>
            })}
            {!point.sourceRefs.length && <p>这是个人整理，尚无归档原文依据。</p>}
            {current.steps.some((item) => item.pointId === point.id && item.action === 'practice') ? <button type="button" className="tbtn" disabled={blocked} onClick={goPractice}>返回本知识点练习</button> : <p>这个知识点还没有可用题目。可完成原文核对后继续写下自己的解释，或返回资料选择原文入门练习。</p>}
          </div>}
        </article>}
      <div className="focus-perch" data-isis-perch/>
      {practiceError && !ended && <button type="button" className="tbtn" disabled={writing} onClick={() => { if (window.confirm('本题回答尚未保存，请先复制可复制的未保存回答。确认已自行保留，返回检查？')) void pause().then((saved) => { if (saved) onExit() }) }}>已自行保留文字，返回检查</button>}
      {sessionError && !ended && <button type="button" className="tbtn" disabled={writing} onClick={reload}>重新读取会话</button>}
    </section>

    <footer className="immersive-actions">
      <span className="immersive-status" role="status">{statusText}</span>
      {!ended && !paused && step && point && <span className="immersive-action-buttons">
        <button type="button" className="tbtn" disabled={blocked} onClick={pause}>暂停并保存</button>
        <button type="button" className="tbtn" disabled={blocked} onClick={() => advance('skipped')}>跳过这一步</button>
        <button type="button" className="tbtn primary" disabled={blocked || (written && !note.trim()) || (step.action === 'practice' && !practiced)} onClick={() => advance('completed')}>完成这一步，下一步</button>
      </span>}
    </footer>
  </div>
}
