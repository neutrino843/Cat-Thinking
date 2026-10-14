import { identifierSchema } from '@cat-thinking/analysis-contracts'
import { learningDate, parseLearningDate, LearningRuleError } from './reviewScheduler'

export type TodayPlanAction = 'later' | 'tomorrow'
export interface TodayPlanPreference {
  date: string
  courseId: string
  taskId: string
  action: TodayPlanAction
  updatedAt: number
}
interface TodayPlanPreferencePayload { version: 1; items: TodayPlanPreference[] }

export const TODAY_PLAN_PREFERENCES_KEY = 'msz.learning.today-plan.v1'
const MAX_ITEMS = 500

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new LearningRuleError('invalid_capacity', '今日计划偏好格式无效。')
  return value
}
export const todayPlanTaskKey = (courseId: string, taskId: string): string => JSON.stringify([courseId, taskId])
export function todayPlanActionFor(items: readonly TodayPlanPreference[], courseId: string, taskId: string, now = Date.now()): TodayPlanAction | undefined {
  const date = learningDate(now)
  return items.find((item) => item.date === date && item.courseId === courseId && item.taskId === taskId)?.action
}

export function parseTodayPlanPreferences(input: unknown): TodayPlanPreferencePayload {
  const payload = exact(input, ['version', 'items'])
  if (payload.version !== 1 || !Array.isArray(payload.items) || payload.items.length > MAX_ITEMS) throw new LearningRuleError('invalid_capacity', '今日计划偏好格式无效。')
  const seen = new Set<string>()
  const items = payload.items.map<TodayPlanPreference>((raw) => {
    const item = exact(raw, ['date', 'courseId', 'taskId', 'action', 'updatedAt'])
    const date = item.date
    if (typeof date !== 'string') throw new LearningRuleError('invalid_date', '今日计划日期无效。')
    parseLearningDate(date)
    const courseId = identifierSchema.safeParse(item.courseId)
    const taskId = identifierSchema.safeParse(item.taskId)
    const action = item.action
    const updatedAt = item.updatedAt
    if (action !== 'later' && action !== 'tomorrow') throw new LearningRuleError('invalid_capacity', '今日计划偏好内容无效。')
    if (!courseId.success || !taskId.success || !Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) {
      throw new LearningRuleError('invalid_capacity', '今日计划偏好内容无效。')
    }
    const key = `${date}:${todayPlanTaskKey(courseId.data, taskId.data)}`
    if (seen.has(key)) throw new LearningRuleError('invalid_capacity', '今日计划偏好存在重复任务。')
    seen.add(key)
    return { date, courseId: courseId.data, taskId: taskId.data, action, updatedAt: updatedAt as number }
  })
  return { version: 1, items }
}

export function loadTodayPlanPreferences(now = Date.now()): TodayPlanPreference[] {
  const date = learningDate(now)
  try {
    const raw = localStorage.getItem(TODAY_PLAN_PREFERENCES_KEY)
    if (!raw) return []
    return parseTodayPlanPreferences(JSON.parse(raw)).items.filter((item) => item.date === date)
  } catch { return [] }
}

function write(items: TodayPlanPreference[]): void {
  const payload = parseTodayPlanPreferences({ version: 1, items })
  localStorage.setItem(TODAY_PLAN_PREFERENCES_KEY, JSON.stringify(payload))
  window.dispatchEvent(new Event('msz:today-plan-changed'))
}

export function saveTodayPlanPreference(courseId: string, taskId: string, action: TodayPlanAction, now = Date.now()): void {
  const date = learningDate(now)
  const current = loadTodayPlanPreferences(now).filter((item) => todayPlanTaskKey(item.courseId, item.taskId) !== todayPlanTaskKey(courseId, taskId))
  write([...current, { date, courseId, taskId, action, updatedAt: now }])
}

export function clearTodayPlanPreference(courseId: string, taskId: string, now = Date.now()): void {
  const key = todayPlanTaskKey(courseId, taskId)
  write(loadTodayPlanPreferences(now).filter((item) => todayPlanTaskKey(item.courseId, item.taskId) !== key))
}
