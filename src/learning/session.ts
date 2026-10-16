import { visibleQuestions } from './workspaceView'
import { LearningError, learningBase, type CourseSnapshot, type KnowledgePoint, type LearningSession } from './model'
import { learningDate } from './reviewScheduler'

export const STEP_LABELS = { read: '阅读核心说明', recall: '主动回忆', practice: '完成已有练习', source: '回看原文', explain: '写自己的解释' }
export function sessionStepIndex(session: LearningSession): number {
  return session.checkpoint?.stepIndex ?? Math.max(0, session.steps.findIndex((step) => step.status === 'pending'))
}
export function sessionInvalidReason(session: LearningSession, snapshot: CourseSnapshot): string | undefined {
  if (session.courseId !== snapshot.course.id) return '会话不属于当前课程。'
  if (session.checkpoint && session.checkpoint.goalVersion !== snapshot.course.goalVersion) return '课程目标已变化，请核对范围后重新确认续学。'
  for (const [id, hash] of Object.entries(session.checkpoint?.archiveHashes ?? {})) if (!snapshot.archives.some((archive) => archive.id === id && archive.contentHash === hash)) return '会话原文归档已缺失或变化，请先检查资料。'
  for (const id of session.pointIds) {
    const point = snapshot.points.find((item) => item.id === id)
    if (!point || point.status !== 'active') return '会话知识点已删除或待确认，请先检查知识结构。'
    if (session.checkpoint?.pointRevisions[id] !== undefined && session.checkpoint.pointRevisions[id] !== point.revision) return '知识内容已更新，请核对内容后重新确认续学。'
    for (const ref of point.sourceRefs) {
      const archive = snapshot.archives.find((item) => item.id === ref.archiveId)
      const source = archive?.sources.find((item) => item.id === ref.sourceId)
      if (!source || ref.start < 0 || ref.end > source.text.length) return '原文依据已经不可用，请先检查资料。'
      if (session.checkpoint?.archiveHashes[ref.archiveId] && session.checkpoint.archiveHashes[ref.archiveId] !== archive?.contentHash) return '归档版本已变化，请先核对资料。'
    }
  }
  return undefined
}
export function bindSession(session: LearningSession, snapshot: CourseSnapshot): LearningSession {
  return { ...session, checkpoint: { stepIndex: sessionStepIndex(session), paused: session.checkpoint?.paused ?? false,
    hidden: session.checkpoint?.hidden ?? false, ...session.checkpoint, goalVersion: snapshot.course.goalVersion,
    pointRevisions: Object.fromEntries(snapshot.points.filter((point) => session.pointIds.includes(point.id)).map((point) => [point.id, point.revision])),
    archiveHashes: Object.fromEntries(snapshot.archives.filter((archive) => snapshot.points.some((point) => session.pointIds.includes(point.id) && point.sourceRefs.some((ref) => ref.archiveId === archive.id))).map((archive) => [archive.id, archive.contentHash])) } }
}
export function createGuidedSession(snapshot: CourseSnapshot, points: readonly KnowledgePoint[]): LearningSession {
  if (!points.length || points.some((point) => point.courseId !== snapshot.course.id || point.status !== 'active')) throw new LearningError('invalid', '先确认课程知识点，再开始学习。')
  if (points.length > 144) throw new LearningError('limit', '单次学习范围过大，请分章节开始。')
  const base = learningBase(snapshot.course.id)
  const session: LearningSession = { ...base, kind: 'session', purpose: 'guided', planning: { date: learningDate(base.createdAt), minutes: points.length * 10 }, title: points.length === 1 ? points[0].title : `${points[0].chapter || '章节'}学习`,
    pointIds: points.map((point) => point.id), status: 'active', steps: points.flatMap((point) => (['read', 'recall', 'practice', 'source', 'explain'] as const).map((action) => ({ pointId: point.id, action, status: 'pending', note: '' }))) }
  const bound = bindSession(session, snapshot)
  const reason = sessionInvalidReason(bound, snapshot); if (reason) throw new LearningError('invalid', reason)
  return bound
}
export function advanceSession(session: LearningSession, status: 'completed' | 'skipped', note: string): LearningSession {
  if (session.status !== 'active') throw new LearningError('invalid', '会话已结束。')
  const index = sessionStepIndex(session)
  const steps = session.steps.map((step, i) => i === index ? { ...step, status, note } : step)
  const next = steps.findIndex((step, i) => i > index && step.status === 'pending')
  const complete = next === -1
  return { ...session, steps, ...(complete ? { status: steps.every((step) => step.status === 'completed') ? 'completed' : 'ended', endedAt: Date.now() } : {}),
    ...(session.checkpoint ? { checkpoint: { ...session.checkpoint, stepIndex: complete ? index : next, hidden: !complete && steps[next].action === 'recall', position: 0, paused: false, ...(complete ? { endedReason: 'completed' as const } : {}) } } : {}) }
}
export function resumableSessions(snapshots: readonly CourseSnapshot[]) {
  return snapshots.filter((snapshot) => !snapshot.course.example).flatMap((snapshot) => snapshot.sessions.filter((session) => session.status === 'active' && session.purpose !== 'exam').map((session) => ({ snapshot, session, reason: sessionInvalidReason(session, snapshot) })))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id))
}

/** New sessions focus on a question; old saved sessions retain their original steps. */
export function createFocusedSession(snapshot: CourseSnapshot, points: readonly KnowledgePoint[]): LearningSession {
  const session = createGuidedSession(snapshot, points)
  session.steps = points.flatMap((point) => (visibleQuestions(snapshot, point.id).length ? ['practice', 'recall', 'explain'] as const : ['read', 'explain'] as const).map((action) => ({ pointId: point.id, action, status: 'pending' as const, note: '' })))
  if (session.checkpoint) session.checkpoint = { ...session.checkpoint, stepIndex: 0, hidden: true }
  return session
}
