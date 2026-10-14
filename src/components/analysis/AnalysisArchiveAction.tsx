import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { createCourse, createLearningArchive, listCourses } from '../../learning/repository'
import type { Course, LearningArchive } from '../../learning/model'
import { loadQuizPractice } from '../../analysis/quizPractice'

export default function AnalysisArchiveAction({ docId, runId, artifacts, disabled, bindingKey, onClose }: {
  docId: string; runId: string; artifacts: ArtifactEnvelopeV1[]; disabled: boolean; bindingKey: string; onClose: () => void
}) {
  const [courses, setCourses] = useState<Course[]>([])
  const [courseId, setCourseId] = useState('')
  const [newName, setNewName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<LearningArchive>()
  const generation = useRef(0)
  const writing = useRef(false)
  useLayoutEffect(() => { const epoch = generation; epoch.current++; return () => { epoch.current++ } }, [bindingKey])
  useEffect(() => {
    let active = true
    void listCourses().then((items) => { if (active) { setCourses(items); setCourseId(items[0]?.id ?? ''); setLoading(false) } })
      .catch(() => { if (active) { setError('课程读取失败，请先打开今日学习重新载入。'); setLoading(false) } })
    return () => { active = false }
  }, [])
  const save = async () => {
    if (disabled || loading || writing.current || !artifacts.length || !courseId && !newName.trim()) return
    const token = generation.current
    writing.current = true; setBusy(true); setError('')
    try {
      const course = courseId ? courses.find((item) => item.id === courseId) : await createCourse({ name: newName.trim() })
      if (!course || token !== generation.current) return
      const titled = artifacts.find((artifact) => 'title' in artifact.payload)
      const archive = await createLearningArchive({ courseId: course.id, docId, runId, artifacts,
        ...(titled && 'title' in titled.payload ? { title: titled.payload.title } : {}) })
      const quiz = artifacts.find((artifact) => artifact.kind === 'quiz')
      // Import only the genuine current submitted record, with unknown legacy time explicitly preserved.
      let practiceWarning = ''
      if (quiz?.kind === 'quiz') {
        try { await loadQuizPractice({ docId, runId, artifact: quiz }) }
        catch { practiceWarning = '资料已保存，但当前练习记录尚未导入。请重新读取练习并核对本地记录，已有历史保持原样。' }
      }
      if (token === generation.current) { setSaved(archive); setError(practiceWarning); if (!courseId) { setCourses((items) => [...items, course]); setCourseId(course.id) } }
    } catch (failure) { if (token === generation.current) setError(failure instanceof Error ? failure.message : '归档失败，请重新读取结果。') }
    finally { writing.current = false; if (token === generation.current) setBusy(false) }
  }
  return <section className="analysis-knowledge-practice" aria-label="保存学习资料">
    <h3>把这次学习保存到课程</h3>
    <p>保存原文快照和已有结果，继续积累作答、补学与复习记录。归档和查看不会新增模型调用。</p>
    {loading ? <p role="status">正在读取课程…</p> : <div className="analysis-actions">
      {courses.length > 0 && <label>归属课程 <select aria-label="归属课程" value={courseId} disabled={busy || disabled} onChange={(event) => { setCourseId(event.target.value); setSaved(undefined) }}>
        {courses.map((course) => <option value={course.id} key={course.id}>{course.name}</option>)}<option value="">创建新课程</option>
      </select></label>}
      {!courseId && <label>课程名称 <input aria-label="新课程名称" maxLength={200} value={newName} disabled={busy || disabled} onChange={(event) => setNewName(event.target.value)} placeholder="例如：电路原理" /></label>}
      <button className="tbtn primary" disabled={disabled || busy || !artifacts.length || !courseId && !newName.trim()} onClick={() => void save()}>{busy ? '正在保存学习归档…' : '保存到课程'}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">学习资料已归档。<button className="tbtn" onClick={() => {
      onClose(); window.dispatchEvent(new CustomEvent('msz:learning-open', { detail: { courseId: saved.courseId, archiveId: saved.id } }))
    }}>进入课程继续学习</button></p>}
  </section>
}
