import type { AnalysisOptionsV1, ArtifactKind } from '@cat-thinking/analysis-contracts'
import type { DocData, SourceDocument } from '../types'
import { db, saveDocumentBundle } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { DEFAULT_ANALYSIS_OPTIONS } from '../analysis/artifactRegistry'
import { LearningError, learningBase, newLearningId, type ArchivedSourceRef, type CourseSnapshot, type LearningSupport } from './model'
import { saveEntity } from './repository'

export const SUPPORT_LABELS = { explain: '解释这段', compare: '比较概念', hint: '给我提示', feedback: '检查我的理解', goals: '建议学习目标', variation: '生成变式练习', supplement: '补充整理' }
export function supportSources(snapshot: CourseSnapshot, pointIds: readonly string[]): ArchivedSourceRef[] {
  const refs = pointIds.length ? snapshot.points.filter((point) => pointIds.includes(point.id)).flatMap((point) => point.sourceRefs)
    : snapshot.archives.flatMap((archive) => archive.manifest.sources.map((source) => ({ archiveId: archive.id, sourceId: source.sourceId, start: source.selectedRange?.start ?? 0, end: source.selectedRange?.end ?? source.charCount })))
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
}
export function supportGeneration(support: LearningSupport): { kinds: ArtifactKind[]; options: AnalysisOptionsV1 } {
  return { kinds: support.mode === 'variation' ? ['quiz'] : support.mode === 'goals' ? ['outline'] : support.mode === 'supplement' ? ['summary', 'outline'] : ['summary'],
    options: { ...DEFAULT_ANALYSIS_OPTIONS, summaryDetail: 'standard', quizQuestionCount: 5, learningSupport: { mode: support.mode, question: support.prompt,
      ...(support.learnerAnswer !== undefined ? { learnerAnswer: support.learnerAnswer } : {}), ...(support.hintLevel ? { hintLevel: support.hintLevel } : {}),
      ...(support.quizType ? { quizType: support.quizType } : {}), ...(support.difficulty ? { difficulty: support.difficulty } : {}) } } }
}
export async function prepareLearningSupport(snapshot: CourseSnapshot, input: Omit<LearningSupport, keyof ReturnType<typeof learningBase> | 'kind' | 'docId' | 'status'>): Promise<LearningSupport> {
  if (snapshot.course.example) throw new LearningError('invalid', '示例不发送给模型，请在个人课程使用 AI 辅助。')
  if (!input.sourceRefs.length || input.sourceRefs.length > 20 || !input.prompt.trim()) throw new LearningError('invalid', '请选择 1–20 处资料依据并填写问题。')
  const docId = newLearningId(); const rootId = newLearningId(); const at = Date.now()
  const sources: SourceDocument[] = []
  for (const ref of input.sourceRefs) {
    const original = snapshot.archives.find((archive) => archive.id === ref.archiveId)?.sources.find((source) => source.id === ref.sourceId)
    if (!original || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > original.text.length) throw new LearningError('invalid', '选中资料范围不可用。')
    const text = original.text.slice(ref.start, ref.end)
    sources.push({ version: 1, id: newLearningId(), docId, name: `${original.name}（${ref.start}–${ref.end}）`.slice(0, 500), kind: 'text', mime: 'text/plain', size: new TextEncoder().encode(text).length, lastModified: at, importedAt: at, extractor: 'learning-selected-snapshot-v1', text, contentHash: await sha256Hex(text), charCount: text.length, anchors: [] })
  }
  if (sources.reduce((total, source) => total + source.charCount, 0) > 24000) throw new LearningError('limit', '辅助范围超过 24,000 字符，请缩小选段或分批整理。')
  const doc: DocData = { version: 3, id: docId, title: `${SUPPORT_LABELS[input.mode]} · ${snapshot.course.name}`.slice(0, 200), rootId, layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: SUPPORT_LABELS[input.mode] } }, createdAt: at, updatedAt: at }
  await saveDocumentBundle(doc, sources)
  try { return await saveEntity({ ...learningBase(snapshot.course.id), ...input, kind: 'support', docId, status: 'prepared' }, null) }
  catch (error) { await db.transaction('rw', [db.docs, db.sources], async () => { await db.docs.delete(docId); await db.sources.where('docId').equals(docId).delete() }); throw error }
}
