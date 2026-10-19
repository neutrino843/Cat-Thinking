import { identifierSchema } from '@cat-thinking/analysis-contracts'
import type { NodeLearningState } from './nodeTypes'
import type { NodeSupport } from './nodeTypes'
import type { LearningArchive } from './model'

function fail(): never { const error = new Error('节点学习数据结构、引用或范围无效。'); error.name = 'LearningError'; throw error }
function obj(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 20_000) { if (typeof value !== 'string' || value.length > max) fail() }
function id(value: unknown) { if (!identifierSchema.safeParse(value).success) fail() }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail() }
function list(value: unknown, max = 5000): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value }

export function validateNodeState(input: unknown): NodeLearningState {
  const r = obj(input, ['originId', 'version', 'id', 'courseId', 'revision', 'createdAt', 'updatedAt', 'kind', 'chapters', 'sources', 'bindings', 'rounds', 'notes', 'events', 'supports', 'lastPointId', 'lastRoundId'])
  if (r.kind !== 'node-workspace' || r.version !== 1) fail()
  for (const key of ['id', 'courseId']) id(r[key])
  if (r.originId !== undefined) id(r.originId)
  integer(r.revision, 1); integer(r.createdAt); integer(r.updatedAt)
  const unique = new Set<string>()
  const recordId = (value: unknown) => { id(value); if (unique.has(String(value))) fail(); unique.add(String(value)) }
  const chapters = list(r.chapters, 500).map((value) => { const v = obj(value, ['id', 'title']); recordId(v.id); text(v.title, 500); if (!String(v.title).trim()) fail(); return String(v.id) })
  const sources = new Map<string, number>()
  let totalCharacters = 0
  for (const value of list(r.sources, 1000)) {
    const s = obj(value, ['id', 'originDocId', 'originSourceId', 'provenanceDocId', 'provenanceSourceId', 'name', 'role', 'text', 'contentHash', 'locators', 'anchors'])
    recordId(s.id); id(s.originDocId); id(s.originSourceId); text(s.name, 500); text(s.text, 2_000_000)
    if (s.provenanceDocId !== undefined) id(s.provenanceDocId)
    if (s.provenanceSourceId !== undefined) id(s.provenanceSourceId)
    if (!['slides', 'textbook', 'notes'].includes(String(s.role)) || typeof s.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(s.contentHash)) fail()
    totalCharacters += String(s.text).length
    if (totalCharacters > 8_000_000) fail()
    sources.set(String(s.id), String(s.text).length)
    for (const raw of s.anchors === undefined ? [] : list(s.anchors, 100_000)) { const a = obj(raw, ['nodeId', 'start', 'end']); id(a.nodeId); integer(a.start); integer(a.end, Number(a.start) + 1, String(s.text).length) }
    for (const value of list(s.locators, 100_000)) {
      const loc = obj(value, ['start', 'end', 'titlePath', 'page']); integer(loc.start); integer(loc.end, Number(loc.start) + 1, String(s.text).length)
      list(loc.titlePath, 50).forEach((part) => text(part, 500)); if (loc.page !== undefined) integer(loc.page, 1, 100_000)
    }
  }
  const refs = (value: unknown) => { for (const raw of list(value, 200)) { const ref = obj(raw, ['snapshotId', 'start', 'end']); id(ref.snapshotId); const length = sources.get(String(ref.snapshotId)); if (length === undefined) fail(); integer(ref.start); integer(ref.end, Number(ref.start) + 1, length) } }
  const points = new Set<string>()
  for (const value of list(r.bindings)) {
    const b = obj(value, ['pointId', 'chapterId', 'refs', 'originKey']); id(b.pointId); if (points.has(String(b.pointId)) || !chapters.includes(String(b.chapterId))) fail()
    if (b.originKey !== undefined) text(b.originKey, 1000)
    points.add(String(b.pointId)); refs(b.refs)
  }
  const rounds = new Map<string, { pointId: string; revision: number }>()
  for (const value of list(r.rounds)) {
    const round = obj(value, ['id', 'pointId', 'question', 'input', 'inputRevision', 'refs', 'status', 'updatedAt'])
    recordId(round.id); if (!points.has(String(round.pointId))) fail(); text(round.question, 3000); text(round.input, 10000); integer(round.inputRevision, 1); integer(round.updatedAt); refs(round.refs)
    if (!['active', 'paused', 'completed'].includes(String(round.status))) fail()
    rounds.set(String(round.id), { pointId: String(round.pointId), revision: Number(round.inputRevision) })
  }
  const supportIds = new Set<string>()
  for (const value of list(r.supports)) {
    const s = obj(value, ['id', 'roundId', 'inputRevision', 'question', 'learnerInput', 'level', 'docId', 'refs', 'sourceIds', 'createdAt', 'archiveId', 'restored'])
    recordId(s.id); id(s.docId); const round = rounds.get(String(s.roundId)); if (!round) fail()
    integer(s.inputRevision, 1, round.revision); text(s.question, 3000); text(s.learnerInput, 10000); integer(s.level, 1, 3); integer(s.createdAt); refs(s.refs)
    const sourceIds = list(s.sourceIds, 20); sourceIds.forEach(id)
    if (!sourceIds.length || sourceIds.length !== (s.refs as unknown[]).length || new Set(sourceIds).size !== sourceIds.length) fail()
    if (s.archiveId !== undefined) id(s.archiveId)
    if (s.restored !== undefined && typeof s.restored !== 'boolean') fail()
    supportIds.add(String(s.id))
  }
  for (const value of list(r.events, 20_000)) {
    const e = obj(value, ['id', 'roundId', 'inputRevision', 'type', 'createdAt', 'supportId', 'level'])
    recordId(e.id); const round = rounds.get(String(e.roundId)); if (!round) fail()
    integer(e.inputRevision, 1, round.revision); integer(e.createdAt)
    if (!['hint-viewed', 'source-viewed', 'collected'].includes(String(e.type))) fail()
    if (e.supportId !== undefined && !supportIds.has(String(e.supportId))) fail()
    if (e.level !== undefined) integer(e.level, 1, 3)
    if (e.type === 'hint-viewed') {
      const support = (r.supports as Array<Record<string, unknown>>).find((s) => s.id === e.supportId)
      if (!support || support.roundId !== e.roundId || support.level !== e.level || support.inputRevision !== e.inputRevision) fail()
    }
  }
  for (const value of list(r.notes, 10000)) {
    const n = obj(value, ['id', 'pointId', 'text', 'createdAt', 'roundId']); recordId(n.id); if (!points.has(String(n.pointId))) fail(); text(n.text); integer(n.createdAt)
    if (n.roundId !== undefined && rounds.get(String(n.roundId))?.pointId !== n.pointId) fail()
  }
  if (r.lastPointId !== undefined && !points.has(String(r.lastPointId))) fail()
  if (r.lastRoundId !== undefined && (!rounds.has(String(r.lastRoundId)) || rounds.get(String(r.lastRoundId))?.pointId !== r.lastPointId)) fail()
  return structuredClone(input) as NodeLearningState
}

/** Historical archive IDs remain unchanged inside hashed artifacts, even after restore. */
export function assertNodeSupportArchive(state: NodeLearningState, support: NodeSupport, archive: LearningArchive | undefined): asserts archive is LearningArchive {
  if (!archive || archive.courseId !== state.courseId || archive.originDocId !== support.docId || archive.sources.length !== support.sourceIds.length || archive.manifest.sources.length !== support.sourceIds.length) fail()
  support.sourceIds.forEach((id, index) => {
    const ref = support.refs[index]; const snapshot = state.sources.find((s) => s.id === ref.snapshotId)
    const source = archive.sources.find((s) => s.id === id); const manifest = archive.manifest.sources.find((s) => s.sourceId === id)
    if (!snapshot || !source || !manifest || source.text !== snapshot.text.slice(ref.start, ref.end) || source.contentHash !== manifest.contentHash) fail()
  })
}
