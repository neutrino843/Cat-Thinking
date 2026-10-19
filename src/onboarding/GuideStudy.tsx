import SourceHelp from '../components/learning/SourceHelp'
import { db } from '../store/db'
import { loadCourseSnapshot, saveEntity } from '../learning/repository'
import { useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { guideRead, guideViewSource, normalizeRecallAnswer, openGuide, pauseGuide, resumeGuide, setGuideAnswer, submitGuideAnswer, useGuide, type FirstQuestion } from './guide'
import { readGuideQuestion } from './guideSource'
import { useOnboarding, onboardingDone, ONBOARDING_ITEMS } from './onboarding'
import StudyDialog from '../components/learning/StudyDialog'
import { StudyModeChoice } from '../components/learning/ExperienceSettings'
import { useExperience } from '../learning/experiencePreferences'

export default function GuideStudy({ onClose, onMaterials, onReplace }: { onClose: () => void; onMaterials: () => void; onReplace: () => void }) {
  const { progress: p, storageError } = useGuide()
  const onboarding = useOnboarding((state) => state.progress)
  const mode = useExperience((state) => state.preferences.study)
  const [readerDocument, setReaderDocument] = useState<{ id: string; name: string; text: string }>()
  const [question, setQuestion] = useState<FirstQuestion | null>(null)
  const [error, setError] = useState('')
  const [rewardError, setRewardError] = useState('')
  const [sourceOpen, setSourceOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const card = useRef<HTMLElement>(null)
  const { docId = '', sourceId = '', courseId = '', sourceHash = '' } = p.binding ?? {}
  const binding = useMemo(() => sourceId ? { docId, sourceId, courseId, sourceHash } : null, [docId, sourceId, courseId, sourceHash])
  useEffect(() => {
    if (!binding) return
    const subscription = liveQuery(async () => ({ question: await readGuideQuestion(binding), source: await db.sources.get(binding.sourceId) })).subscribe({ next: (value) => { setQuestion(value.question); setReaderDocument(value.source); setError('') }, error: (reason: unknown) => { setReaderDocument(undefined); setQuestion(null); setError(reason instanceof Error ? reason.message : '原文暂时无法读取，请稍后继续。') } })
    return () => subscription.unsubscribe()
  }, [binding])
  useEffect(() => { card.current?.focus({ preventScroll: true }) }, [p.step, p.status])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]') || useGuide.getState().expanded) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const submit = async () => {
    if (!binding || !p.answer.trim() || busy) return
    setBusy(true)
    try {
      const current = await readGuideQuestion(binding)
      submitGuideAnswer(normalizeRecallAnswer(p.answer) === normalizeRecallAnswer(current.answer) ? 'match' : 'different', p.sessionId)
      onboardingDone('first-question')
      setQuestion(current); setError('')
      if (useGuide.getState().progress.status === 'completed' && !useGuide.getState().storageError) {
        try { const { course } = await loadCourseSnapshot(binding.courseId)
          if (!course.firstStudyAt && !course.example) await saveEntity({ ...course, firstStudyAt: Date.now() }, course.revision)
        } catch { setRewardError('第一题已完成；学习纪念暂未保存，不影响继续学习。') }
      }
    } catch (reason) { setQuestion(null); setError(reason instanceof Error ? reason.message : '原文核对失败，尚未提交。') }
    finally { setBusy(false) }
  }
  const complete = p.status === 'completed'
  const doneCount = ONBOARDING_ITEMS.filter((item) => onboarding.items[item.id].done).length
  return <main className="focus-study" aria-label="原文入门学习" data-guide-study>
    <header className="focus-study-top">
      <button className="study-text-button" onClick={onClose}>返回学习首页</button>
      <span>新手任务 {doneCount}/{ONBOARDING_ITEMS.length}</span>
      <button className="study-text-button" onClick={() => { onboardingDone('first-question'); onClose() }}>返回清单</button>
      {!complete && <button className="study-text-button" onClick={p.status === 'paused' ? resumeGuide : pauseGuide}>{p.status === 'paused' ? '继续引导' : '暂停并保存'}</button>}
    </header>
    <div className="focus-study-progress"><span>{complete ? '已提交第一题' : p.step === 'read' ? '读一小段' : '完成第一题'}</span><progress max={3} value={complete ? 3 : p.step === 'read' ? 1 : 2} aria-label="入门学习进度"/></div>
    <article ref={card} tabIndex={-1} className="focus-study-card"><div className="focus-perch guide-task-cat" data-isis-perch data-task-perch />
      {rewardError && <p role="status">{rewardError}</p>}
      {storageError && <p role="alert" className="study-alert">{storageError}</p>}
      {error ? <><h1>先检查这份资料</h1><p role="alert">{error}</p><div className="focus-actions"><button className="study-button" onClick={onMaterials}>回到课程资料</button><button className="study-button study-button-primary" onClick={onReplace}>换一份资料</button></div></>
        : !question ? <p role="status">正在读取已保存的原文…</p>
          : p.status === 'paused' ? <><h1>先休息一下</h1><p>步骤和已保存的回答留在本机，准备好再继续。</p><button className="study-button study-button-primary" onClick={resumeGuide}>继续引导</button></>
            : p.step === 'read' ? <section aria-label="引导原文阅读"><p className="focus-muted">来自你导入的资料</p><h1>先读这一小段</h1><blockquote>{question.quote}</blockquote><p>接下来用一道原文填空试着回忆。</p><StudyModeChoice/><button className="study-button study-button-primary" onClick={guideRead}>{mode === 'practice' ? '开始第一题' : '读好了，试着回答'}</button></section>
              : p.step === 'question' ? <section aria-label="第一道入门题"><p className="focus-muted">原文填空 · 填写原词</p><h1>你还记得吗？</h1><p className="focus-question">{question.prompt}</p><form onSubmit={(event) => { event.preventDefault(); void submit() }}><label>填入空缺的原词<input autoComplete="off" maxLength={160} value={p.answer} onChange={(event) => setGuideAnswer(event.target.value)} required/></label><button className="study-button study-button-primary" disabled={busy || !p.answer.trim()}>{busy ? '核对原文中…' : '提交第一题'}</button></form><SourceHelp onViewed={guideViewSource} passages={[{ name: readerDocument?.name ?? '原文', quote: question.quote }]} documents={readerDocument ? [{ ...readerDocument, start: question.start, end: question.end }] : []} /></section>
                : <section aria-label="第一题结果"><p className="focus-muted">第一道题已完成</p><h1>{p.outcome === 'match' ? '和原文一致。' : '一起对照原文。'}</h1><p>原词：<strong>{question.answer}</strong></p><blockquote>{question.quote}</blockquote><p>{p.assisted ? '这次借助原文完成。' : '这次没有在答题步骤回看原文。'}这是一道本地生成的入门题，不计入正式题库，也不代表已掌握知识。</p><div className="focus-actions"><button className="study-button study-button-primary" onClick={onMaterials}>去课程继续学习</button><button className="study-text-button" onClick={onClose}>回到首页</button></div></section>}
    </article>
    <div className="focus-perch" data-isis-perch/>
    <footer className="focus-study-foot"><span>进度保存在本机 · 无需连接 AI</span><button className="study-text-button" onClick={openGuide}>我卡住了，问伊希斯</button></footer>
    {sourceOpen && question && <StudyDialog title="回看原文" onClose={() => setSourceOpen(false)}><blockquote>{question.quote}</blockquote><button className="study-button" onClick={() => setSourceOpen(false)}>回去继续作答</button></StudyDialog>}
  </main>
}
