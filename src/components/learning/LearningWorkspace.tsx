import { useCallback, useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import type { Course, CourseSnapshot } from '../../learning/model'
import { createCourse, listCourses, loadCourseSnapshot } from '../../learning/repository'
import { safeLearningMessage } from '../../learning/workspaceView'
import { resolveKnowledgePointId } from '../../learning/knowledgeGraph'
import { loadDoc } from '../../store/db'
import CourseOverview from './CourseOverview'
import KnowledgeWorkspace from './KnowledgeWorkspace'
import LearningPractice from './LearningPractice'
import ReviewDashboard from './ReviewDashboard'
import LearningDataPanel from './LearningDataPanel'
import LearningRecords from './LearningRecords'
import ImmersiveLearning from './ImmersiveLearning'
import LearningBridge from './LearningBridge'
import JourneyStudy from './JourneyStudy'
import { prepareFreshAnalysis } from '../../learning/freshAnalysis'
import { startFormalSession, startReadingJourney, startRemediationJourney } from '../../learning/learningLoop'
import { useExperience } from '../../learning/experiencePreferences'
import { openDocById } from '../../lib/tabs'
import NodeLearningWorkspace from './NodeLearningWorkspace'

export type LearningView = 'today' | 'knowledge' | 'practice' | 'materials' | 'records' | 'exam' | 'application' | 'backup' | 'prepare' | 'nodes'
export interface LearningTarget { courseId?: string; archiveId?: string; pointId?: string; localDocId?: string; localNodeId?: string; view?: LearningView; questionKey?: string; sessionId?: string; documentId?: string; journeyId?: string; reportSessionId?: string }
type View = LearningView
const VIEWS: { id: View; title: string }[] = [
  { id: 'nodes', title: '节点学习' },
  { id: 'today', title: '学习' }, { id: 'knowledge', title: '知识' }, { id: 'practice', title: '练习' },
  { id: 'materials', title: '资料' }, { id: 'exam', title: '备考' },
]

/** 无课程时各标签页的专属空态（资料页保留原有引导文案） */
const NO_COURSE_COPY: Record<string, { title: string; body: string; localNote?: string }> = {
  today: {
    title: '还没有可学习的课程',
    body: '创建一门课程，把文档加入课程并在 AI 分析中保存学习资料后，今天的学习安排与复习提醒会出现在这里。',
  },
  knowledge: {
    title: '知识图谱还是空的',
    body: '创建课程并保存学习资料后，可在这里整理知识点、定义与题目归属；课程创建后也支持手动新增知识点。',
  },
  practice: {
    title: '暂时没有可练习的内容',
    body: '创建课程并确认知识点与题目后，即可在这里开始练习。作答记录、错因与下次复习日期都会保存在本机。',
  },
  exam: {
    title: '备考需要先有课程',
    body: '创建课程并沉淀题目后，可用已有题库组卷进行模拟练习，交卷后在这里查看备考报告与薄弱环节。',
  },
  materials: {
    title: '先给资料一个归属',
    body: '创建一门课程，再把文档加入课程。在 AI 分析里选择所需内容并保存为学习资料，就可以持续练习和回查。',
    localNote: '这里的阅读、作答、排期和课程备份均在本机完成。',
  },
}
const NO_COURSE_FALLBACK = {
  title: '先创建一门课程',
  body: '课程是资料、知识点、练习与备份的归属。创建课程后，该功能即可使用。',
}

function NoCoursePanel({ view }: { view: View }) {
  const copy = NO_COURSE_COPY[view] ?? NO_COURSE_FALLBACK
  // 课程创建表单在顶部课程栏内保持唯一（label/按钮被既有 e2e 严格定位依赖），
  // 这里的主按钮只负责把用户带到表单，避免重复控件。
  const focusCreateForm = () => {
    document.getElementById('new-learning-course')?.focus()
  }
  return (
    <section className="learning-empty" data-empty-view={view}>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      {copy.localNote && <p>{copy.localNote}</p>}
      <button type="button" className="tbtn learning-empty-cta" onClick={focusCreateForm}>立即创建课程</button>
    </section>
  )
}

export default function LearningWorkspace({ initialTarget, onClose, inline = false }: { initialTarget: LearningTarget; onClose: () => void; inline?: boolean }) {
  const [nodeDirty, setNodeDirty] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [courseId, setCourseId] = useState(initialTarget.courseId ?? '')
  const [snapshot, setSnapshot] = useState<CourseSnapshot>()
  const [view, setView] = useState<View>(initialTarget.view ?? (initialTarget.archiveId || initialTarget.localNodeId ? 'knowledge' : 'today'))
  const [pointId, setPointId] = useState(initialTarget.pointId ?? '')
  const [questionId, setQuestionId] = useState(initialTarget.questionKey ?? '')
  const [examSessionId, setExamSessionId] = useState('')
  /** v2.1 需求3：沉浸式学习会话（首页续学/知识页发起）；退出后回到工作台摘要卡 */
  const [immersiveSessionId, setImmersiveSessionId] = useState(initialTarget.sessionId ?? '')
  const [journeyId, setJourneyId] = useState(initialTarget.journeyId ?? '')
  const [reportSessionId, setReportSessionId] = useState(initialTarget.reportSessionId ?? '')
  const study = useExperience((state) => state.preferences.study)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const actionLock = useRef(false)

  useEffect(() => { if (inline) return; const element = dialog.current; element?.showModal(); return () => element?.close() }, [inline])
  useEffect(() => {
    let live = true
    const subscription = liveQuery(async () => await listCourses()).subscribe({ next: (items) => { if (live) setCourses(items) }, error: (err: unknown) => { if (live) setError(safeLearningMessage(err)) } })
    return () => { live = false; subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (courseId || !courses.length) return
    let live = true
    void (async () => {
      if (initialTarget.archiveId || initialTarget.localDocId) {
        for (const course of courses) {
          const data = await loadCourseSnapshot(course.id)
          if (!live) return
          if (initialTarget.archiveId && data.archives.some((a) => a.id === initialTarget.archiveId)) { setCourseId(course.id); return }
          if (initialTarget.localDocId && initialTarget.localNodeId) {
            const binding = data.bindings.find((b) => b.docId === initialTarget.localDocId && b.status === 'active')
            const map = binding?.mappings.find((m) => m.localNodeId === initialTarget.localNodeId)
            if (map) {
              if (!binding) continue
              const doc = await loadDoc(binding.docId)
              if (!live) return
              const node = doc?.nodes[map.localNodeId]
              if (!node || node.text !== map.originalText || node.note !== map.originalNote || node.richNote !== undefined) { setError('节点内容已变化，请重新确认关联。下面只展示这份资料的准备入口。'); setView('prepare') }
              else setPointId(resolveKnowledgePointId(map.pointId, data.merges))
              setCourseId(course.id); return
            }
          }
        }
        if (initialTarget.localDocId) { for (const course of courses) { const data = await loadCourseSnapshot(course.id); if (!live) return; if (data.documents.some((item) => item.docId === initialTarget.localDocId)) { setCourseId(course.id); setView('prepare'); setError('这个节点还没有确认的知识点关联。可从所属资料继续，不会按同名自动匹配。'); return } } }
        if (live) { setError('此节点还没有已确认的学习资料，请先把这份文档加入课程。'); return }
      }
      if (live) setCourseId(courses[0].id)
    })().catch((err: unknown) => { if (live) setError(safeLearningMessage(err)) })
    return () => { live = false }
  }, [courses, courseId, initialTarget])
  useEffect(() => {
    const token = ++generation.current
    if (!courseId) return
    let live = true
    const subscription = liveQuery(async () => await loadCourseSnapshot(courseId)).subscribe({
      next: (data) => { if (live && token === generation.current) { setSnapshot(data); setLoading(false) } },
      error: (err: unknown) => { if (live && token === generation.current) { setSnapshot(undefined); setLoading(false); setError(safeLearningMessage(err)) } },
    })
    return () => { live = false; subscription.unsubscribe() }
  }, [courseId])

  const action = async (operation: () => Promise<unknown>) => {
    if (actionLock.current) return
    actionLock.current = true
    const token = generation.current
    setBusy(true); setError('')
    try { await operation() } catch (err) { if (token === generation.current) setError(safeLearningMessage(err)) }
    finally { actionLock.current = false; setBusy(false) }
  }
  const chooseCourse = (id: string) => { setView('today'); generation.current++; setBusy(false); setSnapshot(undefined); setLoading(true); setCourseId(id); setPointId(''); setQuestionId(''); setError('') }
  const practice = (point = '', question = '', session = '') => { setPointId(point); setQuestionId(question); setExamSessionId(session); setView('practice') }
  // 稳定引用：沉浸层 Esc 监听依赖该回调，避免父渲染反复重挂 window 监听
  const exitImmersive = useCallback(() => setImmersiveSessionId(''), [])
  const remediate = (attemptId: string, reportId?: string) => void action(async () => {
    if (!snapshot) return
    const journey = await startRemediationJourney(snapshot, attemptId, reportId)
    setJourneyId(journey.id)
  })
  const reading = (docId: string) => void action(async () => { if (snapshot) setJourneyId((await startReadingJourney(snapshot.course.id, docId)).id) })
  const documentId = initialTarget.documentId ?? snapshot?.archives.find((item) => item.id === initialTarget.archiveId)?.originDocId ?? initialTarget.localDocId ?? ''
  const journey = snapshot?.journeys?.find((item) => item.id === journeyId)
  const immersiveSession = snapshot?.sessions.find((item) => item.id === immersiveSessionId && item.purpose !== 'exam')

  const content = <>
    <header className="learning-head"><div><p className="learning-eyebrow">猫思之 · 从资料继续学习</p><h2>课程学习工作台</h2></div><button className="tbtn" disabled={nodeDirty} aria-label={inline ? '返回首页' : '关闭课程学习工作台'} onClick={onClose}>{inline ? '返回首页' : '返回编辑'}</button></header>
    <div className="learning-course-bar"><label>当前课程 <select aria-label="当前课程" value={courseId} onChange={(e) => chooseCourse(e.target.value)} disabled={busy || nodeDirty}>
      {!courses.length && <option value="">尚无课程</option>}{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <form onSubmit={(e) => { e.preventDefault(); void action(async () => { const created = await createCourse({ name: name.trim(), learningMode: 'nodes' }); setName(''); setLoading(true); setCourseId(created.id); setView('nodes') }) }}>
        <label className="sr-only" htmlFor="new-learning-course">新课程名称</label><input id="new-learning-course" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="新课程名称" required />
        <button className="tbtn" disabled={busy || nodeDirty || !name.trim()}>创建课程</button></form></div>
    <nav className="learning-tabs" aria-label="课程功能">{VIEWS.map((item) => <button key={item.id} disabled={nodeDirty} className="tbtn" aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.title}</button>)}<details className="learning-course-menu"><summary>课程操作</summary>{[{ id: 'application', title: '应用任务' }, { id: 'records', title: '记录' }, { id: 'backup', title: '备份' }].map((item) => <button key={item.id} disabled={nodeDirty} className="tbtn" onClick={() => setView(item.id as LearningView)}>{item.title}</button>)}</details></nav>
    <div className="learning-content">
      {error && <p role="alert" className="learning-error">{error}</p>}
      {loading && <p role="status">正在读取学习资料…</p>}
      {!courses.length && !loading && <NoCoursePanel view={view} />}
      {!courses.length && !loading && <LearningDataPanel action={action} busy={busy} onRestored={chooseCourse} />}
      {snapshot && <div key={snapshot.course.id}>
        {(view === 'nodes' || view === 'today' && snapshot.course.learningMode === 'nodes') && <NodeLearningWorkspace snapshot={snapshot} initialPointId={pointId} action={action} busy={busy} onDirtyChange={setNodeDirty} />}
        {snapshot.course.example && (snapshot.attempts.length > 0
          ? <section className="example-course-done" role="status" aria-label="示例课程完成">
              <h3>示例流程已完成</h3>
              <p>你已完成一次完整流程：读 → 测 → 核对原文。现在可以导入自己的资料开始正式学习。</p>
              <button className="tbtn primary" onClick={onClose}>导入我的资料</button>
            </section>
          : <p className="learning-section" role="status">原创示例课程 · 不调用模型，不计入个人学习统计。完成「读 → 测 → 核对原文」后，这里会提示你开始正式学习。</p>)}
        {view === 'prepare' && <LearningBridge snapshot={snapshot} documentId={documentId} archiveId={initialTarget.archiveId} action={action} busy={busy} onReading={() => reading(documentId)} onStart={(id) => void action(async () => setImmersiveSessionId((await startFormalSession(snapshot, id, study === 'practice')).id))} onTools={() => setView('knowledge')} onAnalysis={(fresh) => void action(async () => { const nextId = fresh ? (await prepareFreshAnalysis(snapshot.course.id, documentId, '')).id : documentId; await openDocById(nextId); window.dispatchEvent(new Event('msz:learning-close-for-analysis')) })} />}
        {(view === 'exam' || view === 'today' && snapshot.course.learningMode !== 'nodes') && <ReviewDashboard snapshot={snapshot} exam={view === 'exam'} reportSessionId={reportSessionId} onRemediate={remediate} onJourney={(id) => setJourneyId(id)} onPractice={(point, question, session, reportId) => { if (reportId) setReportSessionId(reportId); if (question?.startsWith('journey:')) { const record = snapshot.journeys?.find((item) => item.id === question.slice(8)); if (record?.mode === 'reading' && record.source) reading(record.source.docId); else setJourneyId(question.slice(8)); return }; practice(point, question, session) }} onKnowledge={(id) => { setPointId(id); setView('knowledge') }} action={action} busy={busy} />}
        {(view === 'knowledge' || view === 'application') && <KnowledgeWorkspace snapshot={snapshot} selectedPointId={pointId} selectedSessionId={initialTarget.sessionId} onSelectPoint={setPointId} onPractice={practice} action={action} busy={busy} applicationOnly={view === 'application'} onStartImmersive={setImmersiveSessionId} />}
        {view === 'practice' && reportSessionId && <button className="tbtn" onClick={() => setView('exam')}>返回原报告</button>}
        {view === 'practice' && <LearningPractice key={`${pointId}:${questionId}:${examSessionId}`} snapshot={snapshot} pointId={pointId} selectedQuestionKey={questionId} sessionId={examSessionId} action={action} busy={busy} onRemediate={remediate} onKnowledge={(id) => { setPointId(id); setView('knowledge') }} onGoToday={() => setView('today')} />}
        {view === 'materials' && <CourseOverview snapshot={snapshot} action={action} busy={busy} onPrepare={(docId, archiveId) => window.dispatchEvent(new CustomEvent('msz:learning-open', { detail: { courseId: snapshot.course.id, documentId: docId, archiveId, view: 'prepare' } }))} onDeleted={() => { setCourseId(''); setSnapshot(undefined) }} />}
        {view === 'records' && <LearningRecords snapshot={snapshot} action={action} busy={busy} onJourney={setJourneyId} onPractice={practice} />}
        {view === 'backup' && <LearningDataPanel snapshot={snapshot} action={action} busy={busy} onRestored={(id) => chooseCourse(id)} />}
      </div>}
    </div>
    <div className="focus-perch" data-isis-perch/>
    <footer className="learning-footer">学习资料与进度保存在当前浏览器。备份课程包可带走资料；重新生成需在 AI 分析里明确发起。</footer>
    {immersiveSession && snapshot && <ImmersiveLearning key={immersiveSession.id} session={immersiveSession} snapshot={snapshot} action={action} busy={busy} onExit={exitImmersive} onRemediate={remediate} onSchedule={(key) => { setImmersiveSessionId(''); practice('', key) }} onTools={(view) => { setImmersiveSessionId(''); setView(view) }} />}
    {snapshot && journey && <JourneyStudy key={journeyId} journey={journey} snapshot={snapshot} action={action} busy={busy} onExit={(reportId) => { setJourneyId(''); if (reportId) { setReportSessionId(reportId); setView('exam') } }} />}
  </>
  return inline ? <section className="learning-workspace learning-workspace-inline" data-learning-workspace role="region" aria-label="课程学习工作台">{content}</section>
    : <dialog ref={dialog} className="learning-workspace" data-learning-workspace aria-label="课程学习工作台" onCancel={(event) => { if (immersiveSession || journeyId || nodeDirty) { event.preventDefault(); return }; onClose() }}>{content}</dialog>
}
