import type { CourseSnapshot, LearningSession } from './model'
import { saveEntity } from './repository'
import { advanceSession, bindSession, sessionStepIndex } from './session'
import { learningDate } from './reviewScheduler'

export type SessionStepAction = LearningSession['steps'][number]['action']
export type SessionCheckpointValues = Partial<NonNullable<LearningSession['checkpoint']>>
type SaveEntity = (updated: LearningSession, expectedRevision: number | null) => Promise<LearningSession>

export const SESSION_SAVE_ERROR = '会话保存冲突或失败，当前文字仍在输入框中。请复制文字并重新读取会话。'

/**
 * v2.1 需求3：引导学习会话的串行持久化编排（框架无关，供 useSessionRunner 与单测使用）。
 * 写入严格串行，revision 永远基于最近一次保存结果；任一次保存失败即熔断，
 * 后续入队不再落库（避免冲突覆盖），由 UI 层提示用户复制输入并重新读取。
 */
export class SessionRunner {
  private chain: Promise<void> = Promise.resolve()
  private inflightCount = 0
  private broken = false
  latest: LearningSession

  constructor(session: LearningSession, private readonly fallbackSnapshot: CourseSnapshot, private readonly save: SaveEntity = saveEntity as unknown as SaveEntity) {
    this.latest = session
  }

  /** 是否仍有已入队未落库的写入。 */
  get isWriting(): boolean { return this.inflightCount > 0 }
  /** 是否已经发生过保存冲突/失败（熔断中）。 */
  get hasFailed(): boolean { return this.broken }

  enqueue(transform: (value: LearningSession) => LearningSession): Promise<LearningSession | undefined> {
    this.inflightCount++
    const attempt = this.chain.then(async () => {
      if (this.broken) return undefined
      const updated = transform(this.latest)
      const stamped = updated.planning
        ? { ...updated, planning: { ...updated.planning, date: learningDate(Date.now()) } }
        : updated
      const saved = await this.save(stamped, this.latest.revision)
      this.latest = saved
      return saved
    })
    const settled = attempt.then(
      (saved) => saved,
      (reason) => { this.broken = true; throw reason },
    )
    this.chain = settled.then(() => undefined, () => undefined)
    settled.finally(() => { this.inflightCount-- }).catch(() => undefined)
    return settled
  }

  /** 绑定/更新检查点；旧会话首次写入时用传入 snapshot 完成绑定（UI 每拍给最新值）。 */
  checkpoint(values: SessionCheckpointValues, snapshot: CourseSnapshot = this.fallbackSnapshot): Promise<LearningSession | undefined> {
    return this.enqueue((value) => {
      const bound = value.checkpoint ? value : bindSession(value, snapshot)
      if (!bound.checkpoint) throw new Error('会话检查点不可用。')
      return { ...bound, checkpoint: { ...bound.checkpoint, ...values } }
    })
  }

  /** 文字自动保存：步骤索引以入队执行时的最新会话为准，避免快速输入时闭包过期。 */
  writeNote(text: string): Promise<LearningSession | undefined> {
    return this.enqueue((record) => {
      const index = sessionStepIndex(record)
      return { ...record, steps: record.steps.map((item, i) => (i === index ? { ...item, note: text } : item)) }
    })
  }

  step(kind: 'completed' | 'skipped', note: string): Promise<LearningSession | undefined> {
    return this.enqueue((value) => advanceSession(value, kind, note))
  }

  /** 跳到当前知识点的指定动作步（练习↔原文依据互跳）。 */
  goToPointStep(action: SessionStepAction, snapshot?: CourseSnapshot): Promise<LearningSession | undefined> {
    const index = sessionStepIndex(this.latest)
    const pointId = this.latest.steps[index]?.pointId
    const target = this.latest.steps.findIndex((item) => item.pointId === pointId && item.action === action)
    return this.checkpoint({ stepIndex: Math.max(0, target) }, snapshot)
  }

  setPlanning(minutes: number): Promise<LearningSession | undefined> {
    return this.enqueue((value) => ({ ...value, planning: { date: learningDate(Date.now()), minutes } }))
  }

  end(): Promise<LearningSession | undefined> {
    return this.enqueue((value) => (value.status === 'active'
      ? { ...value, status: 'ended', endedAt: Date.now(), ...(value.checkpoint ? { checkpoint: { ...value.checkpoint, endedReason: 'user' as const } } : {}) }
      : value))
  }

  /** 冲突恢复/重新读取后替换基线并解除熔断（调用方需保证没有写入进行中）。 */
  reset(session: LearningSession): void {
    this.latest = session
    this.broken = false
    this.chain = Promise.resolve()
  }
}
