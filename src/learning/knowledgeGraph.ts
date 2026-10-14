import type { KnowledgeMergeEvent, KnowledgePoint, KnowledgeRelation, QuestionRef } from './model'

export class LearningGraphError extends Error {
  constructor(public readonly code: 'invalid' | 'cycle' | 'confirmation_required' | 'conflict' | 'missing', message: string,
    public readonly pointIds: string[] = []) {
    super(message)
    this.name = 'LearningGraphError'
  }
}
export interface KnowledgeGraphState {
  points: readonly KnowledgePoint[]
  relations: readonly KnowledgeRelation[]
  merges?: readonly KnowledgeMergeEvent[]
}
export interface KnowledgeMatchCandidate {
  fromPointId: string
  toPointId: string
  reason: 'same-title' | 'shared-alias'
  matchedName: string
  sameChapter: boolean
  requiresConfirmation: true
}
export const questionRefKey = (question: Pick<QuestionRef, 'archiveId' | 'artifactId' | 'questionId'>) =>
  JSON.stringify([question.archiveId, question.artifactId, question.questionId])
const normalizeName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')

/** Historical tasks keep their original identity; this resolves their current display destination. */
export function resolveKnowledgePointId(pointId: string, events: readonly KnowledgeMergeEvent[] = []): string {
  const undone = new Set(events.filter((event) => event.action === 'undo').map((event) => event.undoOf))
  const aliases = new Map(events.filter((event) => event.action === 'merge' && !undone.has(event.id))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((event) => [event.fromPointId, event.toPointId]))
  const seen = new Set<string>()
  let current = pointId
  while (aliases.has(current)) {
    if (seen.has(current)) throw new LearningGraphError('cycle', '知识点别名形成循环。', [...seen, current])
    seen.add(current)
    current = aliases.get(current) ?? current
  }
  return current
}

/** This local lookup proposes names for comparison; equality never establishes concept identity. */
export function findKnowledgeCandidates(point: KnowledgePoint, points: readonly KnowledgePoint[]): KnowledgeMatchCandidate[] {
  const names = new Set([point.title, ...point.aliases].map(normalizeName).filter(Boolean))
  const result: KnowledgeMatchCandidate[] = []
  for (const other of points) {
    if (other.id === point.id || other.courseId !== point.courseId || other.status !== 'active') continue
    const matchedName = [other.title, ...other.aliases].map(normalizeName).find((name) => name && names.has(name))
    if (!matchedName) continue
    result.push({ fromPointId: point.id, toPointId: other.id,
      reason: normalizeName(point.title) === normalizeName(other.title) ? 'same-title' : 'shared-alias',
      matchedName, sameChapter: point.chapter === other.chapter, requiresConfirmation: true })
  }
  return result.sort((left, right) => Number(right.sameChapter) - Number(left.sameChapter) || left.toPointId.localeCompare(right.toPointId))
}

export function prerequisiteCycle(relations: readonly KnowledgeRelation[]): string[] | null {
  const next = new Map<string, string[]>()
  for (const relation of relations) {
    if (!relation.confirmed || relation.type !== 'prerequisite') continue
    next.set(relation.fromPointId, [...(next.get(relation.fromPointId) ?? []), relation.toPointId])
  }
  const complete = new Set<string>()
  const visiting = new Set<string>()
  const path: string[] = []
  const visit = (pointId: string): string[] | null => {
    if (visiting.has(pointId)) return [...path.slice(path.indexOf(pointId)), pointId]
    if (complete.has(pointId)) return null
    visiting.add(pointId)
    path.push(pointId)
    for (const child of next.get(pointId) ?? []) {
      const cycle = visit(child)
      if (cycle) return cycle
    }
    path.pop()
    visiting.delete(pointId)
    complete.add(pointId)
    return null
  }
  for (const pointId of next.keys()) {
    const cycle = visit(pointId)
    if (cycle) return cycle
  }
  return null
}

export function addConfirmedPrerequisite(state: KnowledgeGraphState, relation: KnowledgeRelation): KnowledgeRelation[] {
  if (!relation.confirmed || relation.type !== 'prerequisite') throw new LearningGraphError('confirmation_required', '前置关系须由用户确认。')
  const from = state.points.find((point) => point.id === relation.fromPointId && point.status === 'active')
  const to = state.points.find((point) => point.id === relation.toPointId && point.status === 'active')
  if (!from || !to || from.courseId !== to.courseId || relation.courseId !== from.courseId) {
    throw new LearningGraphError('missing', '前置关系两端须是同一课程的有效知识点。')
  }
  if (state.relations.some((item) => item.id === relation.id)) throw new LearningGraphError('conflict', '关系身份已存在。')
  if (state.relations.some((item) => item.confirmed && item.type === 'prerequisite' && item.fromPointId === from.id && item.toPointId === to.id)) {
    throw new LearningGraphError('conflict', '这一前置关系已存在。')
  }
  const next = [...state.relations, structuredClone(relation)]
  const cycle = prerequisiteCycle(next)
  if (cycle) throw new LearningGraphError('cycle', '前置关系形成循环，请调整这些知识点的关系。', cycle)
  return next
}

export interface LearningPathUnit {
  pointId: string
  title: string
  prerequisiteIds: string[]
  unpracticedPrerequisiteIds: string[]
  reason: string
  mayStartFreely: true
}

/** Parent/child structure is presentation only; confirmed prerequisite edges control recommendations. */
export function buildLearningPath(state: KnowledgeGraphState, practicedPointIds: readonly string[] = [], order: readonly string[] = []): LearningPathUnit[] {
  const active = state.points.filter((point) => point.status === 'active')
  const pointIds = new Set(active.map((point) => point.id))
  const relations = state.relations.filter((relation) => relation.confirmed && relation.type === 'prerequisite' &&
    pointIds.has(relation.fromPointId) && pointIds.has(relation.toPointId))
  const cycle = prerequisiteCycle(relations)
  if (cycle) throw new LearningGraphError('cycle', '课程前置关系形成循环。', cycle)
  const practiced = new Set(practicedPointIds)
  const positions = new Map(order.map((pointId, index) => [pointId, index]))
  const sorted = [...active].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.chapter.localeCompare(right.chapter) || left.id.localeCompare(right.id))
  const visited = new Set<string>()
  const result: LearningPathUnit[] = []
  const visit = (point: KnowledgePoint) => {
    if (visited.has(point.id)) return
    const prerequisiteIds = relations.filter((relation) => relation.toPointId === point.id).map((relation) => relation.fromPointId)
    for (const prerequisiteId of prerequisiteIds) {
      const prior = sorted.find((candidate) => candidate.id === prerequisiteId)
      if (prior) visit(prior)
    }
    visited.add(point.id)
    const missing = prerequisiteIds.filter((pointId) => !practiced.has(pointId))
    result.push({ pointId: point.id, title: point.title, prerequisiteIds, unpracticedPrerequisiteIds: missing,
      reason: missing.length ? '存在尚未练习的已确认前置知识，建议先练前置知识。' :
        prerequisiteIds.length ? '已确认前置知识有练习记录，可继续本知识点。' : '按用户章节顺序推荐；尚无确认的前置关系。', mayStartFreely: true })
  }
  sorted.forEach(visit)
  return result
}

export interface MergeOperation { eventId: string; at: number; confirmed?: boolean }
export interface KnowledgeTransformation { points: KnowledgePoint[]; relations: KnowledgeRelation[]; event: KnowledgeMergeEvent }

function requireOperation(state: KnowledgeGraphState, operation: MergeOperation) {
  if (!operation.eventId || !Number.isFinite(operation.at)) throw new LearningGraphError('invalid', '合并事件须有身份和有效时间。')
  if (state.merges?.some((event) => event.id === operation.eventId)) throw new LearningGraphError('conflict', '合并事件身份已存在。')
}

export function mergeKnowledgePoints(state: KnowledgeGraphState, fromId: string, toId: string, operation: MergeOperation): KnowledgeTransformation {
  requireOperation(state, operation)
  if (operation.confirmed !== true) throw new LearningGraphError('confirmation_required', '比较定义与来源后，确认是同一概念才能合并。')
  const from = state.points.find((point) => point.id === fromId && point.status === 'active')
  const to = state.points.find((point) => point.id === toId && point.status === 'active')
  if (!from || !to || fromId === toId || from.courseId !== to.courseId) throw new LearningGraphError('invalid', '请选择同一课程的两个不同有效知识点。')
  const questions = new Map(to.questionRefs.map((question) => [questionRefKey(question), structuredClone(question)]))
  for (const question of from.questionRefs) {
    const key = questionRefKey(question)
    const existing = questions.get(key)
    questions.set(key, { ...structuredClone(question), confirmed: existing?.confirmed === true || question.confirmed })
  }
  const sources = new Map([...to.sourceRefs, ...from.sourceRefs].map((source) => [JSON.stringify(source), structuredClone(source)]))
  const nextTo: KnowledgePoint = { ...structuredClone(to), revision: to.revision + 1, updatedAt: operation.at,
    aliases: [...new Set([...to.aliases, from.title, ...from.aliases].filter((name) => name !== to.title))],
    sourceRefs: [...sources.values()], questionRefs: [...questions.values()],
    questionLevels: { ...from.questionLevels, ...to.questionLevels } }
  // The retired origin retains its original definition, notes, source/attempt identity and chapter.
  const nextFrom: KnowledgePoint = { ...structuredClone(from), revision: from.revision + 1, updatedAt: operation.at, status: 'retired' }
  const affected = state.relations.filter((relation) => relation.fromPointId === fromId || relation.toPointId === fromId)
  const afterRelationRevisions: Record<string, number> = {}
  const relations = state.relations.flatMap((relation) => {
    if (!affected.some((item) => item.id === relation.id)) return [structuredClone(relation)]
    const changed = { ...structuredClone(relation), fromPointId: relation.fromPointId === fromId ? toId : relation.fromPointId,
      toPointId: relation.toPointId === fromId ? toId : relation.toPointId, revision: relation.revision + 1, updatedAt: operation.at }
    if (changed.fromPointId === changed.toPointId) { afterRelationRevisions[relation.id] = -1; return [] }
    afterRelationRevisions[relation.id] = changed.revision
    return [changed]
  })
  const cycle = prerequisiteCycle(relations)
  if (cycle) throw new LearningGraphError('cycle', '合并会使已确认前置关系形成循环，未修改知识点。', cycle)
  const event: KnowledgeMergeEvent = { version: 1, kind: 'merge', id: operation.eventId, courseId: from.courseId,
    revision: 1, createdAt: operation.at, updatedAt: operation.at, fromPointId: fromId, toPointId: toId, action: 'merge',
    beforePoints: structuredClone([from, to]), beforeRelations: structuredClone(affected),
    afterPointRevisions: { [fromId]: nextFrom.revision, [toId]: nextTo.revision }, afterRelationRevisions }
  return { points: state.points.map((point) => point.id === fromId ? nextFrom : point.id === toId ? nextTo : structuredClone(point)), relations, event }
}

export function undoKnowledgeMerge(state: KnowledgeGraphState, mergeId: string, operation: MergeOperation): KnowledgeTransformation {
  requireOperation(state, operation)
  const original = state.merges?.find((event) => event.id === mergeId && event.action === 'merge')
  if (!original?.beforePoints?.length || !original.beforeRelations || !original.afterPointRevisions || !original.afterRelationRevisions) {
    throw new LearningGraphError('missing', '合并事件缺少可撤销快照。')
  }
  if (state.merges?.some((event) => event.action === 'undo' && event.undoOf === mergeId)) throw new LearningGraphError('conflict', '该合并已撤销。')
  for (const [pointId, revision] of Object.entries(original.afterPointRevisions)) {
    if (state.points.find((point) => point.id === pointId)?.revision !== revision) {
      throw new LearningGraphError('conflict', '合并后的知识点已修改，请先处理后续修改再撤销。', [pointId])
    }
  }
  for (const [relationId, revision] of Object.entries(original.afterRelationRevisions)) {
    const current = state.relations.find((relation) => relation.id === relationId)
    if (revision === -1 ? current !== undefined : current?.revision !== revision) {
      throw new LearningGraphError('conflict', '合并后的关系已修改，未覆盖后续修改。')
    }
  }
  const priorPoints = new Map(original.beforePoints.map((point) => [point.id, point]))
  const points = state.points.map((point) => {
    const prior = priorPoints.get(point.id)
    return prior ? { ...structuredClone(prior), revision: point.revision + 1, updatedAt: operation.at } : structuredClone(point)
  })
  const affectedIds = new Set(Object.keys(original.afterRelationRevisions))
  const relations = [...state.relations.filter((relation) => !affectedIds.has(relation.id)).map((relation) => structuredClone(relation)),
    ...original.beforeRelations.map((relation) => ({ ...structuredClone(relation),
      revision: Math.max(relation.revision, original.afterRelationRevisions?.[relation.id] ?? 0) + 1, updatedAt: operation.at }))]
  const cycle = prerequisiteCycle(relations)
  if (cycle) throw new LearningGraphError('cycle', '撤销会与新增前置关系形成循环，未修改现有资料。', cycle)
  const event: KnowledgeMergeEvent = { version: 1, kind: 'merge', id: operation.eventId, courseId: original.courseId,
    revision: 1, createdAt: operation.at, updatedAt: operation.at, fromPointId: original.fromPointId,
    toPointId: original.toPointId, action: 'undo', undoOf: mergeId }
  return { points, relations, event }
}
