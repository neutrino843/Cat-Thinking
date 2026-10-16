import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ArtifactEnvelopeV1, SourceCitationV1 } from '@cat-thinking/analysis-contracts'
import { HttpAnalysisEngineClient } from '../../analysis/engineClient'
import { AnalysisTaskController, isAnalysisTerminal } from '../../analysis/taskController'
import { analysisTaskRepository } from '../../analysis/taskPersistence'
import { learningBase, newLearningId, type CourseSnapshot, type LearningSupport, type QuestionRef, type SupportMode } from '../../learning/model'
import { appendAssessment, createLearningArchive, saveEntity, updateCourse } from '../../learning/repository'
import { defaultSupportScope, MAX_SUPPORT_CHARACTERS, nextHintLevel, prepareLearningSupport, supportGeneration, supportSources, SUPPORT_LABELS } from '../../learning/learningSupport'
import { sourceExcerpt } from '../../learning/workspaceView'
import GroundedArtifactResults from '../analysis/GroundedArtifactResults'
import type { LearningAction } from './CourseOverview'

function SupportRun({ record, snapshot, action, busy }: { record: LearningSupport; snapshot: CourseSnapshot; action: LearningAction; busy: boolean }) {
  const controller = useMemo(() => new AnalysisTaskController(record.docId, new HttpAnalysisEngineClient(), analysisTaskRepository), [record.docId])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [citation, setCitation] = useState<SourceCitationV1>()
  useEffect(() => controller.connect(), [controller])
  const archived = snapshot.archives.find((item) => item.id === record.generatedArchiveId)
  const artifacts: ArtifactEnvelopeV1[] = archived?.artifacts ?? Object.values(state.mirror?.artifacts ?? {}).filter((item): item is ArtifactEnvelopeV1 => !!item)
  const generated = artifacts.length > 0
  const visible = record.status === 'viewed' || record.status === 'accepted'
  const source = citation && (archived?.sources ?? state.sources).find((item) => item.id === citation.sourceId)
  const outline = artifacts.find((item) => item.kind === 'outline')
  const accept = () => void action(async () => {
    if (!state.run || !artifacts.length || !isAnalysisTerminal(state.run) || state.sourceChanged) return
    const archive = archived ?? await createLearningArchive({ courseId: snapshot.course.id, docId: record.docId, runId: state.run.id, artifacts, title: SUPPORT_LABELS[record.mode] })
    await saveEntity({ ...record, status: 'accepted', generatedArchiveId: archive.id }, record.revision)
  })
  return <section className="learning-section" aria-label="AI 辅助任务"><h5>{SUPPORT_LABELS[record.mode]}</h5><p>{record.prompt}</p>
    {record.status === 'rejected' ? <p>已拒绝这份建议；调用与历史保留。</p> : <>
      {!state.task && !archived && <button className="tbtn" disabled={busy || state.loading || state.busy || !state.capabilities?.acceptsRuns} onClick={() => { const generation = supportGeneration(record); void controller.create(state.sources.map((item) => item.id), generation.kinds, {}, generation.options) }}>确认并生成（使用模型额度）</button>}
      {!state.capabilities?.acceptsRuns && !archived && <p>模型或本地 AI 服务未连接。可以在 AI 设置检查连接；已有内容仍可阅读。</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.task && !archived && <><p>任务：{state.run?.status ?? '创建结果待确认'}。若原文尚未提交完，明确恢复后会继续提交和生成，使用模型额度；已有任务读取状态，未知付费结果不会自动重发。</p><button className="tbtn" disabled={busy || state.busy} onClick={() => void controller.resume()}>{!state.run || state.run.status === 'receiving' ? '恢复提交（可能继续生成）' : '恢复查看任务'}</button>{state.run && !isAnalysisTerminal(state.run) && <button className="tbtn" disabled={state.busy} onClick={() => void controller.cancel()}>停止任务</button>}</>}
      <p>{state.usage ? `本任务已记录 ${state.usage.invocationCount} 次调用；输入 ${state.usage.usage.inputTokens} / 输出 ${state.usage.usage.outputTokens} tokens；${state.usage.completeness === 'complete' ? '用量已确认' : '仍有未知结果'}。实际金额以服务商账单为准。` : '尚无已确认用量；未知费用不显示为零。'}</p>
      {generated && !visible && <button className="tbtn" disabled={busy} onClick={() => void action(() => saveEntity({ ...record, status: 'viewed', viewedAt: Date.now() }, record.revision))}>查看已生成内容并记录辅助</button>}
      {visible && <>{artifacts.map((artifact) => artifact.kind === 'quiz' ? <div key={artifact.id}><h5>变式题草稿 · 请检查后保存</h5><ol>{artifact.payload.questions.map((question) => <li key={question.id}>{question.prompt}</li>)}</ol><p>保存后在知识结构确认题目归属，再进入练习。</p></div> : <GroundedArtifactResults key={artifact.id} artifact={artifact} onOpen={setCitation} />)}
        {citation && <section aria-label="辅助原文引用"><h5>{source?.name ?? '引用暂不可用'}</h5><blockquote>{source?.text.slice(citation.start, citation.end)}</blockquote></section>}
        <p>AI 建议须结合原文核对；不会自动覆盖知识、答案或学习判断。</p>
        {!archived && <button className="tbtn" disabled={busy || state.busy || !state.run || !isAnalysisTerminal(state.run)} onClick={accept}>保存为可回查的辅助归档</button>}
        {record.mode === 'feedback' && record.attemptId && archived && <button className="tbtn" disabled={busy} onClick={() => void action(async () => {
          const previous = snapshot.assessments.filter((event) => event.attemptId === record.attemptId).at(-1)
          await appendAssessment({ ...learningBase(snapshot.course.id), kind: 'assessment', attemptId: record.attemptId ?? '', outcome: previous?.outcome ?? 'partial', difficulty: previous?.difficulty ?? 'hard', selfAssessmentComplete: previous?.selfAssessmentComplete ?? false, ...(previous?.rubricChecks ? { rubricChecks: previous.rubricChecks } : {}), feedbackArchiveId: archived.id, origin: 'ai-review', reason: '已核对 AI 反馈；原有比较和自评状态保留，不自动评分或推进复习。' })
        })}>记录已核对的 AI 反馈</button>}
        {record.mode === 'goals' && outline?.kind === 'outline' && <button className="tbtn" disabled={busy || !archived} onClick={() => void action(() => updateCourse({ ...snapshot.course, goals: [...snapshot.course.goals ?? [], ...outline.payload.nodes.map((node) => ({ id: newLearningId(), title: node.title, level: 'explanation' as const, priority: 'normal' as const, pointIds: record.pointIds, confirmed: false }))] }))}>加入待确认目标目录</button>}
      </>}
      <button className="tbtn" disabled={busy || state.busy} onClick={() => void action(() => saveEntity({ ...record, status: 'rejected' }, record.revision))}>拒绝这份建议</button>
    </>}
  </section>
}

export default function LearningSupportPanel({ snapshot, pointIds, action, busy, questionRef, prompt: initialPrompt, learnerAnswer: initialAnswer, attemptId, sessionId }: {
  snapshot: CourseSnapshot; pointIds: string[]; action: LearningAction; busy: boolean; questionRef?: QuestionRef; prompt?: string; learnerAnswer?: string; attemptId?: string; sessionId?: string
}) {
  const refs = supportSources(snapshot, pointIds)
  const records = (snapshot.supports ?? []).filter((item) => questionRef ? item.questionRef?.archiveId === questionRef.archiveId && item.questionRef.questionId === questionRef.questionId : item.pointIds.some((id) => pointIds.includes(id)) || !pointIds.length)
  const suggestedHintLevel = nextHintLevel(records, pointIds, questionRef)
  const initialScope = defaultSupportScope(snapshot, refs)
  const [mode, setMode] = useState<SupportMode>(attemptId ? 'feedback' : 'explain')
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [answer, setAnswer] = useState(initialAnswer ?? '')
  const [level, setLevel] = useState(suggestedHintLevel)
  const [quizType, setQuizType] = useState<NonNullable<LearningSupport['quizType']>>('mixed')
  const [difficulty, setDifficulty] = useState<NonNullable<LearningSupport['difficulty']>>('medium')
  const [selection, setSelection] = useState<number[]>(initialScope.selection)
  const [currentId, setCurrentId] = useState('')
  const [ranges, setRanges] = useState<Record<number, { start: number; end: number }>>(initialScope.ranges)
  const selectedHintLevel = Math.max(level, suggestedHintLevel) as 1 | 2 | 3
  const record = records.find((item) => item.id === currentId) ?? [...records].sort((a, b) => b.createdAt - a.createdAt)[0]
  const selected = refs.flatMap((ref, index) => selection.includes(index) ? [{ ...ref, ...ranges[index] }] : [])
  const rangeInvalid = selected.some((ref) => !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > (snapshot.archives.find((archive) => archive.id === ref.archiveId)?.sources.find((source) => source.id === ref.sourceId)?.text.length ?? 0))
  const chars = selected.reduce((sum, ref) => sum + ref.end - ref.start, 0)
  return <details className="learning-section"><summary>AI 学习辅助 · 依据当前资料</summary>
    {snapshot.course.example ? <p>示例仅使用预先核对的内容。请在个人课程中使用 AI 辅助。</p> : <form className="learning-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      const existing = await prepareLearningSupport(snapshot, { mode, pointIds, sourceRefs: selected, prompt, ...((mode === 'feedback' || mode === 'hint') && answer.trim() ? { learnerAnswer: answer } : {}), ...(mode === 'hint' ? { hintLevel: selectedHintLevel } : {}), ...(mode === 'variation' ? { quizType, difficulty } : {}), ...(questionRef ? { questionRef } : {}), ...(attemptId ? { attemptId } : {}), ...(sessionId ? { sessionId } : {}) }); setCurrentId(existing.id)
    }) }}>
      <label>我需要什么帮助<select value={mode} onChange={(event) => { const next = event.target.value as SupportMode; setMode(next); if (next === 'hint') setLevel(suggestedHintLevel) }}>{Object.entries(SUPPORT_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label>当前问题或学习目标<textarea required maxLength={3000} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      {(mode === 'feedback' || mode === 'hint') && <label>{mode === 'feedback' ? '我的解释（检查理解时必填）' : '我已经想到的内容（可选，用于缩小提示）'}<textarea required={mode === 'feedback'} maxLength={10000} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>}
      {mode === 'hint' && <><label>提示程度<select value={selectedHintLevel} onChange={(event) => setLevel(Number(event.target.value) as 1 | 2 | 3)}><option value="1" disabled={suggestedHintLevel > 1}>第 1 级 · 关键概念与引导问题</option><option value="2" disabled={suggestedHintLevel > 2}>第 2 级 · 下一步推理</option><option value="3">第 3 级 · 完整解释与回忆检查</option></select></label><p>系统建议第 {suggestedHintLevel} 级。查看过的提示才推进层级；完整解释后的作答仍会记录为使用过辅助。</p></>}
      {mode === 'variation' && <div className="learning-fields"><label>题型<select value={quizType} onChange={(event) => setQuizType(event.target.value as typeof quizType)}><option value="mixed">混合</option><option value="multiple-choice">选择</option><option value="true-false">判断</option><option value="short-answer">简答</option></select></label><label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}><option value="easy">基础</option><option value="medium">进阶</option><option value="hard">挑战</option></select></label></div>}
      <fieldset><legend>仅发送选中原文片段</legend>{refs.map((ref, index) => { const archive = snapshot.archives.find((item) => item.id === ref.archiveId); const source = archive && sourceExcerpt(archive, ref.sourceId, ref.start, ref.end); const total = archive?.sources.find((item) => item.id === ref.sourceId)?.text.length ?? 0; const range = ranges[index] ?? ref; return <div key={JSON.stringify(ref)}><label className="learning-option"><input type="checkbox" checked={selection.includes(index)} onChange={(event) => setSelection(event.target.checked ? [...selection, index] : selection.filter((value) => value !== index))} />{source?.name ?? '原文缺失'} · 默认 {ref.start}–{ref.end}，原文共 {total} 字符</label><div className="learning-fields"><label>片段 {index + 1} 起点<input type="number" min="0" max={total} value={range.start} onChange={(event) => setRanges({ ...ranges, [index]: { ...range, start: Number(event.target.value) } })} /></label><label>片段 {index + 1} 终点<input type="number" min="1" max={total} value={range.end} onChange={(event) => setRanges({ ...ranges, [index]: { ...range, end: Number(event.target.value) } })} /></label></div></div> })}</fieldset>
      {rangeInvalid && <p role="alert">选段范围无效，请检查起点、终点和原文长度。</p>}
      <p>选中 {chars.toLocaleString()} 字符，最多 {MAX_SUPPORT_CHARACTERS.toLocaleString()}。默认范围会自动截到上限内；问题、选中片段和主动填写的内容会发给已连接模型，使用其额度；先准备再明确生成。</p>
      <button className="tbtn" disabled={busy || rangeInvalid || !prompt.trim() || !selected.length || chars > MAX_SUPPORT_CHARACTERS || mode === 'feedback' && !answer.trim()}>{mode === 'hint' ? `准备第 ${selectedHintLevel} 级提示` : '准备本次辅助'}</button>
    </form>}
    {record && <SupportRun key={record.id} record={record} snapshot={snapshot} action={action} busy={busy} />}
    {records.length > 1 && <label>查看以往辅助<select value={record?.id ?? ''} onChange={(event) => setCurrentId(event.target.value)}>{records.map((item) => <option key={item.id} value={item.id}>{SUPPORT_LABELS[item.mode]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
  </details>
}
