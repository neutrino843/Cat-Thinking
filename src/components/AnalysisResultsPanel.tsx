import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ARTIFACT_KINDS, type ArtifactKind, type SourceCitationV1, type SourceRangeV1 } from '@cat-thinking/analysis-contracts'
import { HttpAnalysisEngineClient } from '../analysis/engineClient'
import { AnalysisTaskController, isAnalysisTerminal } from '../analysis/taskController'
import { analysisTaskRepository } from '../analysis/taskPersistence'
import { resolveCitationView, type CitationView } from '../analysis/citationView'
import { artifactDependencyClosure, ARTIFACT_REGISTRY, DEFAULT_ANALYSIS_OPTIONS, QUIZ_QUESTION_COUNTS } from '../analysis/artifactRegistry'
import GroundedArtifactResults from './analysis/GroundedArtifactResults'
import MindMapResult from './analysis/MindMapResult'
import QuizResult from './analysis/QuizResult'
import LearningGoalPicker from './analysis/LearningGoalPicker'
import KnowledgePracticeBridge from './analysis/KnowledgePracticeBridge'
import { useKnowledgePracticeNavigation } from './analysis/useKnowledgePracticeNavigation'
import AnalysisArchiveAction from './analysis/AnalysisArchiveAction'
import AnalysisStageBar, { recordAnalysisComplete } from './analysis/AnalysisStageBar'
import { recordAnalysisPerf } from '../analysis/perfEvents'
import { analysisFailureMessage, createAnalysisDiagnostic, pendingArtifactLabel, primaryAnalysisError } from '../analysis/failurePresentation'

const STATUS_LABELS: Record<string, string> = {
  receiving: '上传原文', queued: '排队中', planning: '规划分析', mapping: '提取证据', merging: '合并证据',
  generating: '生成结果', validating: '校验结果', succeeded: '分析完成', partial: '部分完成', cancelled: '已取消',
  failed: '分析失败', expired: '已过期', accepted: '已接收', pending: '等待生成', running: '生成中',
}

/** Mounted with key=docId. Results cannot leak across document tabs. */
export default function AnalysisResultsPanel({ docId, onClose, onOpenSettings, learningPreparation = false, conceptMap = false }: { docId: string; onClose: () => void; onOpenSettings?: () => void; learningPreparation?: boolean; conceptMap?: boolean }) {
  const [controller] = useState(() => new AnalysisTaskController(docId, new HttpAnalysisEngineClient(), analysisTaskRepository))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [selected, setSelected] = useState<string[]>()
  const [rangeInputs, setRangeInputs] = useState<Record<string, { start: string; end: string }>>({})
  const [kinds, setKinds] = useState<ArtifactKind[]>(conceptMap ? ['outline', 'mindmap'] : learningPreparation ? ['mindmap', 'quiz'] : ['summary', 'outline'])
  const [quizQuestionCount, setQuizQuestionCount] = useState<number>(5)
  const [citationView, setCitationView] = useState<CitationView>()
  const [citationError, setCitationError] = useState('')
  const [citationBinding, setCitationBinding] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const citationSection = useRef<HTMLElement>(null)
  const citationGeneration = useRef(0)
  const mindmap = state.mirror?.artifacts.mindmap
  const quiz = state.mirror?.artifacts.quiz
  const linkageDisabled = state.loading || state.sourceChanged || !state.task || state.run?.status === 'cancelled' || state.run?.status === 'expired'
    || !state.task.artifactIdentities?.mindmap?.contentHash || !state.task.artifactIdentities?.quiz?.contentHash
  const knowledgeNavigation = useKnowledgePracticeNavigation(mindmap?.kind === 'mindmap' ? mindmap : undefined,
    quiz?.kind === 'quiz' ? quiz : undefined, linkageDisabled, dialog)
  useEffect(() => controller.connect(), [controller])
  useEffect(() => {
    const refresh = () => { void controller.checkService() }
    window.addEventListener('cat-thinking:ai-settings-changed', refresh)
    return () => window.removeEventListener('cat-thinking:ai-settings-changed', refresh)
  }, [controller])
  useEffect(() => {
    const element = dialog.current
    const generation = citationGeneration
    element?.showModal()
    return () => { generation.current++; element?.close() }
  }, [])
  useEffect(() => { citationSection.current?.focus() }, [citationView, citationError])
  useEffect(() => {
    citationGeneration.current++
  }, [state.task?.request.requestKey, state.sourceChanged, state.run?.status])

  const chosen = selected ?? state.sources.map((s) => s.id)
  const ranges: Record<string, SourceRangeV1> = {}
  let rangeInvalid = false
  for (const source of state.sources.filter((s) => chosen.includes(s.id))) {
    const input = rangeInputs[source.id]
    if (!input || input.start === '' && input.end === '') continue
    const start = Number(input.start)
    const end = Number(input.end)
    if (input.start === '' || input.end === '' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.charCount) rangeInvalid = true
    else ranges[source.id] = { start, end }
  }
  const openCitation = async (citation: SourceCitationV1) => {
    const generation = ++citationGeneration.current
    const binding = state.task?.request.requestKey
    if (!binding) return
    setCitationBinding(binding)
    setCitationError('')
    try {
      const sources = await analysisTaskRepository.sources(docId)
      const view = await resolveCitationView(docId, sources.find((s) => s.id === citation.sourceId),
        state.task?.request.manifest.sources.find((s) => s.sourceId === citation.sourceId), citation)
      if (generation === citationGeneration.current && controller.getSnapshot().task?.request.requestKey === binding) setCitationView(view)
    } catch {
      if (generation === citationGeneration.current && controller.getSnapshot().task?.request.requestKey === binding) { setCitationView(undefined); setCitationError('原文已改变或引用不可定位，请恢复任务检查来源。') }
    }
  }
  const run = state.run
  const failure = run ? primaryAnalysisError(run) : undefined
  const capabilities = state.capabilities
  const unsupportedKinds = capabilities ? artifactDependencyClosure(kinds).filter((kind) => !capabilities.artifactKinds.includes(kind)) : []
  const pricingUnknown = capabilities?.pricingKnown === false || run?.request.providerProfileId !== undefined
  const closed = !capabilities?.acceptsRuns
  const synthetic = capabilities?.serviceVersion.startsWith('synthetic-browser-') === true
  const blocked = state.loading || state.busy
  const archiveBindingKey = `${state.task?.request.requestKey}:${Object.entries(state.task?.artifactIdentities ?? {}).map(([kind, identity]) => `${kind}:${identity?.contentHash ?? ''}`).join(':')}`
  const downloadDiagnostic = () => {
    if (!run) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(createAnalysisDiagnostic(run, state.usage), null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = '猫思之分析诊断.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  return <dialog className="analysis-panel" ref={dialog} aria-labelledby="analysis-title" data-analysis-panel onCancel={onClose}>
    <header className="modal-head"><h2 id="analysis-title">{conceptMap ? '概念关系图整理' : 'AI 学习分析'}</h2><button className="tbtn" onClick={onClose} aria-label="关闭 AI 分析">✕</button></header>
    <div className="analysis-body">
      {conceptMap && <p className="analysis-notice">讲义结构图会保留。请选择原文范围，再开始整理概念及其关系；这会使用你配置的模型。结果先预览，采用时创建独立导图，不覆盖原图、笔记或旧节点的学习记录。</p>}
      <p>理清知识，测出疑问，回到原文。先选学习目标，再选择需要的内容；生成结果会保留原文引用。</p>
      <p className="analysis-source-caption">生成时，所选原文会发给你连接的模型服务并使用其额度。查看已有结果、作答与复习清单不新增生成调用。</p>
      {synthetic && <p className="analysis-notice" role="status">合成测试环境 · fake Provider 输出，仅用于流程验收</p>}
      {closed && <p className="analysis-notice" role="status">AI 还未连接，新分析暂不可用。可以先在「AI 设置」选择服务、填入密钥和模型；已有分析仍可查看。</p>}
      {closed && <div className="analysis-actions">{onOpenSettings && <button className="tbtn primary" onClick={onOpenSettings}>连接 AI</button>}<button className="tbtn" disabled={blocked} onClick={() => void controller.checkService()}>重新检查服务</button></div>}
      {state.error && <p className="analysis-error" role="alert">{state.error}</p>}
      {state.loading && <p role="status">正在读取来源与任务…</p>}
      {state.sourceChanged && <p className="analysis-error" role="alert">原文已改变，已停止上传和隐藏旧结果。仍可只读找回任务，或删除旧分析内容后创建新任务。</p>}
      {!state.task && <>
        <LearningGoalPicker kinds={kinds} availableKinds={capabilities?.artifactKinds} disabled={blocked} onSelect={setKinds} />
        <fieldset disabled={blocked}><legend>选择原文与范围</legend>
          {!state.sources.length && <p>请先从侧栏导入 TXT、Markdown、PDF 或 DOCX 文档。</p>}
          {state.sources.map((source) => <div className="analysis-source" key={source.id}>
            <label><input type="checkbox" checked={chosen.includes(source.id)} onChange={(event) => {
              const next = event.target.checked ? [...chosen, source.id] : chosen.filter((id) => id !== source.id)
              setSelected(next)
            }} />{source.name} · {source.charCount.toLocaleString()} 字符</label>
            <div className="analysis-range"><span>范围（留空使用全文）</span>
              <input type="number" min={0} max={source.charCount} placeholder="起始" aria-label={`${source.name} 起始字符`} value={rangeInputs[source.id]?.start ?? ''} onChange={(event) => setRangeInputs({ ...rangeInputs, [source.id]: { end: rangeInputs[source.id]?.end ?? '', start: event.target.value } })} />
              <input type="number" min={1} max={source.charCount} placeholder="结束" aria-label={`${source.name} 结束字符`} value={rangeInputs[source.id]?.end ?? ''} onChange={(event) => setRangeInputs({ ...rangeInputs, [source.id]: { start: rangeInputs[source.id]?.start ?? '', end: event.target.value } })} />
            </div>
          </div>)}
        </fieldset>
        <fieldset disabled={blocked}><legend>生成内容</legend>{ARTIFACT_KINDS.map((kind) => <label key={kind} className="analysis-kind"><input type="checkbox" disabled={capabilities !== undefined && !capabilities.artifactKinds.includes(kind) && !kinds.includes(kind)} checked={kinds.includes(kind)} onChange={(event) => setKinds(event.target.checked ? [...kinds, kind] : kinds.filter((k) => k !== kind))} />{ARTIFACT_REGISTRY[kind].label}</label>)}
          <p className="analysis-source-caption">想看结构并自测，可同时勾选导图和测验。请在生成前选好，本次任务开始后暂不能追加其他种类。</p>
          {kinds.includes('mindmap') && <p>导图会同时生成所需大纲，失败后可分别显式重试。</p>}
          {kinds.includes('quiz') && <label>测验题数 <select aria-label="测验题数" value={quizQuestionCount} onChange={(event) => setQuizQuestionCount(Number(event.target.value))}>{QUIZ_QUESTION_COUNTS.map((count) => <option key={count} value={count}>{count} 题</option>)}</select></label>}
        </fieldset>
        {rangeInvalid && <p role="alert">范围应为有效字符位置：起始小于结束，且不超出原文长度。</p>}
        {unsupportedKinds.length > 0 && <p className="analysis-error" role="alert">当前连接不支持所需的{unsupportedKinds.map((kind) => ARTIFACT_REGISTRY[kind].label).join('、')}。请选择可用的学习目标，或调整下方选项；生成导图还需要大纲。</p>}
        <button className="tbtn primary" disabled={closed || blocked || rangeInvalid || unsupportedKinds.length > 0 || !chosen.some((id) => state.sources.some((s) => s.id === id)) || !kinds.length} onClick={() => void controller.create(chosen.filter((id) => state.sources.some((s) => s.id === id)), kinds, ranges, { ...DEFAULT_ANALYSIS_OPTIONS, quizQuestionCount })}>{kinds.length === 2 && kinds.includes('summary') && kinds.includes('outline') ? '生成摘要与大纲' : '生成所选内容'}</button>
      </>}
      {state.task && <section aria-label="分析任务">
        {run?.providerRoutes[0] && <p className="analysis-source-caption">本次分析使用模型：{run.providerRoutes[0].modelId}。切换 AI 设置不会自动重做已有结果。要使用新模型，可删除这次分析内容后重新生成。</p>}
        <p>任务：{run ? STATUS_LABELS[state.mirror?.connection === 'connected' ? state.mirror.status : run.status] ?? STATUS_LABELS[run.status] : state.task.runId ? '正在恢复任务状态' : '创建结果尚未确认'}{state.mirror?.connection === 'lost' ? ' · 连接中断' : ''}</p>
        {failure && <p className="analysis-error" role="alert">{analysisFailureMessage(failure)}</p>}
        {failure && onOpenSettings && <button className="tbtn" onClick={onOpenSettings}>检查 AI 连接</button>}
        {run?.status === 'failed' && <p className="analysis-source-caption">任务已结束，后续内容不会继续生成。「恢复查看」会读取已保存状态。要重新分析，请删除本次分析内容后手动生成；已经产生的使用量仍保留。</p>}
        {run && <AnalysisStageBar
          status={state.mirror?.connection === 'connected' ? state.mirror.status : run.status}
          progress={run.progress}
          charCount={state.task.request.manifest.sources.reduce((sum, s) => sum + (s.charCount ?? 0), 0)}
          kinds={run.request.artifacts}
          startedAt={run.createdAt}
          onComplete={(totalMs) => {
            recordAnalysisComplete(
              state.task?.request.manifest.sources.reduce((sum, s) => sum + (s.charCount ?? 0), 0) ?? 0,
              run.request.artifacts,
              totalMs,
            )
            recordAnalysisPerf({
              stage: 'run-complete', ms: totalMs, runId: state.task?.runId,
              repairCount: run.artifactStates ? Object.values(run.artifactStates).filter((artifactState) => artifactState.attempt > 1).length : 0,
            })
          }}
        />}
        <p className="analysis-source-caption">来源：{state.task.request.manifest.sources.map((snapshot) => {
          const source = state.sources.find((s) => s.id === snapshot.sourceId)
          return `${source?.name ?? snapshot.sourceId}（${snapshot.selectedRange ? `${snapshot.selectedRange.start}–${snapshot.selectedRange.end}` : '全文'}）`
        }).join('、')}</p>
        {state.usage && <p className="analysis-usage">{state.usage.unresolvedCount > 0 ? '已确认部分用量（不含未确认调用）' : '已知使用量'}：输入 {state.usage.usage.inputTokens} / 输出 {state.usage.usage.outputTokens} tokens · {pricingUnknown ? '费用以服务商账单为准。' : <>费用估算 {(state.usage.usage.estimatedCostMicros / 1_000_000).toFixed(6)} {state.usage.usage.currency}（非实际账单）。</>}{state.usage.unresolvedCount > 0 && <> {state.usage.unresolvedCount} 次调用结果未确认。不会自动再次调用，以免重复消耗额度。</>}</p>}
        {state.usageError && <p role="alert">使用量暂未读到：{state.usageError} 请恢复查看。</p>}
        {(!run || run.status === 'receiving') && <p>本次打开只读取已有任务。继续提交会上传尚未完成的原文并开始生成，请确认后再操作。</p>}
        <div className="analysis-actions">
          <button className="tbtn" disabled={blocked} onClick={() => void controller.resume()}>{!run || run.status === 'receiving' ? '继续提交并生成（使用模型额度）' : '恢复查看'}</button>
          {run && !isAnalysisTerminal(run) && <button className="tbtn" disabled={blocked || capabilities?.supportsCancellation === false} onClick={() => void controller.cancel()}>取消任务</button>}
          <button className="tbtn" disabled={blocked} onClick={() => setDeleteConfirm(true)}>删除分析内容</button>
          <button className="tbtn" disabled={blocked} onClick={() => void controller.forgetExpired()}>清除过期关联</button>
          {run && <button className="tbtn" onClick={downloadDiagnostic}>下载诊断信息</button>}
        </div>
        {deleteConfirm && <div className="analysis-notice" role="group" aria-label="确认删除分析内容"><p>{state.task.runId ? '删除服务端原文副本、证据和结果，并清除本地任务关联；导入文档仍保留。' : '持久放弃这次尚未确认的创建，阻止迟到请求创建任务，确认后清除本地关联。'}</p><button className="tbtn" disabled={blocked} onClick={() => { citationGeneration.current++; setCitationView(undefined); setCitationError(''); setDeleteConfirm(false); void controller.deleteContent() }}>确认删除</button><button className="tbtn" onClick={() => setDeleteConfirm(false)}>保留内容</button></div>}
      </section>}
      {state.task && citationBinding === state.task.request.requestKey && !state.sourceChanged && run?.status !== 'expired' && (citationView || citationError) && <section className="analysis-original" tabIndex={-1} ref={citationSection} aria-label="原文引用">
        <h3>{citationView?.name ?? '原文引用'}</h3>{citationError ? <p role="alert">{citationError}</p> : citationView && <><p>{citationView.location}</p><pre>{citationView.before}<mark>{citationView.quote}</mark>{citationView.truncated ? '…（引用较长，已截取预览）' : ''}{citationView.after}</pre></>}
        <button className="tbtn" onClick={() => { citationGeneration.current++; setCitationView(undefined); setCitationError('') }}>关闭原文</button>
      </section>}
      {!state.sourceChanged && mindmap?.kind === 'mindmap' && quiz?.kind === 'quiz' && <KnowledgePracticeBridge
        key={`${state.task?.request.requestKey}:${mindmap.id}:${quiz.id}`} mindmap={mindmap} quiz={quiz} navigation={knowledgeNavigation} />}
      {!state.sourceChanged && mindmap?.kind === 'mindmap' && !quiz && <p className="analysis-notice" role="status">{run?.request.artifacts.includes('quiz')
        ? '本次测验尚未可用，暂时不能从知识点进入练习。请查看测验生成状态。'
        : '本次未选择测验，没有关联练习。可在新分析中明确选择导图和测验。'}</p>}
      {!state.sourceChanged && run && state.task && isAnalysisTerminal(run) && run.status !== 'expired' && run.status !== 'cancelled'
        && Object.values(state.mirror?.artifacts ?? {}).some((artifact) => artifact && state.task?.artifactIdentities?.[artifact.kind]?.contentHash) && <AnalysisArchiveAction
          key={archiveBindingKey} docId={docId} runId={run.id} bindingKey={archiveBindingKey} disabled={blocked}
          artifacts={Object.values(state.mirror?.artifacts ?? {}).filter((artifact): artifact is NonNullable<typeof artifact> => !!artifact && !!state.task?.artifactIdentities?.[artifact.kind]?.contentHash)} onClose={onClose} />}
      {!state.sourceChanged && run?.status !== 'expired' && run?.status !== 'cancelled' && run?.request.artifacts.map((kind) => {
        const status = run.artifactStates[kind]
        const artifact = state.mirror?.artifacts[kind]
        return <section className="analysis-result" key={kind} aria-label={ARTIFACT_REGISTRY[kind].resultLabel}>
          <h3>{ARTIFACT_REGISTRY[kind].label} <small>{!status || status.status === 'pending' ? pendingArtifactLabel(run.status) : STATUS_LABELS[status.status]}</small></h3>
          {status?.error && <p role="alert">{analysisFailureMessage(status.error)}</p>}
          {state.artifactReadErrors[kind] && <p role="alert">结果读取失败：{state.artifactReadErrors[kind]?.message} {state.artifactReadErrors[kind]?.retryable ? '将有限次重读，也可恢复查看。' : '请检查服务结果。'}</p>}
          {status?.status === 'failed' && status.error?.retryable && <button className="tbtn" disabled={blocked || closed} onClick={() => void controller.retry(kind)}>重试{ARTIFACT_REGISTRY[kind].label}</button>}
          {artifact && <GroundedArtifactResults artifact={artifact} onOpen={(citation) => void openCitation(citation)} />}
          {artifact?.kind === 'knowledge' && !run.providerRoutes.some((route) => route.promptVersion.startsWith('knowledge-grounded-')) && <p className="analysis-notice">这份既存结果使用较早的依据规则，请结合原文逐条复核推断。不会自动重新生成。</p>}
          {artifact?.kind === 'mindmap' && <MindMapResult key={`${state.task?.request.requestKey}:${artifact.id}:${state.task?.artifactIdentities?.mindmap?.contentHash}`} artifact={artifact} disabled={blocked || !state.task?.artifactIdentities?.mindmap?.contentHash} navigation={knowledgeNavigation} onOpen={(citation) => void openCitation(citation)} onClose={onClose} />}
          {artifact?.kind === 'quiz' && <QuizResult key={`${state.task?.request.requestKey}:${artifact.id}:${state.task?.artifactIdentities?.quiz?.contentHash}`} artifact={artifact} disabled={!state.task?.artifactIdentities?.quiz?.contentHash} navigation={knowledgeNavigation} mindmap={mindmap?.kind === 'mindmap' ? mindmap : undefined} onOpen={(citation) => void openCitation(citation)} />}
        </section>
      })}
    </div>
  </dialog>
}
