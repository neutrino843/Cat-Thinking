import { useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import { db } from '../../store/db'
import type { StoredAnalysisTask } from '../../analysis/taskPersistence'
import type { CourseSnapshot, KnowledgePoint } from '../../learning/model'
import { saveEntity } from '../../learning/repository'
import { documentLearningState } from '../../learning/learningLoop'
import { archivedQuestions, sameQuestion, sourceExcerpt } from '../../learning/workspaceView'
import type { LearningAction } from './CourseOverview'
import ArchiveDetails from './ArchiveDetails'
import { StudyModeChoice } from './ExperienceSettings'

function ConfirmPoint({ point, snapshot, action, busy }: { point: KnowledgePoint; snapshot: CourseSnapshot; action: LearningAction; busy: boolean }) {
  const [checked, setChecked] = useState(false)
  const questions = archivedQuestions(snapshot.archives).filter((item) => point.questionRefs.some((ref) => sameQuestion(ref, item.ref)))
  return <article className="learning-section"><h4>{point.title}</h4><p>{point.definition || '尚无核心说明，请对照原文判断。'}</p><details><summary>核对原文与相关题目</summary>{point.sourceRefs.map((ref, index) => {
    const archive = snapshot.archives.find((item) => item.id === ref.archiveId)
    const excerpt = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end)
    return <blockquote key={index}>{excerpt?.quote ?? '缺少可用原文，请勿直接确认。'}</blockquote>
  })}{questions.map((item) => <p key={item.ref.questionId}>题目：{item.question.prompt}</p>)}{!point.sourceRefs.length && <p>没有直接原文引用，请在知识页补充并核对。</p>}</details><label className="learning-option"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />我已核对说明与题目归属，纳入学习范围</label><button className="tbtn" disabled={busy || !checked} onClick={() => void action(() => saveEntity({ ...point, status: 'active', goalIncluded: true, questionRefs: point.questionRefs.map((ref) => ({ ...ref, confirmed: true })) }, point.revision))}>确认这个知识点</button></article>
}
export default function LearningBridge({ snapshot, documentId, archiveId, action, busy, onStart, onReading, onTools, onAnalysis }: {
  snapshot: CourseSnapshot; documentId: string; archiveId?: string; action: LearningAction; busy: boolean
  onStart: (pointId: string) => void; onReading: () => void; onTools: () => void; onAnalysis: (fresh: boolean) => void
}) {
  const [task, setTask] = useState<StoredAnalysisTask>()
  const [taskError, setTaskError] = useState('')
  useEffect(() => { const subscription = liveQuery(() => db.analysisTasks.get(documentId)).subscribe({ next: setTask, error: () => setTaskError('本地分析记录暂时无法读取，请到分析页检查，避免重复生成。') }); return () => subscription.unsubscribe() }, [documentId])
  const state = documentLearningState(snapshot, documentId, archiveId)
  const unsaved = Object.values(task?.artifactIdentities ?? {}).some((identity) => identity?.contentHash && !state.archives.some((archive) => archive.runId === task?.runId && archive.artifacts.some((artifact) => artifact.id === identity.artifactId)))
  const missingQuiz = state.archives.length > 0 && !state.questions.length
  const title = snapshot.docs.find((item) => item.id === documentId)?.title ?? state.archives[0]?.title ?? '这份资料'
  return <section className="learning-bridge" data-learning-stage="prepare" data-source-document={documentId} aria-label="准备继续学习"><p className="learning-eyebrow">接着刚才的资料 · {snapshot.course.name}</p><h3>{title}</h3><p>入门第一题只是体验。这里接到同一份资料的正式学习，已有结果会直接使用。</p>
    {taskError && <p role="alert">{taskError}</p>}
    {task && <div className="learning-section"><p>{unsaved ? '已有生成结果尚未保存到课程，请检查后保存。' : '已有分析任务记录，打开后核对实际进度与可用结果。不会自动重开任务。'}</p><button className="tbtn primary" disabled={busy} onClick={() => onAnalysis(false)}>{unsaved ? '检查并保存已生成内容' : '查看已有分析进度与结果'}</button></div>}
    <div className="learning-section"><h4>{state.ready.length ? '已有可学习内容' : state.pending.length ? '资料已保存，等你核对' : state.archives.length ? '已保存阅读结果，还没有正式学习题目' : '原文已保存，可以开始阅读'}</h4><p>{state.archives.length} 份已保存结果 · {state.pending.length} 个待确认知识点 · {state.ready.length} 个可学习知识点。摘要和大纲不会自动变成正式测验。</p></div>
    {state.archives.length > 0 && <details><summary>查看这份资料已保存的阅读结果</summary>{state.archives.map((archive) => <ArchiveDetails key={archive.id} archive={archive} />)}</details>}
    {state.ready.length > 0 && <><StudyModeChoice />{state.ready.map((point) => <div className="learning-section" key={point.id}><h4>{point.title}</h4><p>{point.questionRefs.length ? `${point.questionRefs.length} 道已核对题目` : '先阅读、回忆与解释；尚无正式题目'}</p><button className="tbtn primary" disabled={busy} onClick={() => onStart(point.id)}>继续学习这个知识点</button></div>)}</>}
    {state.pending.length > 0 && <details open={!state.ready.length}><summary>逐项核对待确认内容（{state.pending.length}）</summary>{state.pending.map((point) => <ConfirmPoint key={`${point.id}:${point.revision}`} point={point} snapshot={snapshot} action={action} busy={busy} />)}{snapshot.course.goals && <p>课程已有目标目录，确认知识点后可在知识页把它加入具体目标。</p>}</details>}
    <div className="learning-actions"><button className="tbtn" disabled={busy} onClick={onReading}>先读原文，写自己的理解</button><button className="tbtn" disabled={busy} onClick={() => onAnalysis(missingQuiz)}>{missingQuiz ? '另备一份练习内容，保留旧结果' : '准备正式学习内容'}</button><button className="tbtn" onClick={onTools}>查看目标、知识和其他工具</button></div><p className="focus-muted">阅读与笔记无需 AI。准备模型内容会先打开分析页面，由你选择结果种类并明确发起。</p>
    <div className="focus-perch" data-isis-perch />
  </section>
}
