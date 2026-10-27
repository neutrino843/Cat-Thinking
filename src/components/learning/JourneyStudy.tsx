import SourceHelp from './SourceHelp'
import SegmentedAnswer from './SegmentedAnswer'
import YesterdayNote from './YesterdayNote'
import PagedText from './PagedText'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { LearningError, type CourseSnapshot, type LearningJourney } from '../../learning/model'
import { completeJourney, journeySource, readingExcerpt, saveJourney, resumeJourney } from '../../learning/learningLoop'
import { addLearningDays, learningDate } from '../../learning/reviewScheduler'
import { questionKey, safeLearningMessage } from '../../learning/workspaceView'
import LearningPractice from './LearningPractice'
import type { LearningAction } from './CourseOverview'
import { useLearningClock } from './useLearningClock'

/** A native top-layer keeps the course, report and map mounted underneath. */
export default function JourneyStudy({ journey, snapshot, autoResume, busy, readBlocked, canWrite, onReload, onExit }: {
  journey: LearningJourney; snapshot: CourseSnapshot; autoResume: boolean; action: LearningAction; busy: boolean; readBlocked: boolean; canWrite: () => boolean; onReload: () => Promise<CourseSnapshot>; onExit: (reportId?: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const latest = useRef(journey)
  const initialJourney = useRef(journey)
  const resumeOnMount = useRef(autoResume)
  const now = useLearningClock()
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const failed = useRef(false)
  const operationLock = useRef(false)
  const [operationBusy, setOperationBusy] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [current, setCurrent] = useState(journey)
  const [writing, setWriting] = useState(false)
  const [practiceWriting, setPracticeWriting] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(journey.status === 'completed')
  const [practiceError, setPracticeError] = useState('')
  const [source, setSource] = useState<{ text: string; name: string }>()
  const [date, setDate] = useState('')
  const [automatic, setAutomatic] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [storedVersion, setStoredVersion] = useState<LearningJourney>()
  const [preservedDraft, setPreservedDraft] = useState<{ note: string; step: number; position: number; date: string }>()
  const [needsDraftSave, setNeedsDraftSave] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState('')
  useEffect(() => { if (!resumeOnMount.current) return; let live = true; void resumeJourney(initialJourney.current).then((saved) => { if (live) { latest.current = saved; setCurrent(saved); setReady(true) } }).catch((err) => { if (live) setError(safeLearningMessage(err)) }); return () => { live = false } }, [])
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  useEffect(() => {
    if (ready && journey.revision > latest.current.revision && !pending.current && !finishing) {
      failed.current = true; setError('已保存的进度发生变化，请重新读取并比较；本页输入仍保留。')
    }
  }, [journey, ready, finishing])
  useEffect(() => {
    const subscription = liveQuery(() => journeySource(latest.current, snapshot)).subscribe({ next: setSource, error: (err: unknown) => { setSource(undefined); setError(safeLearningMessage(err)) } })
    return () => subscription.unsubscribe()
  }, [snapshot])
  useEffect(() => { if (region.current) region.current.scrollTop = latest.current.scroll }, [current.step, current.position]) // Saved scroll only restores on entering a step.
  useEffect(() => {
    if (!writing && !practiceWriting && !error && !practiceError && !readBlocked && !needsDraftSave && !preservedDraft) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard)
  }, [writing, practiceWriting, error, practiceError, readBlocked, needsDraftSave, preservedDraft])
  const update = (patch: Partial<LearningJourney>) => {
    if (!ready || failed.current || finishing || readBlocked || !canWrite() || needsDraftSave || latest.current.status === 'completed') return
    setCurrent((previous) => ({ ...previous, ...patch })); pending.current++; setWriting(true)
    queue.current = queue.current.then(async () => {
      if (failed.current) return
      if (!canWrite()) throw new LearningError('conflict', '读取尚未核对，已暂停后续保存；本页输入仍保留。')
      latest.current = await saveJourney({ ...latest.current, ...patch })
      if (pending.current === 1) setCurrent(latest.current)
    }).catch((err) => { failed.current = true; setError(safeLearningMessage(err)) }).finally(() => { pending.current--; if (!pending.current) setWriting(false) })
  }
  const blocked = busy || readBlocked || operationBusy || writing || practiceWriting || finishing || needsDraftSave || !!error || !!practiceError || !source || !ready
  const practiceAction: LearningAction = async (job) => { if (operationLock.current || readBlocked || !canWrite()) return; operationLock.current = true; setOperationBusy(true); setOperationError(''); try { await job() } catch (err) { setOperationError(safeLearningMessage(err)) } finally { operationLock.current = false; setOperationBusy(false) } }
  const leave = async () => {
    if (blocked || !canWrite()) return
    if (latest.current.status !== 'completed') {
      try { setFinishing(true); latest.current = await saveJourney({ ...latest.current, status: 'paused', scroll: Math.round(region.current?.scrollTop ?? 0) }) }
      catch (err) { setError(safeLearningMessage(err)); return }
      finally { setFinishing(false) }
    }
    onExit(latest.current.originSessionId)
  }
  const finish = async () => {
    if (blocked || !canWrite()) return
    setFinishing(true)
    try { const saved = await completeJourney(latest.current, date || undefined, automatic); latest.current = saved; setCurrent(saved) }
    catch (err) { setError(safeLearningMessage(err)) }
    finally { setFinishing(false) }
  }
  const reload = async () => {
    if (writing || practiceWriting || finishing || operationLock.current) return
    operationLock.current = true; setOperationBusy(true); setRecoveryMessage('')
    try {
      await queue.current
      const data = await onReload()
      const actual = data.journeys?.find((item) => item.id === latest.current.id)
      if (!actual) throw new LearningError('missing', '这轮学习已被删除；本页文字仍可复制或下载，不能继续保存。')
      const checkedSource = await journeySource(actual, data)
      setSource(checkedSource)
      if (actual.revision !== latest.current.revision) {
        setStoredVersion(actual); failed.current = true
        setError('已保存的进度与本页版本不同。请比较后明确选择，本次没有覆盖或自动提交。')
        return
      }
      latest.current = actual; failed.current = false; setError(''); setStoredVersion(undefined)
      setNeedsDraftSave(current.note !== actual.note || current.step !== actual.step || current.position !== actual.position || current.scroll !== actual.scroll)
      setRecoveryMessage('已重新核对进度和原文。本次只读取，没有自动恢复、保存或完成。')
    } catch (err) { failed.current = true; setError(safeLearningMessage(err)) }
    finally { operationLock.current = false; setOperationBusy(false) }
  }
  const adoptStoredVersion = (keepNote: boolean) => {
    if (!storedVersion) return
    setPreservedDraft({ note: current.note, step: current.step, position: current.position, date })
    latest.current = storedVersion
    setCurrent(keepNote ? { ...storedVersion, note: current.note, position: current.position, step: current.step, scroll: current.scroll } : storedVersion)
    setReady(storedVersion.status === 'completed' || storedVersion.status === 'active' && storedVersion.planning?.date === learningDate(now, snapshot.course.timeZone))
    setNeedsDraftSave(keepNote); failed.current = false; setError(''); setStoredVersion(undefined)
    setRecoveryMessage(keepNote ? '保留了本页草稿，请明确保存。采用前的文字也保留在下方。' : '已采用保存的进度，采用前的本页文字仍保留在下方。')
  }
  const recover = async (saveDraft: boolean) => {
    if (operationLock.current || writing || practiceWriting || finishing || readBlocked || !canWrite()) return
    operationLock.current = true; setOperationBusy(true)
    try {
      const saved = saveDraft
        ? await saveJourney({ ...latest.current, note: current.note, step: current.step, position: current.position, scroll: current.scroll })
        : await resumeJourney(latest.current)
      latest.current = saved
      setCurrent(saveDraft ? saved : { ...saved, note: current.note, step: current.step, position: current.position, scroll: current.scroll })
      setReady(true); failed.current = false; setError('')
      if (saveDraft) setNeedsDraftSave(false)
      setRecoveryMessage(saveDraft ? '本页草稿已保存；尚未自动完成本轮。' : '已恢复这轮学习；本次没有自动完成。')
    } catch (err) { failed.current = true; setError(safeLearningMessage(err)) }
    finally { operationLock.current = false; setOperationBusy(false) }
  }
  const excerpt = source && readingExcerpt(source.text, current.position)
  const retry = snapshot.attempts.find((item) => item.id === current.retryAttemptId)
  const assessment = retry && snapshot.assessments.filter((item) => item.attemptId === retry.id).at(-1)
  const schedule = snapshot.schedules.find((item) => current.questionRef && questionKey(item.question) === questionKey(current.questionRef))
  const archive = snapshot.archives.find((item) => item.id === current.questionRef?.archiveId && item.contentHash === current.archiveHash)
  const artifact = archive?.artifacts.find((item) => item.id === current.questionRef?.artifactId)
  const question = artifact?.kind === 'quiz' ? artifact.payload.questions.find((item) => item.id === current.questionRef?.questionId) : undefined
  const readerDocuments = current.mode === 'reading' && source ? [{ id: current.source?.sourceId ?? current.id, name: source.name, text: source.text }] : (archive?.sources.filter((source) => question?.citations.some((c) => c.provenance === 'source' && c.sourceId === source.id)).map((source) => ({ id: source.id, name: source.name, text: source.text })) ?? [])
  const done = current.status === 'completed'
  const labels = current.mode === 'reading' ? ['读一小段', '写下理解', '安排回看'] : ['回到依据', '修正理解', '重试与安排']
  return <dialog ref={dialog} className="journey-study" data-learning-stage={done ? 'round-end' : current.mode === 'reading' ? 'reading' : 'remediation'} data-journey-id={current.id} data-journey-step={current.step} aria-label={current.mode === 'reading' ? '原文阅读学习' : '原文补学'}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); void leave() }} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}>
    <header className="immersive-top"><div><p className="learning-eyebrow">{snapshot.course.name} · 本机保存</p><h2>{current.title}</h2></div><button className="tbtn" disabled={blocked} onClick={() => void leave()}>{done ? current.originSessionId ? '返回原报告' : '返回课程' : '暂停并返回'}</button><progress value={done ? 3 : current.step} max={3} aria-label="本轮进度" /></header>
    <div ref={region} className="immersive-body">
      <article className="immersive-card">{!(current.mode === 'remediation' && current.step === 2) && <div className="focus-perch" data-isis-perch data-task-perch />}
        {operationError && <p role="alert">{operationError}</p>}
        {practiceError && <p role="alert">{practiceError} 请保留本题文字，重新读取前不要退出。</p>}
        {(error || practiceError || readBlocked || needsDraftSave || !ready) && <div role="alert"><p>{error || practiceError || (readBlocked ? '学习资料读取尚未核对，已暂停保存。' : !ready ? '这轮学习尚未恢复。' : '本页还有尚未保存的草稿。')}</p><p>笔记、步骤和本次所选日期仍保留。重新读取只核对进度与原文，不会自动提交。</p><textarea aria-label="可复制的当前笔记" readOnly value={current.note} /><button className="tbtn" disabled={writing || practiceWriting || finishing || busy || operationBusy} onClick={() => void reload()}>重新读取并核对</button>{!ready && !error && !readBlocked && <button className="tbtn" disabled={operationBusy} onClick={() => void recover(false)}>恢复这轮学习</button>}{needsDraftSave && ready && !error && !readBlocked && <button className="tbtn" disabled={operationBusy} onClick={() => void recover(true)}>保存本页草稿</button>}<button className="tbtn" disabled={writing || busy} onClick={() => { const blob = new Blob([current.note], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = '学习笔记.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000) }}>下载当前笔记</button><button className="tbtn" disabled={writing || busy || finishing || operationBusy} onClick={() => { if (window.confirm('尚未保存的笔记和本题回答请先下载或复制。确认已自行保留，返回检查？')) onExit(current.originSessionId) }}>已自行保留文字，返回检查</button></div>}
        {storedVersion && <section aria-label="比较已保存的进度"><p>已保存的进度 · 第 {Math.min(storedVersion.step + 1, 3)} 步 · {storedVersion.status === 'completed' ? '已完成' : storedVersion.status === 'paused' ? '已暂停' : '进行中'} · 日期 {storedVersion.dueDate || '未安排'}</p><textarea aria-label="已保存版本的笔记" readOnly value={storedVersion.note}/><button className="tbtn" onClick={() => adoptStoredVersion(false)}>采用已保存进度</button>{storedVersion.status !== 'completed' && <button className="tbtn" onClick={() => adoptStoredVersion(true)}>保留本页草稿，稍后明确保存</button>}</section>}
        {preservedDraft && <section aria-label="采用前保留的草稿"><p>采用前的第 {preservedDraft.step + 1} 步 · 阅读位置 {preservedDraft.position} · 本次日期 {preservedDraft.date || '未选择'}</p><textarea aria-label="采用前保留的笔记" readOnly value={preservedDraft.note}/></section>}
        {recoveryMessage && <p role="status">{recoveryMessage}</p>}
        {done ? <><h3>本轮已记录</h3><p>{current.mode === 'reading' ? '阅读与个人理解已保存为个人知识点，尚未进行正式测验。' : assessment?.outcome === 'failure' || assessment?.difficulty === 'again' ? '重试仍需补学，原回答与本次重试分别保留。' : '小小结案：本次修正与重试已保存，等待日后独立验证。看过依据后的回答不算独立掌握。'}</p><blockquote>{current.note}</blockquote><p>{current.mode === 'reading' ? current.dueDate ? `回看资料：${current.dueDate}，当天会回到首页安排。` : '未新增回看日期，可从课程记录再次打开。' : schedule ? `下次复习：${schedule.dueDate}${schedule.manual ? '（你手动指定的日期）' : ''} · ${schedule.status === 'remediation' ? '需要继续补学' : '待复习'}` : '未新增自动复习；可自行选择日期后练习。'}</p></>
          : <><p className="immersive-step-label">第 {current.step + 1} / 3 步 · {labels[current.step]}</p>
            {current.step === 0 && <><h3>{source?.name ?? '正在核对原文…'}</h3><PagedText key={`${current.position}:${current.step}`} text={excerpt?.quote ?? ''} label="阅读原文" /><p>{current.mode === 'reading' ? '一次读一点，接下来用自己的话记下理解。' : '对照真实原文寻找原因，再写下修正并重新回答。'}</p>{excerpt?.hasNext && <button className="tbtn" disabled={blocked} onClick={() => update({ position: excerpt.end, scroll: 0 })}>再读下一段</button>}</>}
            {current.step === 1 && <><p className="focus-muted">教伊希斯：试着说清楚它是什么、为什么，或举一个自己的例子。伊希斯暂不自动评分。</p><label>{current.mode === 'reading' ? '我读懂了什么' : '我需要修正的地方'}<SegmentedAnswer label={current.mode === 'reading' ? '我读懂了什么' : '我需要修正的地方'} value={current.note} disabled={busy || finishing || !ready || !!error || readBlocked || needsDraftSave} onChange={(value) => update({ note: value })} /></label><YesterdayNote note={(snapshot.journeys ?? []).filter((item) => item.id !== current.id && item.status === 'completed' && !!current.source && item.source?.sourceHash === current.source.sourceHash).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.note ?? ''} /></>}
            {current.step === 2 && <>
              {current.mode === 'remediation' && current.questionRef && <LearningPractice key={current.id} snapshot={snapshot} pointId="" selectedQuestionKey={questionKey(current.questionRef)} action={practiceAction} busy={busy || readBlocked || operationBusy || writing || finishing || !!error || !ready} onKnowledge={() => update({ step: 0, scroll: 0 })} journey={current} onWritingChange={setPracticeWriting} onDraftError={setPracticeError} />}
              <div className="learning-section"><h3>{current.mode === 'reading' ? '下次什么时候回看？' : '保留怎样的复习安排？'}</h3><p>不选日期就不新增安排。手动日期优先；本轮完成不会自动开启课程的自动复习。</p>{schedule?.manual && <p>已有手动日期 {schedule.dueDate}，将保留。</p>}<label>下次日期（可不选）<input type="date" min={addLearningDays(learningDate(now, snapshot.course.timeZone), 1)} value={date} disabled={blocked || !!schedule?.manual} onChange={(event) => setDate(event.target.value)} /></label>{current.mode === 'remediation' && snapshot.course.automaticReviews && <label className="learning-option"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} disabled={blocked || !!schedule?.manual} />使用课程已开启的自动安排</label>}</div>
            </>}
          </>}
      {source && !(current.mode === 'remediation' && current.step === 2) && <SourceHelp documents={readerDocuments} passages={excerpt ? [{ name: source.name, quote: excerpt.quote }] : []} />}
      </article><div className="focus-perch" data-isis-perch />
    </div>
    <footer className="immersive-actions"><span role="status">{writing || practiceWriting || finishing ? '正在保存，请稍候…' : error || practiceError || readBlocked || needsDraftSave || !ready ? '等待核对或处理提示' : '进度已保存在本机'}</span>{!done && (current.step < 2 ? <button className="tbtn primary" disabled={blocked || current.step === 1 && !current.note.trim()} onClick={() => update({ step: current.step + 1, scroll: 0 })}>继续下一步</button> : <button className="tbtn primary" disabled={blocked || current.mode === 'remediation' && !assessment?.selfAssessmentComplete} onClick={() => void finish()}>完成本轮并保存安排</button>)}{done && <button className="tbtn primary" disabled={blocked} onClick={() => void leave()}>{current.originSessionId ? '返回原报告' : '返回课程继续学习'}</button>}</footer>
  </dialog>
}
