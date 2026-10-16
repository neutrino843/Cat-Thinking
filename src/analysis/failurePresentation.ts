import type { AnalysisErrorV1, AnalysisRunV1, RunUsageV1 } from '@cat-thinking/analysis-contracts'

const UNKNOWN_OUTCOMES = new Set(['invocation_outcome_unknown', 'invocation_already_succeeded', 'invocation_already_failed'])

/** A downstream dependency failure must not hide the cause in its prerequisite. */
export function primaryAnalysisError(run: AnalysisRunV1): AnalysisErrorV1 | undefined {
  const failed = Object.values(run.artifactStates ?? {}).flatMap((state) => state?.error ? [state.error] : [])
  if (run.error?.code === 'dependency_failed') {
    const prerequisite = Object.entries(run.artifactStates ?? {}).find(([kind]) => kind === run.error?.details?.dependency)?.[1]?.error
    return prerequisite ?? failed.find((error) => error.code !== 'dependency_failed') ?? run.error
  }
  return run.error ?? failed.find((error) => error.code !== 'dependency_failed') ?? failed[0]
}

/** Only fixed, locally owned messages are displayed; provider details remain data. */
export function analysisFailureMessage(error: AnalysisErrorV1): string {
  if (error.details?.providerCode === 'request_timeout') {
    return '等待模型响应超时，本次任务已停止。调用可能已产生费用，实际用量尚未确认；不会自动重发。请核对服务商记录，稍后可缩小原文范围重新分析。'
  }
  if (typeof error.details?.reason === 'string' && UNKNOWN_OUTCOMES.has(error.details.reason)) {
    return '模型调用结果无法确认，使用量已保留。请先查看记录；不会自动重新调用。'
  }
  if (error.code === 'budget_exceeded') return '任务达到分析预算上限，请缩小原文范围后再分析。'
  if (error.code === 'source_missing' || error.code === 'source_hash_mismatch') {
    return '本次任务的原文缺失或已改变，请重新导入并选择原文。'
  }
  if (error.code === 'invalid_request' || error.code === 'source_too_large') {
    return '所选原文或分析范围不符合要求，请检查范围和文档大小。'
  }
  const providerCode = error.details?.providerCode
  if (providerCode === 'artifact_capacity_exceeded') {
    return '本次原文依据超出支持范围，请缩小选区。已产生的使用量会保留。'
  }
  if (providerCode === 'artifact_reference_not_found' || providerCode === 'artifact_reference_not_supported') {
    return '生成内容选择了未知或不支持该结论的原文依据，本次内容没有通过检查。已有结果和使用量会保留。'
  }
  if (providerCode === 'artifact_catalog_invalid' || providerCode === 'artifact_evidence_invalid') {
    return '本次原文依据不完整或不一致，已停止生成。请检查原文范围，已有结果和使用量会保留。'
  }
  if (providerCode === 'evidence_excerpt_capacity_exceeded') {
    return '原文分段超出本次分析支持的范围，请缩小选区后重新分析。已有使用量记录会保留。'
  }
  if (providerCode === 'evidence_excerpt_range_invalid') {
    return '原文分段与所选范围不一致，本次分析已停止。请重新导入或选择原文，已有使用量记录会保留。'
  }
  if (providerCode === 'evidence_quote_ambiguous') {
    return '模型提供的引文在原文中有多处匹配，无法可靠定位。本次分析已停止，使用量记录已保留。'
  }
  if (error.code === 'citation_invalid' || providerCode === 'evidence_quote_not_found'
    || providerCode === 'evidence_excerpt_not_found'
    || providerCode === 'evidence_reference_missing' || providerCode === 'evidence_citation_range_invalid') {
    return '模型返回的引文或知识引用无法与原文对应，本次分析已停止。使用量记录已保留。'
  }
  if (error.code === 'schema_invalid' || providerCode === 'evidence_schema_invalid'
    || providerCode === 'evidence_invalid_json' || providerCode === 'evidence_contract_invalid'
    || providerCode === 'output_truncated' || providerCode === 'finish_not_complete'
    || providerCode === 'response_not_completed') {
    return '模型返回的内容不完整或格式未通过检查，本次分析已停止。可以缩小原文范围后重新分析。'
  }
  if (error.code === 'rate_limited') return '模型服务暂时限流，请稍后查看任务状态，避免连续点击生成。'
  if (error.code === 'provider_timeout') return '等待模型响应超时，使用量记录已保留。请先查看任务状态。'
  if (error.code === 'dependency_failed') return '所需的大纲尚未成功生成，导图暂未生成；已有结果仍可查看。'
  if (error.code === 'artifact_invalid') return '生成结果的结构或原文依据未通过检查。使用量已保留，其他已完成内容仍可查看。'
  if (error.category === 'validation' && error.stage === 'mapping') {
    return '模型返回的原文依据未通过检查，本次分析已停止，后续内容没有开始生成。'
  }
  return '本次分析未完成，使用量记录已保留。请检查任务状态后再操作。'
}

/** A pending card in a terminal run must not imply ongoing work. */
export function pendingArtifactLabel(runStatus: AnalysisRunV1['status']): string {
  if (runStatus === 'failed' || runStatus === 'partial') return '未生成'
  if (runStatus === 'cancelled') return '已停止'
  if (runStatus === 'expired') return '已过期'
  return '等待生成'
}

/** Export an allowlist, never the run, request, source or provider response. */
export function createAnalysisDiagnostic(run: AnalysisRunV1, usage?: RunUsageV1) {
  const error = primaryAnalysisError(run)
  const counts: Record<string, number> = {}
  for (const key of ['issueCount', 'rangeIssueCount', 'referenceIssueCount', 'quoteIssueCount', 'identityIssueCount', 'pageIssueCount']) {
    const value = error?.details?.[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[key] = value
  }
  return {
    version: 1,
    kind: 'cat-thinking-analysis-diagnostic',
    status: run.status,
    error: error ? { code: error.code, category: error.category, stage: error.stage, counts,
      providerCode: ['request_timeout', 'finish_not_complete', 'response_not_completed', 'output_truncated', 'artifact_output_invalid',
        'artifact_reference_not_found', 'artifact_reference_not_supported'].includes(String(error.details?.providerCode))
        ? error.details?.providerCode : undefined } : undefined,
    artifactErrors: Object.entries(run.artifactStates ?? {}).flatMap(([kind, state]) => state?.error
      ? [{ kind, code: state.error.code, category: state.error.category, stage: state.error.stage }] : []),
    promptVersions: [...new Set(run.providerRoutes.map((route) => route.promptVersion))],
    knownUsage: usage ? { inputTokens: usage.usage.inputTokens, outputTokens: usage.usage.outputTokens,
      unresolvedCount: usage.unresolvedCount } : undefined,
  }
}
