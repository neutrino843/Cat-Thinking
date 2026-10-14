import { ARTIFACT_KINDS, type CitationV1, type OutlineNodeV1 } from '@cat-thinking/analysis-contracts'
import type { PersonalLearningVerificationResult } from './personalProviderVerification.js'
import { qualitySample, qualitySampleHash, QUALITY_CORPUS_VERSION } from './qualityCorpus.js'

function citations(value: unknown): CitationV1[] {
  if (Array.isArray(value)) return value.flatMap(citations)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'citations' && Array.isArray(child) ? child as CitationV1[] : citations(child))
}
function generatedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(generatedText).join('\n')
  if (!value || typeof value !== 'object') return ''
  return Object.entries(value).filter(([key]) => !['citations', 'evidenceIds'].includes(key))
    .map(([, child]) => typeof child === 'string' ? child : generatedText(child)).join('\n')
}
function outlineStats(nodes: readonly OutlineNodeV1[], depth = 1): { count: number; depth: number } {
  return nodes.reduce((total, node) => { const child = outlineStats(node.children, depth + 1)
    return { count: total.count + 1 + child.count, depth: Math.max(total.depth, depth, child.depth) }
  }, { count: 0, depth: 0 })
}
/** Deterministic checks measure structure/exact references; semantic judgement remains separate. */
export function evaluatePublicQuality(sampleId: string, result: PersonalLearningVerificationResult) {
  const sample = qualitySample(sampleId)
  if (result.sample.hash !== qualitySampleHash(sample)) throw new RangeError('quality result belongs to another sample')
  const artifactChecks = ARTIFACT_KINDS.map((kind) => {
    const payload = result.artifacts[kind]
    const refs = citations(payload); const sourceRefs = refs.filter((ref) => ref.provenance === 'source')
    const invalid = sourceRefs.filter((ref) => ref.start < 0 || ref.end <= ref.start || ref.end > sample.text.length
      || ref.quote !== sample.text.slice(ref.start, ref.end))
    const sourceIds = new Set(sourceRefs.map((ref) => ref.sourceId))
    return { kind, generated: !!payload, sourceCitationCount: sourceRefs.length, invalidSourceCitations: invalid.length,
      exactReferencesPassed: !!payload && sourceRefs.length > 0 && invalid.length === 0 && sourceIds.size === 1 }
  })
  const text = generatedText({ summary: result.artifacts.summary, outline: result.artifacts.outline })
  const coverageCandidates = sample.keyPoints.map((point) => ({ id: point.id, expectation: point.expectation,
    foundTerms: point.terms.filter((term) => text.includes(term)), missingTerms: point.terms.filter((term) => !text.includes(term)),
    requiresSemanticReview: true as const }))
  const structure = result.artifacts.outline ? outlineStats(result.artifacts.outline.nodes) : { count: 0, depth: 0 }
  const quiz = result.artifacts.quiz?.questions ?? []
  const knowledge = result.artifacts.knowledge?.items ?? []
  return { version: 1, corpusVersion: QUALITY_CORPUS_VERSION, sampleId, sampleHash: result.sample.hash,
    modelQualityApproved: false, semanticReviewStatus: 'pending' as const,
    pipelinePassed: result.outcome === 'passed' && result.cleanupComplete && result.profileStateUnchanged && result.unresolvedCount === 0
      && ARTIFACT_KINDS.every((kind) => !!result.artifacts[kind]),
    exactReferencesPassed: artifactChecks.every((check) => check.exactReferencesPassed), artifactChecks,
    coverageCandidates, structure: { outlineNodes: structure.count, outlineDepth: structure.depth,
      mindmapNodes: result.artifacts.mindmap?.nodes.length ?? 0, relations: result.artifacts.mindmap?.relations.length ?? 0 },
    quiz: { count: quiz.length, types: [...new Set(quiz.map((question) => question.type))],
      humanReview: quiz.map((question) => ({ id: question.id, prompt: question.prompt, check: '核对唯一答案、解释、难度与原文支持；简答检查评分要点。', status: 'pending' })) },
    knowledge: { sourceItems: knowledge.filter((item) => item.provenance === 'source').length,
      inferenceItems: knowledge.filter((item) => item.provenance === 'inference').length,
      check: '逐项核对来源陈述与模型推断是否分开，推断不能冒充原文。' },
    reviewQuestions: sample.reviewQuestions,
  }
}
