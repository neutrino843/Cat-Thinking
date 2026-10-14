import { buildKnowledgeCoverage } from './coverageView'
import type { CourseSnapshot } from './model'
export function courseGoalCoverage(snapshot: CourseSnapshot) {
  const coverage = new Map(buildKnowledgeCoverage(snapshot).map((item) => [item.pointId, item]))
  return (snapshot.course.goals ?? []).map((goal) => {
    const points = goal.pointIds.flatMap((id) => { const point = snapshot.points.find((item) => item.id === id && item.status !== 'retired'); return point ? [point] : [] })
    const states = points.map((point) => coverage.get(point.id))
    const material = points.length > 0 && points.length === goal.pointIds.length && points.every((point) => point.status === 'active' && point.sourceRefs.length > 0 && coverage.get(point.id)?.sourceStatus === 'valid')
    const questions = states.every((state) => state && (goal.level === 'application' ? state.applicationTaskCount > 0 || state.availableQuestionCount > 0 && state.coverageStatus === 'has-application' : goal.level === 'explanation' ? state.explanationQuestionCount > 0 : state.availableQuestionCount > 0)) && points.length > 0
    return { goal, points, material, questions, practiced: states.length > 0 && states.every((state) => state?.practiced), reasons: [...(!goal.confirmed ? ['范围尚待确认'] : []), ...(!material ? ['目标缺少有效资料或明确知识关联'] : []), ...(!questions ? ['目标缺少对应层次的题目或应用任务'] : [])] }
  })
}
