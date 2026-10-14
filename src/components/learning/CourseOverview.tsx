import { useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import type { CourseSnapshot } from '../../learning/model'
import { attachDocument, detachDocument, deleteCourseOrganisation, deleteLearningArchive, saveEntity } from '../../learning/repository'
import { listDocs } from '../../store/db'
import type { DocMeta } from '../../types'
import { openDocById } from '../../lib/tabs'
import { learningDate } from '../../learning/reviewScheduler'
import { useLearningClock } from './useLearningClock'
import ArchiveDetails from './ArchiveDetails'
import CourseGoals from './CourseGoals'
import LearningSupportPanel from './LearningSupportPanel'
import { prepareFreshAnalysis } from '../../learning/freshAnalysis'

export type LearningAction = (operation: () => Promise<unknown>) => Promise<void>
export default function CourseOverview({ snapshot, action, busy, onDeleted }: { snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onDeleted: () => void }) {
  const course = snapshot.course
  const now = useLearningClock()
  const [goal, setGoal] = useState(course.goal)
  const [minutes, setMinutes] = useState(course.dailyMinutes)
  const [limit, setLimit] = useState(course.dailyQuestionLimit)
  const [examDate, setExamDate] = useState(course.examDate ?? '')
  const [revision, setRevision] = useState(course.revision)
  const [automatic, setAutomatic] = useState(course.automaticReviews ?? false)
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [docId, setDocId] = useState('')
  const [chapter, setChapter] = useState('')
  const [deleteMode, setDeleteMode] = useState(false)
  const [deleteArchiveId, setDeleteArchiveId] = useState('')
  useEffect(() => { const subscription = liveQuery(async () => await listDocs()).subscribe(setDocs); return () => subscription.unsubscribe() }, [])
  const reload = () => { setGoal(course.goal); setMinutes(course.dailyMinutes); setLimit(course.dailyQuestionLimit); setExamDate(course.examDate ?? ''); setAutomatic(course.automaticReviews ?? false); setRevision(course.revision) }
  return <section><h3>课程资料与目标</h3>
    <p>将文档加入课程不会复制文档。移出课程保留原文档；分析范围仍由你在 AI 分析中选择。</p>
    <form className="learning-form" onSubmit={(e) => { e.preventDefault(); void action(async () => {
      const saved = await saveEntity({ ...course, goal, goalVersion: goal === course.goal ? course.goalVersion : course.goalVersion + 1, dailyMinutes: minutes, dailyQuestionLimit: limit, automaticReviews: automatic, ...(examDate ? { examDate } : { examDate: undefined }) }, revision)
      setRevision(saved.revision)
    }) }}>
      <label>学习目标<textarea maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
      <div className="learning-fields"><label>每天可用分钟<input type="number" min={1} max={480} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} required /></label>
        <label>每天题数上限<input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Number(e.target.value))} required /></label>
        <label>考试日期 可选<input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} /></label></div>
      <p>时区 {course.timeZone} · 今天 {learningDate(now, course.timeZone)} · 目标版本 {course.goalVersion}</p>
      <label className="learning-option"><input type="checkbox" checked={automatic} onChange={(e) => setAutomatic(e.target.checked)} />启用本地自动复习日期建议</label><p>根据已提交回答建议 1、3、7、14 天间隔。手动日期优先；不调用模型，也不更改已有手动安排。</p>
      {revision !== course.revision && <p role="status">设置有其他更新。保存会检查版本，或先重新读取。</p>}
      <div className="learning-actions"><button className="tbtn" disabled={busy}>保存学习设置</button><button className="tbtn" type="button" disabled={busy} onClick={reload}>重新读取设置</button></div>
    </form>
    <CourseGoals snapshot={snapshot} action={action} busy={busy} />
    <LearningSupportPanel snapshot={snapshot} pointIds={[]} action={action} busy={busy} />
    <h4>加入已有文档</h4>
    <form className="learning-fields" onSubmit={(e) => { e.preventDefault(); void action(async () => { await attachDocument(course.id, docId, chapter); setDocId(''); setChapter('') }) }}>
      <label>文档<select value={docId} onChange={(e) => setDocId(e.target.value)} required><option value="">选择文档</option>{docs.filter((doc) => !snapshot.documents.some((r) => r.docId === doc.id)).map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
      <label>归属章节<input value={chapter} maxLength={120} onChange={(e) => setChapter(e.target.value)} placeholder="可暂存，稍后整理" /></label><button className="tbtn" disabled={busy || !docId}>加入课程</button>
    </form>
    <ul className="learning-list">{snapshot.documents.map((record) => { const doc = snapshot.docs.find((item) => item.id === record.docId); return <li key={record.id}>
      <strong>{doc?.title ?? '原文档已删除'}</strong><span>{record.chapter || '暂存区'}</span><div className="learning-actions">
        <label>资料角色<select value={record.role ?? 'notes'} disabled={busy} onChange={(event) => void action(() => saveEntity({ ...record, role: event.target.value as 'syllabus' | 'slides' | 'textbook' | 'notes' }, record.revision))}><option value="syllabus">教学大纲</option><option value="slides">教师课件</option><option value="textbook">教材</option><option value="notes">个人笔记</option></select></label>
        <button className="tbtn" disabled={!doc || busy} onClick={() => void openDocById(record.docId)}>打开编辑文档</button>
        <button className="tbtn" disabled={busy} onClick={() => void action(() => detachDocument(course.id, record.docId))}>移出课程</button>
        {doc && <button className="tbtn" onClick={async () => { await openDocById(record.docId); window.dispatchEvent(new Event('msz:learning-close-for-analysis')) }}>打开 AI 分析</button>}
        {doc && <button className="tbtn" disabled={busy} onClick={() => void action(async () => { const fresh = await prepareFreshAnalysis(course.id, record.docId, record.chapter); await openDocById(fresh.id); window.dispatchEvent(new Event('msz:learning-close-for-analysis')) })}>新分析，保留旧记录</button>}
      </div></li> })}</ul>
    {!snapshot.documents.length && <p>尚无资料。可以先返回编辑器导入文档，再加入课程。</p>}
    <h4>已保存学习资料</h4><p>无题目或需要补充范围时，先打开课程文档的 AI 分析，重新选择来源与内容后明确发起新分析；已有归档保留。查看覆盖、排期和练习均不发起生成。</p>
    <ul className="learning-list">{snapshot.archives.map((a) => <li key={a.id}><strong>{a.title}</strong><span>{a.sources.length} 份来源 · {a.artifacts.map((r) => ({ summary: '摘要', outline: '大纲', mindmap: '导图', quiz: '测验', knowledge: '知识整理' })[r.kind]).join('、')}</span><small>保存于 {new Date(a.createdAt).toLocaleString('zh-CN')}。按保存时的原文版本回查。</small>
      <ArchiveDetails archive={a} /><button className="tbtn" disabled={busy} onClick={() => setDeleteArchiveId(a.id)}>删除这份学习归档</button>
      {deleteArchiveId === a.id && <div className="learning-danger"><p>将删除这份归档的原文副本、生成内容，以及它关联的 {snapshot.attempts.filter((r) => r.question.archiveId === a.id).length} 次作答、草稿、疑问和复习安排。来源知识点会停用并清除生成内容；个人补充保留。原编辑文档与其他归档保留。</p><button className="tbtn" disabled={busy} onClick={() => void action(async () => { await deleteLearningArchive(course.id, a.id, a.revision); setDeleteArchiveId('') })}>确认删除这份归档及关联记录</button><button className="tbtn" onClick={() => setDeleteArchiveId('')}>取消</button></div>}
    </li>)}</ul>
    <div className="learning-danger"><button className="tbtn" onClick={() => setDeleteMode(!deleteMode)} disabled={busy}>删除课程组织</button>
      {deleteMode && <div><p>仅移除课程与学习记录，保留原编辑文档。课程中的 {snapshot.archives.length} 份学习归档和 {snapshot.attempts.length} 次作答将删除。先导出课程包可保留它们。</p>
        <button className="tbtn" disabled={busy} onClick={() => void action(async () => { await deleteCourseOrganisation(course.id, course.revision); onDeleted() })}>确认删除课程及学习记录</button><button className="tbtn" onClick={() => setDeleteMode(false)}>取消</button></div>}</div>
  </section>
}
