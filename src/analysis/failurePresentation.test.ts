import { describe, expect, it } from 'vitest'
import { analysisErrorSchema, type AnalysisErrorV1, type AnalysisRunV1, type RunUsageV1 } from '@cat-thinking/analysis-contracts'
import { analysisFailureMessage, createAnalysisDiagnostic, pendingArtifactLabel, primaryAnalysisError } from './failurePresentation'

const error = (patch: Partial<AnalysisErrorV1>) => analysisErrorSchema.parse({
  version: 1, code: 'internal_error', category: 'internal', retryable: false,
  messageKey: 'analysis.synthetic.failed', ...patch,
})

describe('failed analysis presentation', () => {
  it('explains the recorded timeout even when its contract code is provider_unavailable', () => {
    const message = analysisFailureMessage(error({ code: 'provider_unavailable', details: {
      reason: 'invocation_outcome_unknown', providerCode: 'request_timeout', rawResponse: 'private-secret',
    } }))
    expect(message).toContain('等待模型响应超时')
    expect(message).toContain('本次任务已停止')
    expect(message).toContain('实际用量尚未确认')
    expect(message).toContain('不会自动重发')
    expect(message).not.toContain('private-secret')
  })

  it('explains the real mapping citation failure without blaming a valid source range', () => {
    const message = analysisFailureMessage(error({ code: 'citation_invalid', category: 'validation', stage: 'mapping', details: { issueCount: 58 } }))
    expect(message).toContain('模型返回的引文')
    expect(message).toContain('已停止')
    expect(message).not.toContain('检查原文范围')
  })
  it('keeps genuine source input failures actionable', () => {
    expect(analysisFailureMessage(error({ code: 'invalid_request', category: 'client' }))).toContain('检查范围')
    expect(analysisFailureMessage(error({ code: 'source_hash_mismatch', category: 'validation' }))).toContain('重新导入')
    expect(analysisFailureMessage(error({ code: 'provider_rejected', details: { providerCode: 'evidence_excerpt_capacity_exceeded' } }))).toContain('缩小选区')
    expect(analysisFailureMessage(error({ code: 'provider_rejected', details: { providerCode: 'evidence_excerpt_range_invalid' } }))).toContain('原文分段与所选范围不一致')
  })
  it('distinguishes ambiguous quotation from malformed JSON and output truncation', () => {
    expect(analysisFailureMessage(error({ code: 'provider_rejected', category: 'provider', details: { providerCode: 'evidence_quote_ambiguous' } }))).toContain('多处匹配')
    expect(analysisFailureMessage(error({ code: 'provider_rejected', category: 'provider', details: { providerCode: 'output_truncated' } }))).toContain('内容不完整')
    expect(analysisFailureMessage(error({ code: 'provider_rejected', category: 'provider', details: { providerCode: 'evidence_excerpt_not_found' } }))).toContain('无法与原文对应')
  })
  it('prioritizes unknown paid outcomes over ordinary failure guidance', () => {
    expect(analysisFailureMessage(error({ code: 'provider_unavailable', category: 'availability', details: { reason: 'invocation_outcome_unknown' } }))).toContain('不会自动重新调用')
  })
  it('shows Outline truncation as the cause of dependent MindMap failure, including saved old runs', () => {
    const outlineError = error({ code: 'provider_rejected', category: 'provider', stage: 'outline',
      details: { providerCode: 'finish_not_complete', modelReply: 'private-response' } })
    const dependencyError = error({ code: 'dependency_failed', category: 'validation', details: { dependency: 'outline' } })
    const run = { status: 'failed', error: dependencyError, providerRoutes: [], artifactStates: {
      quiz: { status: 'failed', error: error({ code: 'artifact_invalid', stage: 'quiz' }) },
      outline: { status: 'failed', error: outlineError }, mindmap: { status: 'failed', error: dependencyError },
    } } as unknown as AnalysisRunV1
    expect(primaryAnalysisError(run)).toBe(outlineError)
    expect(analysisFailureMessage(primaryAnalysisError(run)!)).toContain('内容不完整')
    expect(createAnalysisDiagnostic(run).error).toMatchObject({ stage: 'outline', providerCode: 'finish_not_complete' })
    expect(createAnalysisDiagnostic(run).artifactErrors).toHaveLength(3)
    expect(JSON.stringify(createAnalysisDiagnostic(run))).not.toContain('private-response')
    expect(primaryAnalysisError({ ...run, error: outlineError })).toBe(outlineError)
    expect(primaryAnalysisError({ ...run, error: undefined, artifactStates: { outline: run.artifactStates.outline } })).toBe(outlineError)
    expect(primaryAnalysisError({ ...run, artifactStates: {} })).toBe(dependencyError)
  })
  it('explains Artifact reference failures with fixed wording and preserves usage boundaries', () => {
    for (const providerCode of ['artifact_reference_not_found', 'artifact_reference_not_supported']) {
      const message = analysisFailureMessage(error({ code: 'provider_rejected', details: { providerCode, modelReply: 'private-source-secret' } }))
      expect(message).toContain('原文依据')
      expect(message).toContain('使用量会保留')
      expect(message).not.toContain('private-source-secret')
    }
    for (const providerCode of ['artifact_catalog_invalid', 'artifact_evidence_invalid']) {
      expect(analysisFailureMessage(error({ code: 'provider_rejected', details: { providerCode } }))).toContain('已停止生成')
    }
    expect(analysisFailureMessage(error({ code: 'provider_rejected', details: { providerCode: 'artifact_capacity_exceeded' } }))).toContain('缩小选区')
  })
  it('never reflects arbitrary provider metadata or secret-like message fields', () => {
    const message = analysisFailureMessage(error({ messageKey: 'synthetic-secret', details: { providerCode: 'secret-from-provider', reason: 'untrusted-unknown-text' } }))
    expect(message).not.toContain('secret')
    expect(message).not.toContain('untrusted')
  })
  it('marks pending artifacts in failed, cancelled and expired tasks as stopped', () => {
    expect(pendingArtifactLabel('failed')).toBe('未生成')
    expect(pendingArtifactLabel('partial')).toBe('未生成')
    expect(pendingArtifactLabel('cancelled')).toBe('已停止')
    expect(pendingArtifactLabel('expired')).toBe('已过期')
    expect(pendingArtifactLabel('mapping')).toBe('等待生成')
  })
  it('exports only metadata and checked counts, excluding identity, source and provider strings', () => {
    const run = { status: 'failed', id: 'private-run', request: { apiKey: 'private-key', sourceText: 'private-source' },
      error: error({ code: 'citation_invalid', stage: 'mapping', details: { issueCount: 58, quoteIssueCount: -1, referenceIssueCount: 'private-string', providerCode: 'private-code' } }),
      providerRoutes: [{ promptVersion: 'evidence-map-v1', modelId: 'private-model', providerId: 'private-provider' }],
    } as unknown as AnalysisRunV1
    const usage = { usage: { inputTokens: 3641, outputTokens: 3063, estimatedCostMicros: 0 }, unresolvedCount: 0 } as RunUsageV1
    const diagnostic = createAnalysisDiagnostic(run, usage)
    expect(diagnostic.error?.counts).toEqual({ issueCount: 58 })
    expect(diagnostic.knownUsage).toEqual({ inputTokens: 3641, outputTokens: 3063, unresolvedCount: 0 })
    expect(JSON.stringify(diagnostic)).not.toContain('private-')
    expect(JSON.stringify(diagnostic)).not.toContain('estimatedCost')
  })
})
