import type { AnalysisOptionsV1, ArtifactKind } from '@cat-thinking/analysis-contracts'
import type { DocData, SourceDocument } from '../types'
import { db, saveDocumentBundle } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { DEFAULT_ANALYSIS_OPTIONS } from '../analysis/artifactRegistry'
import { LearningError, learningBase, newLearningId, type ArchivedSourceRef, type CourseSnapshot, type LearningSupport } from './model'
import { saveEntity } from './repository'

export const SUPPORT_LABELS = { explain: '解释这段', compare: '比较概念', hint: '给我提示', feedback: '检查我的理解', goals: '建议学习目标', variation: '生成变式练习', supplement: '补充整理' }
export const MAX_SUPPORT_CHARACTERS = 24_000
export type LearningSupportRequest = Omit<LearningSupport, keyof ReturnType<typeof learningBase> | 'kind' | 'docId' | 'status'>

export function supportSources(snapshot: CourseSnapshot, pointIds: readonly string[]): ArchivedSourceRef[] {
  const refs = pointIds.length ? snapshot.points.filter((point) => pointIds.includes(point.id)).flatMap((point) => point.sourceRefs)
    : snapshot.archives.flatMap((archive) => archive.manifest.sources.map((source) => ({ archiveId: archive.id, sourceId: source.sourceId, start: source.selectedRange?.start ?? 0, end: source.selectedRange?.end ?? source.charCount })))
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
}

export function defaultSupportScope(snapshot: CourseSnapshot, refs: readonly ArchivedSourceRef[], limit = MAX_SUPPORT_CHARACTERS) {
  let remaining = limit
  const selection: number[] = []
  const ranges: Record<number, { start: number; end: number }> = {}
  refs.slice(0, 20).forEach((ref, index) => {
    if (remaining <= 0) return
    const source = snapshot.archives.find((archive) => archive.id === ref.archiveId)?.sources.find((item) => item.id === ref.sourceId)
    if (!source) return
    const start = Math.max(0, Math.min(ref.start, source.text.length))
    const end = Math.max(start, Math.min(ref.end, source.text.length, start + remaining))
    if (end <= start) return
    selection.push(index); ranges[index] = { start, end }; remaining -= end - start
  })
  return { selection, ranges, characters: limit - remaining }
}

const questionKey = (ref: LearningSupport['questionRef']): string => ref ? `${ref.archiveId}/${ref.artifactId}/${ref.questionId}` : ''
export function nextHintLevel(records: readonly LearningSupport[], pointIds: readonly string[], questionRef?: LearningSupport['questionRef']): 1 | 2 | 3 {
  const scope = [...pointIds].sort().join(':')
  const levels = records.filter((record) => record.mode === 'hint' && (record.status === 'viewed' || record.status === 'accepted')
    && [...record.pointIds].sort().join(':') === scope && questionKey(record.questionRef) === questionKey(questionRef))
    .map((record) => record.hintLevel ?? 1)
  return Math.min(3, Math.max(0, ...levels) + 1) as 1 | 2 | 3
}

function supportRequestKey(input: Pick<LearningSupport, 'mode' | 'pointIds' | 'sourceRefs' | 'prompt' | 'learnerAnswer' | 'hintLevel' | 'quizType' | 'difficulty' | 'questionRef' | 'attemptId' | 'sessionId'>): string {
  return JSON.stringify({ mode: input.mode, pointIds: [...input.pointIds].sort(), sourceRefs: [...input.sourceRefs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    prompt: input.prompt.trim(), learnerAnswer: input.learnerAnswer?.trim(), hintLevel: input.hintLevel, quizType: input.quizType, difficulty: input.difficulty,
    questionRef: input.questionRef, attemptId: input.attemptId, sessionId: input.sessionId })
}

function validateSupportRequest(input: LearningSupportRequest): void {
  const answer = input.learnerAnswer?.trim()
  if (input.mode === 'hint' ? !Number.isInteger(input.hintLevel) || (input.hintLevel ?? 0) < 1 || (input.hintLevel ?? 0) > 3 : input.hintLevel !== undefined) throw new LearningError('invalid', '提示层级与辅助类型不一致。')
  if (input.mode === 'feedback' && !answer) throw new LearningError('invalid', '检查理解前请填写自己的解释。')
  if (input.mode !== 'feedback' && input.mode !== 'hint' && input.learnerAnswer !== undefined) throw new LearningError('invalid', '当前辅助类型不接收学习者作答。')
  if (input.mode === 'variation' ? !input.quizType || !input.difficulty : input.quizType !== undefined || input.difficulty !== undefined) throw new LearningError('invalid', '变式题型与难度设置不完整或不适用于当前辅助。')
}

export function supportGeneration(support: LearningSupport): { kinds: ArtifactKind[]; options: AnalysisOptionsV1 } {
  const learningSupport: NonNullable<AnalysisOptionsV1['learningSupport']> = support.mode === 'hint'
    ? { mode: 'hint', question: support.prompt, hintLevel: support.hintLevel ?? 1, ...(support.learnerAnswer?.trim() ? { learnerAnswer: support.learnerAnswer.trim() } : {}) }
    : support.mode === 'feedback'
      ? { mode: 'feedback', question: support.prompt, learnerAnswer: support.learnerAnswer?.trim() ?? '' }
      : support.mode === 'variation'
        ? { mode: 'variation', question: support.prompt, quizType: support.quizType ?? 'mixed', difficulty: support.difficulty ?? 'medium' }
        : { mode: support.mode, question: support.prompt }
  return { kinds: support.mode === 'variation' ? ['quiz'] : support.mode === 'goals' ? ['outline'] : support.mode === 'supplement' ? ['summary', 'outline'] : ['summary'],
    options: { ...DEFAULT_ANALYSIS_OPTIONS, summaryDetail: 'standard', quizQuestionCount: 5, learningSupport } }
}
export async function prepareLearningSupport(snapshot: CourseSnapshot, input: LearningSupportRequest): Promise<LearningSupport> {
  if (snapshot.course.example) throw new LearningError('invalid', '示例不发送给模型，请在个人课程使用 AI 辅助。')
  if (!input.sourceRefs.length || input.sourceRefs.length > 20 || !input.prompt.trim()) throw new LearningError('invalid', '请选择 1–20 处资料依据并填写问题。')
  validateSupportRequest(input)
  const normalized = { ...input, prompt: input.prompt.trim(), ...(input.learnerAnswer !== undefined ? { learnerAnswer: input.learnerAnswer.trim() } : {}) }
  const duplicate = (snapshot.supports ?? []).find((record) => record.status === 'prepared' && supportRequestKey(record) === supportRequestKey(normalized))
  if (duplicate && await db.docs.get(duplicate.docId)) return duplicate
  const docId = newLearningId(); const rootId = newLearningId(); const at = Date.now()
  const sources: SourceDocument[] = []
  for (const ref of input.sourceRefs) {
    const original = snapshot.archives.find((archive) => archive.id === ref.archiveId)?.sources.find((source) => source.id === ref.sourceId)
    if (!original || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > original.text.length) throw new LearningError('invalid', '选中资料范围不可用。')
    const text = original.text.slice(ref.start, ref.end)
    sources.push({ version: 1, id: newLearningId(), docId, name: `${original.name}（${ref.start}–${ref.end}）`.slice(0, 500), kind: 'text', mime: 'text/plain', size: new TextEncoder().encode(text).length, lastModified: at, importedAt: at, extractor: 'learning-selected-snapshot-v1', text, contentHash: await sha256Hex(text), charCount: text.length, anchors: [] })
  }
  if (sources.reduce((total, source) => total + source.charCount, 0) > MAX_SUPPORT_CHARACTERS) throw new LearningError('limit', '辅助范围超过 24,000 字符，请缩小选段或分批整理。')
  const doc: DocData = { version: 3, id: docId, title: `${SUPPORT_LABELS[normalized.mode]} · ${snapshot.course.name}`.slice(0, 200), rootId, layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: SUPPORT_LABELS[normalized.mode] } }, createdAt: at, updatedAt: at }
  await saveDocumentBundle(doc, sources)
  try { return await saveEntity({ ...learningBase(snapshot.course.id), ...normalized, kind: 'support', docId, status: 'prepared' }, null) }
  catch (error) { await db.transaction('rw', [db.docs, db.sources], async () => { await db.docs.delete(docId); await db.sources.where('docId').equals(docId).delete() }); throw error }
}
