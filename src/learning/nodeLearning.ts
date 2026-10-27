import { db, saveDocumentBundle } from '../store/db'
import { sha256Hex } from '../analysis/fingerprint'
import { LearningError, learningBase, newLearningId, type CourseSnapshot, type KnowledgePoint, type KnowledgeRelationType } from './model'
import { getEntity, loadCourseSnapshot, saveEntity, saveLearningBatch } from './repository'
import type { NodeLearningState, NodeSourceRef, NodeRound, NodeSupport } from './nodeTypes'
import type { DocData, SourceDocument } from '../types'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'

export async function nodeState(courseId: string): Promise<NodeLearningState> {
  const snapshot = await loadCourseSnapshot(courseId)
  if (snapshot.nodeWorkspace) return snapshot.nodeWorkspace
  const chapters = [...new Set(snapshot.points.map((p) => p.chapter || '未分章'))].map((title) => ({ id: newLearningId(), title }))
  if (!chapters.length) chapters.push({ id: newLearningId(), title: '第一章' })
  return saveEntity({ ...learningBase(courseId), kind: 'node-workspace', chapters, sources: [],
    bindings: snapshot.points.map((p) => ({ pointId: p.id, chapterId: chapters.find((c) => c.title === (p.chapter || '未分章'))?.id ?? chapters[0].id, refs: [] })), rounds: [], notes: [], events: [], supports: [] }, null)
}

export async function updateNodeState(state: NodeLearningState, change: (copy: NodeLearningState) => void): Promise<NodeLearningState> {
  const next = structuredClone(state); change(next)
  return saveEntity(next, state.revision)
}

export async function captureNodeSources(courseId: string, docId: string, role: 'slides' | 'textbook' | 'notes') {
  const membership = (await loadCourseSnapshot(courseId)).documents.find((item) => item.docId === docId)
  if (!membership) throw new LearningError('invalid', '请先把资料加入当前课程。')
  const sources = await db.sources.where('docId').equals(docId).toArray()
  if (!sources.length) throw new LearningError('missing', '这份资料没有可提取文字，请回资料检查。')
  const captured = await Promise.all(sources.filter((s) => s.text.trim()).map(async (s) => ({ id: newLearningId(), originDocId: docId, originSourceId: s.id, name: s.name, role, text: s.text,
    contentHash: await sha256Hex(s.text), locators: structuredClone(s.locators ?? []), anchors: s.anchors.map((a) => ({ nodeId: a.nodeId, start: a.start, end: a.end })) })))
  if (!captured.length) throw new LearningError('missing', '没有可用原文。')
  const state = await nodeState(courseId)
  return updateNodeState(state, (next) => { for (const source of captured) if (!next.sources.some((s) => s.originSourceId === source.originSourceId && s.contentHash === source.contentHash && s.role === role)) next.sources.push(source) })
}

export async function createNodePoint(state: NodeLearningState, chapterId: string, title: string, refs: NodeSourceRef[] = [], origin?: { key: string; parentId?: string }) {
  const chapter = state.chapters.find((item) => item.id === chapterId)
  if (!chapter || !title.trim()) throw new LearningError('invalid', '请选择章节并填写知识节点名称。')
  if (origin && state.bindings.some((b) => b.originKey === origin.key)) throw new LearningError('conflict', '这个候选已经并入框架，不会重复新增。')
  const point: KnowledgePoint = { ...learningBase(state.courseId), kind: 'point', title: title.trim(), chapter: chapter.title, definition: '', notes: '', aliases: [], sourceRefs: [], questionRefs: [], status: 'active', goalIncluded: false, ...(origin?.parentId ? { parentId: origin.parentId } : {}) }
  const next = structuredClone(state); next.bindings.push({ pointId: point.id, chapterId, refs, ...(origin ? { originKey: origin.key } : {}) }); next.lastPointId = point.id; delete next.lastRoundId
  await saveLearningBatch([{ entity: point, expectedRevision: null }, { entity: next, expectedRevision: state.revision }])
  return point
}

export async function renameNodeChapter(state: NodeLearningState, chapterId: string, title: string) {
  if (!title.trim()) throw new LearningError('invalid', '章节名称不能为空。')
  const next = structuredClone(state); const chapter = next.chapters.find((c) => c.id === chapterId)
  if (!chapter) throw new LearningError('missing', '章节不存在。')
  chapter.title = title.trim()
  const snapshot = await loadCourseSnapshot(state.courseId)
  const points = snapshot.points.filter((p) => state.bindings.some((b) => b.chapterId === chapterId && b.pointId === p.id))
  await saveLearningBatch([...points.map((p) => ({ entity: { ...p, chapter: chapter.title }, expectedRevision: p.revision })), { entity: next, expectedRevision: state.revision }])
}

export async function moveNodeBranch(state: NodeLearningState, pointId: string, chapterId: string) {
  const chapter = state.chapters.find((c) => c.id === chapterId)
  if (!chapter) throw new LearningError('missing', '目标章节不存在。')
  const snapshot = await loadCourseSnapshot(state.courseId)
  const moved = new Set([pointId]); let changed = true
  while (changed) { changed = false; for (const p of snapshot.points) if (p.parentId && moved.has(p.parentId) && !moved.has(p.id)) { moved.add(p.id); changed = true } }
  const next = structuredClone(state); next.bindings.filter((b) => moved.has(b.pointId)).forEach((b) => { b.chapterId = chapterId })
  await saveLearningBatch([...snapshot.points.filter((p) => moved.has(p.id)).map((p) => ({ entity: { ...p, chapter: chapter.title, ...(p.id === pointId ? { parentId: undefined } : {}) }, expectedRevision: p.revision })), { entity: next, expectedRevision: state.revision }])
}

export async function beginNodeRound(state: NodeLearningState, pointId: string) {
  const binding = state.bindings.find((item) => item.pointId === pointId)
  if (!binding) throw new LearningError('missing', '节点尚未加入知识框架。')
  const round: NodeRound = { id: newLearningId(), pointId, question: '', input: '', inputRevision: 1,
    refs: structuredClone(binding.refs), status: 'active', updatedAt: Date.now() }
  await updateNodeState(state, (next) => { next.rounds.push(round); next.lastPointId = pointId; next.lastRoundId = round.id })
  return round.id
}

export async function saveNodeDraft(state: NodeLearningState, roundId: string, question: string, input: string, refs?: NodeSourceRef[]) {
  return updateNodeState(state, (next) => {
    const round = next.rounds.find((r) => r.id === roundId)
    if (!round) throw new LearningError('missing', '学习轮次已经不存在。')
    if (round.question !== question || round.input !== input || refs && canonicalizeJson(refs) !== canonicalizeJson(round.refs)) round.inputRevision++
    round.question = question; round.input = input; if (refs) { round.refs = refs; const binding = next.bindings.find((b) => b.pointId === round.pointId); if (binding) binding.refs = structuredClone(refs) }
    round.updatedAt = Date.now(); next.lastPointId = round.pointId; next.lastRoundId = round.id
  })
}

export async function selectNodePosition(state: NodeLearningState, pointId: string, roundId?: string) {
  if (state.lastPointId === pointId && state.lastRoundId === roundId) return state
  return updateNodeState(state, (next) => {
    next.lastPointId = pointId
    if (roundId) next.lastRoundId = roundId
    else delete next.lastRoundId
  })
}

export async function collectNodeNote(state: NodeLearningState, pointId: string, text: string, roundId?: string) {
  if (!text.trim()) throw new LearningError('invalid', '请先写下自己的理解。')
  return updateNodeState(state, (next) => {
    next.notes.push({ id: newLearningId(), pointId, text, createdAt: Date.now(), ...(roundId ? { roundId } : {}) })
    const round = next.rounds.find((r) => r.id === roundId)
    if (round) next.events.push({ id: newLearningId(), roundId: round.id, inputRevision: round.inputRevision, type: 'collected', createdAt: Date.now() })
  })
}

export async function connectNodePoints(courseId: string, from: string, to: string, type: KnowledgeRelationType, reason: string) {
  const snapshot = await loadCourseSnapshot(courseId)
  if (snapshot.relations.some((r) => r.fromPointId === from && r.toPointId === to && r.type === type)) throw new LearningError('conflict', '这条联系已经存在。')
  return saveEntity({ ...learningBase(courseId), kind: 'relation', fromPointId: from, toPointId: to, type, reason, confirmed: true }, null)
}

export async function prepareNodeHint(state: NodeLearningState, roundId: string, level: 1 | 2 | 3): Promise<NodeSupport> {
  const round = state.rounds.find((r) => r.id === roundId)
  if (!round?.question.trim() || !round.refs.length || round.refs.length > 20) throw new LearningError('invalid', '请填写问题并选择 1—20 处原文依据。')
  const duplicates = state.supports.filter((s) => (!s.restored || s.archiveId) && s.roundId === roundId && s.inputRevision === round.inputRevision && s.level === level)
  const archived = duplicates.find((support) => support.archiveId)
  if (archived) return archived
  for (const duplicate of duplicates) {
    const doc = await db.docs.get(duplicate.docId)
    const sources = await Promise.all(duplicate.sourceIds.map((id) => db.sources.get(id)))
    const usable = doc && sources.every((source, index) => {
      const ref = duplicate.refs[index]
      const original = state.sources.find((item) => item.id === ref.snapshotId)
      return source?.docId === duplicate.docId && original && source.text === original.text.slice(ref.start, ref.end)
    })
    if (usable) return duplicate
  }
  // Three preparations, each server-capped at eight invocations, bound the whole round to 24.
  if (state.supports.filter((s) => s.roundId === roundId && !s.restored).length >= 3) throw new LearningError('limit', '这轮已经准备过 3 次提示，请先整理现有结果；需要更多帮助时可主动另起一轮，不会自动继续调用。')
  const docId = newLearningId(); const at = Date.now(); const sources: SourceDocument[] = []
  for (const ref of round.refs) {
    const snapshot = state.sources.find((s) => s.id === ref.snapshotId)
    if (!snapshot || await sha256Hex(snapshot.text) !== snapshot.contentHash || ref.start < 0 || ref.end > snapshot.text.length || ref.end <= ref.start) throw new LearningError('corrupt', '选定原文已失效或被修改。')
    const text = snapshot.text.slice(ref.start, ref.end)
    sources.push({ version: 1, id: newLearningId(), docId, name: `${snapshot.name}（${ref.start}–${ref.end}）`.slice(0, 500), kind: 'text', mime: 'text/plain', size: new TextEncoder().encode(text).length,
      lastModified: at, importedAt: at, extractor: 'node-selected-snapshot-v1', text, charCount: text.length, contentHash: await sha256Hex(text), anchors: [] })
  }
  if (sources.reduce((n, s) => n + s.text.length, 0) > 24000) throw new LearningError('limit', '本次依据超过 24,000 字符，请缩小选段。')
  const rootId = newLearningId()
  const doc: DocData = { version: 3, id: docId, rootId, title: `节点提示 · ${round.question}`.slice(0, 200), layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: round.question } }, createdAt: at, updatedAt: at }
  const support: NodeSupport = { id: newLearningId(), roundId, inputRevision: round.inputRevision, question: round.question, learnerInput: round.input, level, docId, refs: structuredClone(round.refs), sourceIds: sources.map((s) => s.id), createdAt: at }
  await saveDocumentBundle(doc, sources)
  try { await updateNodeState(state, (next) => {
    next.supports.push(support)
    const binding = next.bindings.find((b) => b.pointId === round.pointId)
    if (binding) binding.refs = structuredClone(round.refs)
  }) } catch (error) {
    await db.transaction('rw', [db.docs, db.sources], async () => { await db.docs.delete(docId); await db.sources.where('docId').equals(docId).delete() }); throw error
  }
  return support
}

export async function bindNodeHintArchive(courseId: string, supportId: string, archiveId: string) {
  const state = await nodeState(courseId)
  const support = state.supports.find((s) => s.id === supportId)
  if (!support) throw new LearningError('missing', '提示记录不存在。')
  if (support.archiveId === archiveId) return state
  return updateNodeState(state, (next) => { const saved = next.supports.find((s) => s.id === supportId); if (saved) saved.archiveId = archiveId })
}

export async function recordNodeHintViewed(courseId: string, supportId: string) {
  const state = await nodeState(courseId); const support = state.supports.find((s) => s.id === supportId)
  if (!support?.archiveId) throw new LearningError('missing', '请先将提示结果保存在本机，再查看。')
  if (state.events.some((e) => e.type === 'hint-viewed' && e.supportId === supportId)) return state
  return updateNodeState(state, (next) => {
    const saved = next.supports.find((s) => s.id === supportId)
    if (!saved) throw new LearningError('missing', '提示记录不存在。')
    if (!next.events.some((e) => e.type === 'hint-viewed' && e.supportId === supportId)) next.events.push({ id: newLearningId(), roundId: support.roundId, inputRevision: support.inputRevision, type: 'hint-viewed', supportId, level: support.level, createdAt: Date.now() })
  })
}

export async function verifyNodeSources(state: NodeLearningState) {
  for (const source of state.sources) if (await sha256Hex(source.text) !== source.contentHash) throw new LearningError('corrupt', '节点原文快照校验失败。')
}

export async function reloadNodeState(id: string) { const state = await getEntity(id, 'node-workspace'); if (!state) throw new LearningError('missing', '节点工作区不存在。'); return state }
export function latestNodeNote(snapshot: CourseSnapshot, pointId: string) { return snapshot.nodeWorkspace?.notes.filter((n) => n.pointId === pointId).at(-1)?.text ?? snapshot.points.find((p) => p.id === pointId)?.notes ?? '' }
