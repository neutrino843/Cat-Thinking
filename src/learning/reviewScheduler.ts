import type { ReviewSchedule } from './model'

export const REVIEW_RULE_VERSION = 'intervals-v1'
export const DEFAULT_REVIEW_INTERVALS = [1, 3, 7, 14] as const

export class LearningRuleError extends Error {
  constructor(public readonly code: 'invalid_date' | 'invalid_timezone' | 'invalid_capacity' | 'clock_regression' | 'invalid_intervals', message: string) {
    super(message)
    this.name = 'LearningRuleError'
  }
}

export function learningDate(utcTimestamp: number | string, timeZone = 'Asia/Shanghai'): string {
  const date = new Date(utcTimestamp)
  if (!Number.isFinite(date.getTime())) throw new LearningRuleError('invalid_date', '学习记录时间无效。')
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  } catch {
    throw new LearningRuleError('invalid_timezone', '课程时区无效，请确认时区设置。')
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function parseLearningDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new LearningRuleError('invalid_date', '日期须使用 YYYY-MM-DD。')
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new LearningRuleError('invalid_date', '学习日期不存在。')
  }
  return timestamp
}

/** Calendar dates are intentionally changed independently of UTC offsets and DST. */
export function addLearningDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new LearningRuleError('invalid_date', '复习间隔须为整数天。')
  const timestamp = parseLearningDate(value) + days * 86_400_000
  const result = new Date(timestamp).toISOString().slice(0, 10)
  parseLearningDate(result)
  return result
}

export interface ReviewSignal {
  attemptId: string
  utcTimestamp: number
  timeZone: string
  action?: 'submit' | 'skip' | 'pause' | 'resume' | 'remediation-complete'
  outcome: 'success' | 'partial' | 'failure' | 'disputed' | 'skipped'
  answerProvided: boolean
  answerRevealedBeforeSubmit: boolean
  questionType: 'objective' | 'short-answer' | 'application'
  selfAssessmentComplete: boolean
  recallDifficulty?: 'again' | 'hard' | 'good' | 'easy'
}

export interface ReviewConfiguration {
  intervals?: readonly number[]
  ruleVersion?: string
}

export interface ReviewProposal {
  schedule: ReviewSchedule
  eligibleSuccess: boolean
  reason: string
}

/** A submission is evidence about one explicit recall target, never proof of mastery. */
export function proposeReviewSchedule(previous: ReviewSchedule, signal: ReviewSignal, config: ReviewConfiguration = {}): ReviewProposal {
  const intervals = config.intervals ?? DEFAULT_REVIEW_INTERVALS
  if (!intervals.length || intervals.some((value) => !Number.isInteger(value) || value < 1) ||
    intervals.some((value, index) => index > 0 && value < intervals[index - 1])) {
    throw new LearningRuleError('invalid_intervals', '复习间隔须为递增的正整数天。')
  }
  const today = learningDate(signal.utcTimestamp, signal.timeZone)
  parseLearningDate(previous.dueDate)
  if (previous.lastLearningDate && today < previous.lastLearningDate) {
    throw new LearningRuleError('clock_regression', '当前学习日期早于最近记录，请确认系统时间和课程时区。')
  }
  const action = signal.action ?? 'submit'
  // An assessment revision may expose failure or a disputed answer. It must stop the queue,
  // while replaying a success for the same original submission may never advance it twice.
  if (signal.attemptId && previous.lastAttemptId === signal.attemptId && action === 'submit' &&
    signal.outcome !== 'failure' && signal.outcome !== 'disputed' && signal.outcome !== 'partial' && signal.recallDifficulty !== 'again') {
    return { schedule: previous, eligibleSuccess: false, reason: '本次提交已用于排期，未重复推进。' }
  }
  if (action === 'skip' || signal.outcome === 'skipped') {
    return { schedule: previous, eligibleSuccess: false, reason: '跳过保留原复习安排，不计答错。' }
  }
  if (signal.questionType === 'application') {
    return { schedule: previous, eligibleSuccess: false, reason: '应用任务单独记录，不推进记忆练习间隔。' }
  }
  const base: ReviewSchedule = { ...previous, revision: previous.revision + 1, updatedAt: signal.utcTimestamp,
    ruleVersion: config.ruleVersion ?? previous.ruleVersion ?? REVIEW_RULE_VERSION }
  if (action === 'pause' || signal.outcome === 'disputed') {
    return { schedule: { ...base, status: 'paused', suspendedReason: signal.outcome === 'disputed' ? '题目或答案有疑问' : '用户暂停' }, eligibleSuccess: false,
      reason: signal.outcome === 'disputed' ? '题目或答案有疑问，已暂停复习。' : '已暂停复习，档位保持。' }
  }
  if (action === 'resume') {
    return { schedule: { ...base, status: 'active', suspendedReason: undefined }, eligibleSuccess: false, reason: '已恢复复习，保留原到期日期和档位。' }
  }
  if (previous.status === 'paused') {
    return { schedule: previous, eligibleSuccess: false, reason: '暂停中的题目不自动排期。' }
  }
  const recorded = { ...base, lastAttemptId: signal.attemptId, lastLearningDate: today }
  const withDate = (days: number) => previous.manual ? previous.dueDate : addLearningDays(today, days)
  if (action === 'remediation-complete') {
    return { schedule: { ...recorded, status: 'active', dueDate: withDate(1) }, eligibleSuccess: false,
      reason: previous.manual ? '补学已完成，保留手动日期。' : '补学已完成，下一学习日再次验证。' }
  }
  if (!signal.answerProvided) {
    return { schedule: { ...recorded, dueDate: withDate(1) }, eligibleSuccess: false, reason: '未提交有效回答，不推进复习档位。' }
  }
  if (signal.outcome === 'failure' || signal.recallDifficulty === 'again') {
    return { schedule: { ...recorded, stage: 0, status: 'remediation', dueDate: previous.manual ? previous.dueDate : today },
      eligibleSuccess: false, reason: '需要补学；补学后安排下一学习日验证。' }
  }
  if (signal.questionType === 'short-answer' && (!signal.selfAssessmentComplete || !signal.recallDifficulty)) {
    return { schedule: { ...base, dueDate: withDate(1) }, eligibleSuccess: false,
      reason: '简答题需完成自评并选择回忆难度，才可推进复习间隔。' }
  }
  if (signal.outcome === 'partial') {
    return { schedule: { ...recorded, status: 'active', dueDate: withDate(1) }, eligibleSuccess: false,
      reason: '部分回忆保留档位，建议下一学习日再练。' }
  }
  if (signal.answerRevealedBeforeSubmit) {
    return { schedule: { ...recorded, status: 'active', dueDate: withDate(1) }, eligibleSuccess: false,
      reason: '作答前已查看答案，本次只记录纠正，建议下一学习日验证。' }
  }
  if (previous.lastLearningDate === today || previous.successfulLearningDates?.includes(today)) {
    return { schedule: { ...recorded, status: 'active' }, eligibleSuccess: false,
      reason: '同一学习日的重复成功只记录当次纠正，不推进复习间隔。' }
  }
  const stage = Math.min(Math.max(0, previous.stage) + 1, intervals.length)
  const days = intervals[stage - 1]
  return { schedule: { ...recorded, stage, status: 'active', dueDate: withDate(days),
    successfulLearningDates: [...new Set([...(previous.successfulLearningDates ?? []), today])] }, eligibleSuccess: true,
    reason: previous.manual ? '本次有效回忆已记录，保留手动复习日期。' : `不同学习日的有效回忆，建议 ${days} 天后复习。` }
}

export function previewTimeZoneChange(utcTimestamp: number, previousTimeZone: string, nextTimeZone: string) {
  const previousDate = learningDate(utcTimestamp, previousTimeZone)
  const nextDate = learningDate(utcTimestamp, nextTimeZone)
  return { previousDate, nextDate, changesCurrentLearningDate: previousDate !== nextDate,
    historicalDatesRemainUnchanged: true as const }
}
