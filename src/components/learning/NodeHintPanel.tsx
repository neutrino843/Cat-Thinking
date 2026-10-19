import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ArtifactEnvelopeV1, SourceCitationV1 } from '@cat-thinking/analysis-contracts'
import { AnalysisTaskController, isAnalysisTerminal } from '../../analysis/taskController'
import { HttpAnalysisEngineClient } from '../../analysis/engineClient'
import { analysisTaskRepository } from '../../analysis/taskPersistence'
import { DEFAULT_ANALYSIS_OPTIONS } from '../../analysis/artifactRegistry'
import { createLearningArchive } from '../../learning/repository'
import { bindNodeHintArchive, recordNodeHintViewed } from '../../learning/nodeLearning'
import type { CourseSnapshot } from '../../learning/model'
import type { NodeSupport } from '../../learning/nodeTypes'
import type { LearningAction } from './CourseOverview'
import GroundedArtifactResults from '../analysis/GroundedArtifactResults'

export default function NodeHintPanel({ support, snapshot, action, busy }: { support: NodeSupport; snapshot: CourseSnapshot; action: LearningAction; busy: boolean }) {
  const controller = useMemo(() => new AnalysisTaskController(support.docId, new HttpAnalysisEngineClient(), analysisTaskRepository), [support.docId])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => support.restored ? undefined : controller.connect(), [controller, support.restored])
  const [citation, setCitation] = useState<SourceCitationV1>()
  const archived = snapshot.archives.find((a) => a.id === support.archiveId)
  const artifacts = archived?.artifacts ?? Object.values(state.mirror?.artifacts ?? {}).filter((a): a is ArtifactEnvelopeV1 => !!a)
  const visible = snapshot.nodeWorkspace?.events.some((e) => e.type === 'hint-viewed' && e.supportId === support.id)
  const statuses: Record<string, string> = { receiving: '提交原文中', queued: '等待处理', running: '正在整理提示', succeeded: '已完成', partial: '部分完成', failed: '生成失败', cancelled: '已停止', expired: '任务已过期' }
  const quoteIndex = citation ? support.sourceIds.indexOf(citation.sourceId) : -1
  const ref = support.refs[quoteIndex]
  const original = ref && snapshot.nodeWorkspace?.sources.find((s) => s.id === ref.snapshotId)
  const source = citation && (archived?.sources ?? state.sources).find((s) => s.id === citation.sourceId)
  const open = () => void action(async () => {
    const run = state.run
    if (!archived && (!run || !isAnalysisTerminal(run) || !artifacts.length)) return
    const saved = archived ?? await createLearningArchive({ courseId: snapshot.course.id, docId: support.docId, runId: run?.id ?? '', artifacts, title: `节点提示 · ${support.question}`.slice(0, 200) })
    // 归档身份先绑定到提示记录，再记录查看事件；缺一步都会让 recordNodeHintViewed 拒绝并打断查看
    await bindNodeHintArchive(snapshot.course.id, support.id, saved.id)
    await recordNodeHintViewed(snapshot.course.id, support.id)
  })
  return <section className="node-hint" aria-label={`第 ${support.level} 级提示任务`}>
    <h4>{support.level === 3 ? '完整解释' : `第 ${support.level} 级提示`}</h4><p>{support.question}</p>
    <small>依据发送时的问题和尝试。后续修改不会覆盖这份结果。</small>
    {support.restored && !archived && <p>此任务来自备份，未保存结果；不会重新执行。可保留原问题，新建提示请求。</p>}
    {!support.restored && !state.task && !archived && <button className="tbtn" disabled={busy || state.loading || state.busy || !state.capabilities?.acceptsRuns} onClick={() => void controller.create(state.sources.map((s) => s.id), ['summary'], {}, {
      ...DEFAULT_ANALYSIS_OPTIONS, invocationLimit: 8, learningSupport: { mode: 'hint', question: support.question, hintLevel: support.level, ...(support.learnerInput.trim() ? { learnerAnswer: support.learnerInput } : {}) },
    })}>确认并生成（使用模型额度）</button>}
    {!state.capabilities?.acceptsRuns && !archived && !support.restored && <p>请先在“更多 → AI 设置”连接自己的模型。设置教程可在下方打开。</p>}
    {state.task && !archived && !support.restored && <><p role="status">{state.run ? statuses[state.run.status] ?? '等待任务状态' : '任务状态待确认'}；断线不代表生成失败或没有计费。</p>
      <button className="tbtn" disabled={state.busy} onClick={() => void controller.resume()}>{!state.run || state.run.status === 'receiving' ? '恢复提交（可能继续生成）' : '恢复查看结果'}</button>
      {state.run && !isAnalysisTerminal(state.run) && <button className="tbtn" disabled={state.busy} onClick={() => void controller.cancel()}>停止任务</button>}</>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.usage && <p>已记录 {state.usage.invocationCount} 次调用；输入 {state.usage.usage.inputTokens}、输出 {state.usage.usage.outputTokens} 词元。{state.usage.completeness !== 'complete' ? '仍有用量未知，实际费用以服务商账单为准。' : '费用以服务商账单为准。'}</p>}
    {!visible && artifacts.length > 0 && <button className="tbtn" disabled={busy || state.busy || !archived && (!state.run || !isAnalysisTerminal(state.run))} onClick={open}>{support.level === 3 ? '查看完整解释并记录辅助' : '查看提示并记录辅助'}</button>}
    {visible && <>{artifacts.map((artifact) => <GroundedArtifactResults key={artifact.id} artifact={artifact} onOpen={setCitation} />)}
      {citation && <blockquote><strong>{original?.name ?? source?.name ?? '原文定位不可用'}</strong><p>{original && ref && citation.end <= ref.end - ref.start ? original.text.slice(ref.start + citation.start, ref.start + citation.end) : source?.text.slice(citation.start, citation.end)}</p></blockquote>}
      <p>请核对原文与推理。提示结果与自己的理解分别保存；使用过提示不代表独立掌握。</p></>}
  </section>
}
