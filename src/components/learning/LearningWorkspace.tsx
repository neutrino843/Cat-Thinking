import { useEffect, useRef, useState } from 'react'
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

export interface LearningTarget { courseId?: string; archiveId?: string; pointId?: string; localDocId?: string; localNodeId?: string }
type View = 'today' | 'knowledge' | 'practice' | 'materials' | 'records' | 'exam' | 'application' | 'backup'
const VIEWS: { id: View; title: string }[] = [
  { id: 'today', title: '今日' }, { id: 'knowledge', title: '知识' }, { id: 'practice', title: '练习' },
  { id: 'materials', title: '资料' }, { id: 'records', title: '记录' }, { id: 'exam', title: '备考' },
  { id: 'application', title: '应用' }, { id: 'backup', title: '备份' },
]

export default function LearningWorkspace({ initialTarget, onClose }: { initialTarget: LearningTarget; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [courseId, setCourseId] = useState(initialTarget.courseId ?? '')
  const [snapshot, setSnapshot] = useState<CourseSnapshot>()
  const [view, setView] = useState<View>(initialTarget.archiveId || initialTarget.localNodeId ? 'knowledge' : 'today')
  const [pointId, setPointId] = useState(initialTarget.pointId ?? '')
  const [questionId, setQuestionId] = useState('')
  const [examSessionId, setExamSessionId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const actionLock = useRef(false)

  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
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
              if (!node || node.text !== map.originalText || node.note !== map.originalNote || node.richNote !== undefined) setError('节点内容已变化，请在知识页重新确认关联。')
              else setPointId(resolveKnowledgePointId(map.pointId, data.merges))
              setCourseId(course.id); return
            }
          }
        }
        if (live) setError('此节点还没有已确认的学习资料。请在 AI 分析中保存学习资料，或在知识页手动建立知识点。')
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
  const chooseCourse = (id: string) => { generation.current++; setBusy(false); setSnapshot(undefined); setLoading(true); setCourseId(id); setPointId(''); setQuestionId(''); setError('') }
  const practice = (point = '', question = '', session = '') => { setPointId(point); setQuestionId(question); setExamSessionId(session); setView('practice') }

  return <dialog ref={dialog} className="learning-workspace" data-learning-workspace aria-label="课程学习工作台" onCancel={onClose}>
    <header className="learning-head"><div><p className="learning-eyebrow">猫思之 · 从资料继续学习</p><h2>课程学习工作台</h2></div><button className="tbtn" aria-label="关闭课程学习工作台" onClick={onClose}>返回编辑</button></header>
    <div className="learning-course-bar"><label>当前课程 <select aria-label="当前课程" value={courseId} onChange={(e) => chooseCourse(e.target.value)} disabled={busy}>
      {!courses.length && <option value="">尚无课程</option>}{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <form onSubmit={(e) => { e.preventDefault(); void action(async () => { const created = await createCourse({ name: name.trim() }); setName(''); setLoading(true); setCourseId(created.id) }) }}>
        <label className="sr-only" htmlFor="new-learning-course">新课程名称</label><input id="new-learning-course" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="新课程名称" required />
        <button className="tbtn" disabled={busy || !name.trim()}>创建课程</button></form></div>
    <nav className="learning-tabs" aria-label="课程功能">{VIEWS.map((item) => <button key={item.id} className="tbtn" aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.title}</button>)}</nav>
    <div className="learning-content">
      {error && <p role="alert" className="learning-error">{error}</p>}
      {loading && <p role="status">正在读取学习资料…</p>}
      {!courses.length && !loading && <section className="learning-empty"><h3>先给资料一个归属</h3><p>创建一门课程，再把文档加入课程。在 AI 分析里选择所需内容并保存为学习资料，就可以持续练习和回查。</p><p>这里的阅读、作答、排期和课程备份均在本机完成。</p></section>}
      {snapshot && <div key={snapshot.course.id}>
        {(view === 'today' || view === 'exam') && <ReviewDashboard snapshot={snapshot} exam={view === 'exam'} onPractice={practice} onKnowledge={(id) => { setPointId(id); setView('knowledge') }} action={action} busy={busy} />}
        {(view === 'knowledge' || view === 'application') && <KnowledgeWorkspace snapshot={snapshot} selectedPointId={pointId} onSelectPoint={setPointId} onPractice={practice} action={action} busy={busy} applicationOnly={view === 'application'} />}
        {view === 'practice' && <LearningPractice key={`${pointId}:${questionId}:${examSessionId}`} snapshot={snapshot} pointId={pointId} selectedQuestionKey={questionId} sessionId={examSessionId} action={action} busy={busy} onKnowledge={(id) => { setPointId(id); setView('knowledge') }} />}
        {view === 'materials' && <CourseOverview snapshot={snapshot} action={action} busy={busy} onDeleted={() => { setCourseId(''); setSnapshot(undefined) }} />}
        {view === 'records' && <LearningRecords snapshot={snapshot} action={action} busy={busy} onPractice={practice} />}
        {view === 'backup' && <LearningDataPanel snapshot={snapshot} action={action} busy={busy} onRestored={(id) => chooseCourse(id)} />}
      </div>}
    </div>
    <footer className="learning-footer">学习资料与进度保存在当前浏览器。备份课程包可带走资料；重新生成需在 AI 分析里明确发起。</footer>
  </dialog>
}
