import { analysisRequestSchema, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'
import type { StoredAnalysisTask } from '../analysis/taskPersistence'
import { createSourceSnapshot } from '../analysis/fingerprint'
import { artifactContentHash } from '../analysis/localArtifactIdentity'
import { buildFixture } from './fixture'

/** Public synthetic local-storage fixtures; no transport or real Provider configuration. */
export async function localArtifactFixtures() {
  const doc = buildFixture({ text: '原图：保留', children: [{ text: '原节点' }] })
  const source: SourceDocument = { version: 1, id: 'synthetic-source', docId: doc.id, name: '公开合成原文.txt', kind: 'text', mime: 'text/plain',
    size: 20, lastModified: 1, importedAt: 1, extractor: 'text-v1', text: '公开合成原文😀用于本地持久化测试。', charCount: 19,
    anchors: [{ nodeId: doc.rootId, start: 0, end: 6 }], locators: [{ start: 0, end: 6, titlePath: ['合成'] }] }
  source.charCount = source.text.length
  const snapshot = await createSourceSnapshot(source)
  const citation = { version: 1 as const, provenance: 'source' as const, sourceId: source.id, start: 6, end: 8 }
  const base = { version: 1 as const, schemaVersion: 1 as const, runId: 'synthetic-run', docId: doc.id, sourceContentHashes: [snapshot.contentHash], createdAt: 1, updatedAt: 1 }
  const mindmap: Extract<ArtifactEnvelopeV1, { kind: 'mindmap' }> = { ...base, id: 'synthetic-mindmap', kind: 'mindmap', payload: { title: '独立合成导图', nodes: [
    { id: 'root', parentId: null, text: '主题', evidenceIds: ['evidence-1'], citations: [citation] },
    { id: 'child', parentId: 'root', text: '分支', evidenceIds: ['evidence-1'], citations: [citation] },
  ], relations: [{ id: 'relation', from: 'root', to: 'child', label: '支持', evidenceIds: ['evidence-1'], citations: [citation] }] } }
  const questionBase = { explanation: '合成解释', difficulty: 'easy' as const, evidenceIds: ['evidence-1'], citations: [citation] }
  const quiz: Extract<ArtifactEnvelopeV1, { kind: 'quiz' }> = { ...base, id: 'synthetic-quiz', kind: 'quiz', payload: { title: '合成练习', questions: [
    { ...questionBase, id: 'choice', prompt: '选择一个选项', type: 'multiple-choice', options: ['正确项', '其他项'], answerIndex: 0 },
    { ...questionBase, id: 'boolean', prompt: '判断合成命题', type: 'true-false', answer: false },
    { ...questionBase, id: 'short', prompt: '简述合成规则', type: 'short-answer', answer: '参照合成规则', rubric: ['范围明确', '类型正确'] },
  ] } }
  const request = analysisRequestSchema.parse({ version: 1, requestKey: 'a'.repeat(64), docId: doc.id, manifest: { version: 1, sources: [snapshot] },
    artifacts: ['outline', 'mindmap', 'quiz'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 3, externalKnowledge: false } })
  const task: StoredAnalysisTask = { version: 1, docId: doc.id, request, runId: base.runId, partBytes: 128_000, uploadedParts: {}, revision: 10, lastSequence: 0, updatedAt: 1,
    artifactIdentities: {
      mindmap: { artifactId: mindmap.id, attempt: 1, runRevision: 10, contentHash: await artifactContentHash(mindmap) },
      quiz: { artifactId: quiz.id, attempt: 1, runRevision: 10, contentHash: await artifactContentHash(quiz) },
    } }
  return { doc, source, snapshot, task, mindmap, quiz }
}
