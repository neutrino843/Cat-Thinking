import type { CourseSnapshot } from './model'
import type { DailyPlanCandidate } from './dailyPlan'
import { archivedQuestions, questionKey, sameQuestion } from './workspaceView'
import { buildLearningPath, questionRefKey, resolveKnowledgePointId } from './knowledgeGraph'
import { buildKnowledgeCoverage } from './coverageView'

/** Adapts persisted facts into suggested tasks; it never invents mastery, confirmations or questions. */
export function coursePlanCandidates(snapshot: CourseSnapshot): DailyPlanCandidate[] {
  const questions = archivedQuestions(snapshot.archives.filter((archive) => archive.courseId === snapshot.course.id))
  const coverage = buildKnowledgeCoverage(snapshot)
  const observations = new Map(coverage.map((item) => [item.pointId, item]))
  const candidates: DailyPlanCandidate[] = snapshot.schedules.filter((schedule) => schedule.courseId === snapshot.course.id).map((schedule) => {
    const item = questions.find((question) => sameQuestion(question.ref, schedule.question))
    const point = snapshot.points.find((point) => point.status === 'active' && point.questionRefs.some((ref) => ref.confirmed && sameQuestion(ref, schedule.question)))
    const disputed = snapshot.issues.some((issue) => issue.status === 'open' && sameQuestion(issue.question, schedule.question))
    const isApplication = point?.questionLevels?.[questionRefKey(schedule.question)] === 'application'
    return { id: schedule.id, courseId: snapshot.course.id, pointId: point?.id, targetId: questionKey(schedule.question),
      type: isApplication ? 'application' : schedule.status === 'remediation' ? 'remediation' : 'review',
      title: item?.question.prompt ?? '题目不可用', estimatedMinutes: item?.question.type === 'short-answer' ? 5 : 2, questionCount: 1, dueDate: schedule.dueDate,
      paused: schedule.status === 'paused' || disputed,
      sourceStatus: item ? point?.sourceRefs.length ? observations.get(point.id)?.sourceStatus ?? 'pending' : 'valid' : 'missing' }
  })
  const practiced = coverage.filter((item) => item.practiced).map((item) => item.pointId)
  const path = buildLearningPath(snapshot, practiced)
  const neededBy = new Map<string, string[]>()
  for (const unit of path) {
    for (const prerequisite of unit.unpracticedPrerequisiteIds) neededBy.set(prerequisite, [...(neededBy.get(prerequisite) ?? []), unit.title])
  }
  for (const [order, unit] of path.entries()) {
    const point = snapshot.points.find((item) => item.id === unit.pointId)
    if (!point) continue
    const state = observations.get(point.id)
    const needsRemediation = state?.observation === 'needs-remediation'
    if (practiced.includes(unit.pointId) && !needsRemediation) continue
    if (needsRemediation && candidates.some((candidate) => candidate.pointId === point.id && candidate.type === 'remediation')) continue
    const isPrerequisite = neededBy.has(point.id)
    candidates.push({ id: `point:${point.id}`, courseId: snapshot.course.id, pointId: point.id,
      type: needsRemediation ? 'remediation' : isPrerequisite ? 'prerequisite' : 'new', title: point.title,
      reason: needsRemediation ? '已有回答显示需要补学，先回看定义和原文。' : isPrerequisite ? `这是 ${neededBy.get(point.id)?.join('、')} 已确认的前置知识，建议先学习。` :
        point.sourceRefs.length ? unit.reason : '这是个人整理，尚无原文依据；可先阅读并补充说明。',
      estimatedMinutes: 10, questionCount: 0, order,
      sourceStatus: point.sourceRefs.length ? state?.sourceStatus ?? 'pending' : 'valid' })
  }
  for (const point of snapshot.points.filter((item) => item.status === 'pending')) candidates.push({ id: `point:${point.id}`,
    courseId: snapshot.course.id, pointId: point.id, type: 'new', title: point.title,
    reason: '知识点定义或关联已变化，需要重新确认。', estimatedMinutes: 10, questionCount: 0, sourceStatus: 'pending' })
  for (const task of snapshot.applicationTasks.filter((item) => item.status === 'pending' && item.courseId === snapshot.course.id)) {
    const pointIds = [...new Set(task.pointIds.map((id) => resolveKnowledgePointId(id, snapshot.merges)))]
    const allActive = pointIds.length > 0 && pointIds.every((id) => snapshot.points.some((point) => point.id === id && point.status === 'active'))
    const sourceMissing = pointIds.some((id) => observations.get(id)?.sourceStatus === 'missing' && snapshot.points.find((point) => point.id === id)?.sourceRefs.length)
    candidates.push({ id: task.id, courseId: snapshot.course.id, pointId: pointIds[0], type: 'application', title: task.title,
      estimatedMinutes: 10, questionCount: 0, sourceStatus: !allActive ? 'pending' : sourceMissing ? 'missing' : 'valid' })
  }
  return candidates
}
