import {
  clearQuizPractice, loadQuizPractice, saveQuizPractice,
  type QuizPracticeContext, type QuizPracticeRecord, type QuizPracticeState,
} from './quizPractice'
import { LocalArtifactError } from './localArtifactIdentity'

export const emptyQuizPractice = (): QuizPracticeState => ({ answers: {}, submitted: false, selfAssessments: {} })
export interface QuizPracticeView {
  form: QuizPracticeState
  loading: boolean
  writing: boolean
  ready: boolean
  corrupt: boolean
  error?: string
}
export interface QuizPracticeStorage {
  load(context: QuizPracticeContext): Promise<QuizPracticeRecord | undefined>
  save(context: QuizPracticeContext, value: QuizPracticeState, revision: number | null): Promise<QuizPracticeRecord>
  clear(context: QuizPracticeContext): Promise<void>
}
const localStorage: QuizPracticeStorage = { load: loadQuizPractice, save: saveQuizPractice, clear: clearQuizPractice }

/** One immutable artifact owns one coalescing CAS writer. Reads never create or repair a record. */
export class QuizPracticeController {
  private state: QuizPracticeView = { form: emptyQuizPractice(), loading: true, writing: false, ready: false, corrupt: false }
  private listeners = new Set<() => void>()
  private connected = false
  private generation = 0
  private revision: number | null = null
  private sequence = 0
  private savedSequence = 0
  private writer?: Promise<void>
  constructor(private readonly context: QuizPracticeContext, private readonly storage: QuizPracticeStorage = localStorage) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<QuizPracticeView>) {
    this.state = { ...this.state, ...patch }
    if (this.connected) for (const listener of this.listeners) listener()
  }
  connect(): () => void {
    this.connected = true
    void this.reload()
    return () => { this.connected = false; this.generation++ }
  }
  async reload(): Promise<void> {
    const generation = ++this.generation
    this.publish({ loading: true, ready: false, error: undefined, corrupt: false })
    try {
      await this.writer
      if (!this.connected || generation !== this.generation) return
      const stored = await this.storage.load(this.context)
      if (!this.connected || generation !== this.generation) return
      const form = stored ? { answers: stored.answers, submitted: stored.submitted, selfAssessments: stored.selfAssessments,
        ...(stored.submissionId === undefined ? {} : { submissionId: stored.submissionId, submittedAt: stored.submittedAt }) } : emptyQuizPractice()
      this.revision = stored?.revision ?? null; this.sequence = 0; this.savedSequence = 0
      this.publish({ form, ready: true })
    } catch (error) {
      if (this.connected && generation === this.generation) this.fail(error, '本地练习读取失败，请重新读取。')
    } finally { if (this.connected && generation === this.generation) this.publish({ loading: false }) }
  }
  private fail(error: unknown, fallback: string) {
    this.publish({ ready: false, error: error instanceof Error ? error.message : fallback,
      corrupt: error instanceof LocalArtifactError && error.code === 'corrupt' })
  }
  private persist(next: QuizPracticeState): Promise<void> {
    if (!this.connected || !this.state.ready || this.state.loading) return Promise.resolve()
    this.sequence++; this.publish({ form: next, writing: true, error: undefined })
    if (this.writer) return this.writer
    const operation = (async () => {
      // Complete accepted edits after unmount; the storage transaction still fences a removed/replaced binding.
      while (this.savedSequence < this.sequence) {
        const snapshot = this.state.form
        const sequence = this.sequence
        const stored = await this.storage.save(this.context, snapshot, this.revision)
        this.revision = stored.revision; this.savedSequence = sequence
      }
    })().catch((error: unknown) => this.fail(error, '作答保存失败，请重新读取练习。'))
      .finally(() => { this.writer = undefined; this.publish({ writing: false }) })
    this.writer = operation
    return operation
  }
  answer(questionId: string, value: string | number | boolean): Promise<void> {
    if (this.state.form.submitted) return Promise.resolve()
    return this.persist({ ...this.state.form, answers: { ...this.state.form.answers, [questionId]: value } })
  }
  submit(): Promise<void> {
    if (this.state.form.submitted) return Promise.resolve()
    return this.persist({ ...this.state.form, submitted: true, submissionId: crypto.randomUUID(), submittedAt: Date.now() })
  }
  assess(questionId: string, criterionIndex: number, checked: boolean): Promise<void> {
    const question = this.context.artifact.payload.questions.find((item) => item.id === questionId)
    if (!this.state.form.submitted || question?.type !== 'short-answer'
      || !Number.isInteger(criterionIndex) || criterionIndex < 0 || criterionIndex >= question.rubric.length) return Promise.resolve()
    const existing = Object.prototype.hasOwnProperty.call(this.state.form.selfAssessments, questionId)
      ? this.state.form.selfAssessments[questionId] : undefined
    const assessment = [...(existing ?? question.rubric.map(() => false))]
    assessment[criterionIndex] = checked
    return this.persist({ ...this.state.form, selfAssessments: { ...this.state.form.selfAssessments, [questionId]: assessment } })
  }
  reset(): Promise<void> { return this.persist(emptyQuizPractice()) }
  async clearCorrupt(): Promise<void> {
    if (!this.connected || !this.state.corrupt || this.writer || this.state.loading) return
    this.publish({ loading: true, ready: false })
    try {
      await this.storage.clear(this.context)
      if (this.connected) await this.reload()
    } catch (error) { this.fail(error, '清理练习失败。') }
    finally { this.publish({ loading: false }) }
  }
}
