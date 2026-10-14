import { canonicalizeJson, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { db } from '../store/db'
import { createSourceSnapshot, sha256Hex } from '../analysis/fingerprint'
import type { DocData, SourceDocument } from '../types'
import { archiveHashPayload, parseLearningEntity, validateLearningArchive } from './archiveValidation'
import { learningBase, newLearningId, type Course, type KnowledgePoint, type LearningArchive } from './model'
import { listCourses } from './repository'

/** Authored, checked example content. It never contacts a model or copies private material. */
export async function createExampleCourse(): Promise<Course> {
  const existing = (await listCourses()).find((course) => course.example); if (existing) return existing
  const at = Date.now(); const courseId = newLearningId(); const docId = newLearningId(); const sourceId = newLearningId()
  const rootId = newLearningId(); const archiveId = newLearningId(); const runId = newLearningId(); const artifactId = newLearningId()
  const text = '主动回忆是先隐藏说明，再尝试用自己的话回想内容。回看原文是把自己的回答和保存的资料对照。步骤可以跳过；跳过不计为答错，也不证明已经学会。'
  const doc: DocData = { version: 3, id: docId, title: '示例学习资料', rootId, layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: '主动回忆与原文核对', note: text } }, createdAt: at, updatedAt: at }
  const source: SourceDocument = { version: 1, id: sourceId, docId, name: '原创示例说明.txt', kind: 'text', mime: 'text/plain', size: new TextEncoder().encode(text).length, lastModified: at, importedAt: at, extractor: 'authored-example-v1', text, contentHash: await sha256Hex(text), charCount: text.length, anchors: [{ nodeId: rootId, start: 0, end: text.length }], locators: [{ start: 0, end: text.length, titlePath: ['示例说明'] }] }
  const manifest = { version: 1 as const, sources: [await createSourceSnapshot(source)] }
  const base = { evidenceIds: ['example-evidence'], citations: [{ version: 1 as const, provenance: 'source' as const, sourceId, start: 0, end: text.length, quote: text }], difficulty: 'easy' as const }
  const quiz: Extract<ArtifactEnvelopeV1, { kind: 'quiz' }> = { version: 1, schemaVersion: 1, id: artifactId, runId, docId, kind: 'quiz', createdAt: at, updatedAt: at, sourceContentHashes: manifest.sources.map((item) => item.contentHash), payload: { title: '示例：先回答，再核对', questions: [
    { ...base, id: 'recall', type: 'multiple-choice', prompt: '主动回忆首先应怎么做？', options: ['隐藏说明，自己尝试回想', '只反复看说明'], answerIndex: 0, explanation: '原文明确要求先隐藏说明再回想。' },
    { ...base, id: 'skip', type: 'true-false', prompt: '跳过一步就说明已经学会。', answer: false, explanation: '跳过不证明已经学会。' },
    { ...base, id: 'source', type: 'short-answer', prompt: '用一句话说明怎样回看原文。', answer: '把自己的回答和保存的资料对照。', rubric: ['提到自己的回答', '提到与保存的资料对照'], explanation: '只检查题干要求，合理同义表述也可以。' },
  ] } }
  const archive: LearningArchive = { ...learningBase(courseId, archiveId, at), kind: 'archive', originDocId: docId, provenanceDocId: docId, runId, title: '已核对原创示例', manifest, sources: [source], artifacts: [quiz], contentHash: '' }
  archive.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(archive))); await validateLearningArchive(archive)
  const point: KnowledgePoint = { ...learningBase(courseId, newLearningId(), at), kind: 'point', title: '主动回忆与原文核对', definition: text, chapter: '示例章节', aliases: [], notes: '', status: 'active', goalIncluded: true, sourceRefs: [{ archiveId, sourceId, start: 0, end: text.length }], questionRefs: quiz.payload.questions.map((question) => ({ archiveId, artifactId, questionId: question.id, confirmed: true })) }
  const course: Course = { ...learningBase(courseId, courseId, at), kind: 'course', name: '示例课程 · 学习一次完整流程', goal: '体验回忆、练习与原文核对', timeZone: 'Asia/Shanghai', dailyMinutes: 20, dailyQuestionLimit: 5, goalVersion: 1, automaticReviews: false, example: true }
  return db.transaction('rw', [db.docs, db.sources, db.learningRecords], async () => {
    const another = (await db.learningRecords.where('kind').equals('course').toArray()).find((item) => item.kind === 'course' && item.example)
    if (another) return another as Course
    await db.docs.add({ id: docId, title: doc.title, createdAt: at, updatedAt: at, payload: JSON.stringify(doc) }); await db.sources.add(source)
    await db.learningRecords.bulkAdd([course, archive, point, { ...learningBase(courseId), kind: 'document', docId, chapter: '示例章节' }].map(parseLearningEntity)); return course
  })
}
