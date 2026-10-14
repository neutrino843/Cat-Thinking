import { expect, it, vi } from 'vitest'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { LocalArtifactError } from './localArtifactIdentity'
import { emptyQuizPractice, QuizPracticeController, type QuizPracticeStorage } from './quizPracticeController'
import type { QuizPracticeRecord, QuizPracticeState } from './quizPractice'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function harness(initial?: QuizPracticeState) {
  const { quiz, snapshot } = await localArtifactFixtures()
  const context = { docId: quiz.docId, runId: quiz.runId, artifact: quiz }
  const record = (value: QuizPracticeState, revision: number): QuizPracticeRecord => ({
    version: 1, id: 'practice-1', docId: quiz.docId, runId: quiz.runId, artifactId: quiz.id,
    artifactHash: 'a'.repeat(64), sourceFingerprint: snapshot.contentHash,
    questionIds: quiz.payload.questions.map((question) => question.id), updatedAt: 1, revision, ...structuredClone(value),
  })
  let stored = initial && record(initial, 1)
  const storage: QuizPracticeStorage = {
    load: vi.fn(async () => stored && structuredClone(stored)),
    save: vi.fn(async (_context, value, revision) => {
      if ((stored?.revision ?? null) !== revision) throw new LocalArtifactError('conflict', '另一个页面已修改')
      stored = record(value, (revision ?? 0) + 1)
      return structuredClone(stored)
    }),
    clear: vi.fn(async () => { stored = undefined }),
  }
  const controller = new QuizPracticeController(context, storage)
  return { controller, storage, record, context, get stored() { return stored }, set stored(value) { stored = value } }
}
async function connect(h: Awaited<ReturnType<typeof harness>>) {
  const disconnect = h.controller.connect()
  await vi.waitFor(() => expect(h.controller.getSnapshot().loading).toBe(false))
  return disconnect
}

it('loads existing state without creating a record and publishes to active subscribers only', async () => {
  const value = { answers: { boolean: false }, submitted: true, selfAssessments: {} }
  const h = await harness(value)
  const notify = vi.fn(); const unsubscribe = h.controller.subscribe(notify)
  const disconnect = await connect(h)
  expect(h.controller.getSnapshot()).toMatchObject({ ready: true, form: value })
  expect(h.storage.save).not.toHaveBeenCalled()
  unsubscribe(); const calls = notify.mock.calls.length
  await h.controller.reset(); expect(notify).toHaveBeenCalledTimes(calls)
  disconnect(); await h.controller.answer('choice', 0)
  expect(h.storage.save).toHaveBeenCalledTimes(1)
})
it('coalesces rapid edits, preserving all three literal answer types and ordered CAS revisions', async () => {
  const h = await harness(); await connect(h)
  const first = deferred<QuizPracticeRecord>()
  vi.mocked(h.storage.save).mockImplementationOnce(() => first.promise)
  const writing = h.controller.answer('choice', 0)
  expect(h.controller.answer('boolean', false)).toBe(writing)
  h.controller.answer('short', '答案')
  expect(h.storage.save).toHaveBeenCalledTimes(1)
  h.stored = h.record({ answers: { choice: 0 }, submitted: false, selfAssessments: {} }, 1)
  first.resolve(h.stored); await writing
  expect(h.storage.save).toHaveBeenLastCalledWith(h.context, {
    answers: { choice: 0, boolean: false, short: '答案' }, submitted: false, selfAssessments: {},
  }, 1)
  expect(h.stored?.revision).toBe(2)
  expect(h.controller.getSnapshot().writing).toBe(false)
})
it('finishes already accepted queued edits after unmount without publishing to the detached view', async () => {
  const h = await harness(); const disconnect = await connect(h)
  const notify = vi.fn(); h.controller.subscribe(notify)
  const first = deferred<QuizPracticeRecord>()
  vi.mocked(h.storage.save).mockImplementationOnce(() => first.promise)
  const writing = h.controller.answer('choice', 0); h.controller.answer('short', '最后一次编辑')
  disconnect(); const calls = notify.mock.calls.length
  h.stored = h.record({ answers: { choice: 0 }, submitted: false, selfAssessments: {} }, 1)
  first.resolve(h.stored); await writing
  expect(h.stored?.answers.short).toBe('最后一次编辑')
  expect(notify).toHaveBeenCalledTimes(calls)
  await connect(h); expect(h.controller.getSnapshot().form.answers.short).toBe('最后一次编辑')
})
it('a newer readonly load supersedes a late load and disconnect prevents stale initialization', async () => {
  const h = await harness()
  const first = deferred<QuizPracticeRecord | undefined>()
  vi.mocked(h.storage.load).mockImplementationOnce(() => first.promise)
  const disconnect = h.controller.connect()
  await vi.waitFor(() => expect(h.storage.load).toHaveBeenCalledTimes(1))
  h.stored = h.record({ answers: { short: '新答案' }, submitted: false, selfAssessments: {} }, 2)
  await h.controller.reload()
  first.resolve(h.record(emptyQuizPractice(), 1)); await Promise.resolve()
  expect(h.controller.getSnapshot().form.answers.short).toBe('新答案')
  const last = deferred<QuizPracticeRecord | undefined>()
  vi.mocked(h.storage.load).mockImplementationOnce(() => last.promise)
  const loading = h.controller.reload(); await Promise.resolve(); disconnect()
  last.resolve(undefined); await loading
  expect(h.controller.getSnapshot().form.answers.short).toBe('新答案')
})
it('reload waits for the writer and blocks edits while reconciling its authoritative revision', async () => {
  const h = await harness(); await connect(h)
  const pending = deferred<QuizPracticeRecord>()
  vi.mocked(h.storage.save).mockImplementationOnce(() => pending.promise)
  h.controller.answer('choice', 0)
  const loading = h.controller.reload(); await h.controller.answer('short', '应被阻止')
  expect(h.storage.load).toHaveBeenCalledTimes(1)
  h.stored = h.record({ answers: { choice: 0 }, submitted: false, selfAssessments: {} }, 1)
  pending.resolve(h.stored); await loading
  expect(h.controller.getSnapshot()).toMatchObject({ ready: true, writing: false, form: { answers: { choice: 0 } } })
})
it('does not retry a conflicting write or accept more edits until a manual reload', async () => {
  const h = await harness(); await connect(h)
  h.stored = h.record({ answers: { boolean: false }, submitted: false, selfAssessments: {} }, 3)
  await h.controller.answer('choice', 0)
  expect(h.controller.getSnapshot()).toMatchObject({ ready: false, corrupt: false, error: '另一个页面已修改' })
  await h.controller.answer('short', '禁止重放'); expect(h.storage.save).toHaveBeenCalledTimes(1)
  await h.controller.reload(); await h.controller.answer('short', '显式恢复后的作答')
  expect(h.stored?.revision).toBe(4)
  expect(h.stored?.answers.boolean).toBe(false)
})
it('locks submitted answers, accepts explicit rubric self-assessment, and resets with a higher revision', async () => {
  const h = await harness(); await connect(h)
  for (const [id, index] of [['short', 0], ['missing', 0], ['short', -1], ['short', 3], ['boolean', 0]] as const) await h.controller.assess(id, index, true)
  expect(h.storage.save).not.toHaveBeenCalled()
  await h.controller.answer('short', '初次作答'); await h.controller.submit()
  await h.controller.answer('short', '禁止修改')
  expect(h.stored?.answers.short).toBe('初次作答')
  for (const index of [-1, 2, 0.5]) await h.controller.assess('short', index, true)
  await h.controller.assess('short', 0, true)
  expect(h.stored?.selfAssessments).toEqual({ short: [true, false] })
  const revision = h.stored!.revision
  await h.controller.reset()
  expect(h.stored).toMatchObject({ revision: revision + 1, ...emptyQuizPractice() })
  expect(h.storage.clear).not.toHaveBeenCalled()
})
it('allows corrupt-record cleanup only by explicit action and reports a cleanup failure', async () => {
  const h = await harness()
  await h.controller.clearCorrupt(); expect(h.storage.clear).not.toHaveBeenCalled()
  vi.mocked(h.storage.load).mockRejectedValueOnce(new LocalArtifactError('corrupt', '记录损坏'))
  await connect(h)
  expect(h.controller.getSnapshot()).toMatchObject({ ready: false, corrupt: true, error: '记录损坏' })
  vi.mocked(h.storage.clear).mockRejectedValueOnce(new Error('无法清理'))
  await h.controller.clearCorrupt()
  expect(h.controller.getSnapshot()).toMatchObject({ error: '无法清理', loading: false })
  vi.mocked(h.storage.load).mockRejectedValueOnce(new LocalArtifactError('corrupt', '记录损坏'))
  await h.controller.reload(); await h.controller.clearCorrupt()
  expect(h.controller.getSnapshot()).toMatchObject({ ready: true, corrupt: false, form: emptyQuizPractice() })
  expect(h.storage.save).not.toHaveBeenCalled()
})
it('reports non-Error read/write failures without automatic record recreation', async () => {
  const h = await harness(); vi.mocked(h.storage.load).mockRejectedValueOnce('failure')
  await connect(h); expect(h.controller.getSnapshot().error).toContain('读取失败')
  await h.controller.reload()
  vi.mocked(h.storage.save).mockRejectedValueOnce('failure')
  await h.controller.answer('choice', 0)
  expect(h.controller.getSnapshot().error).toContain('保存失败')
  expect(h.storage.save).toHaveBeenCalledTimes(1)
  await h.controller.clearCorrupt(); expect(h.storage.clear).not.toHaveBeenCalled()
})
it('a legal short-answer question named constructor cannot read an inherited rubric value', async () => {
  const h = await harness()
  const question = h.context.artifact.payload.questions.find((item) => item.type === 'short-answer')!
  question.id = 'constructor'
  await connect(h); await h.controller.submit(); await h.controller.assess('constructor', 0, true)
  expect(h.stored?.selfAssessments).toEqual({ constructor: [true, false] })
})
it('submission identity is durable through assessment and reload, and a new attempt gets a new identity', async () => {
  const h = await harness(); await connect(h)
  await h.controller.answer('short', '初次回答'); await h.controller.submit()
  const first = h.stored!.submissionId
  expect(first).toEqual(expect.any(String)); expect(h.stored!.submittedAt).toBeGreaterThan(0)
  await h.controller.submit()
  expect(h.stored!.submissionId).toBe(first)
  await h.controller.assess('short', 0, true); await h.controller.reload()
  expect(h.controller.getSnapshot().form.submissionId).toBe(first)
  await h.controller.reset()
  expect(h.stored!.submissionId).toBeUndefined()
  await h.controller.submit()
  expect(h.stored!.submissionId).not.toBe(first)
})
it('legacy submitted records retain unknown submission time on load', async () => {
  const h = await harness({ answers: { short: '历史答案' }, submitted: true, selfAssessments: {} }); await connect(h)
  expect(h.controller.getSnapshot().form.submissionId).toBeUndefined()
  expect(h.controller.getSnapshot().form.submittedAt).toBeUndefined()
})
it('a newly disputed quiz refuses submission without claiming saved success, then reload restores the preserved draft', async () => {
  const h = await harness(); await connect(h)
  await h.controller.answer('short', '保留的草稿')
  const revision = h.stored!.revision
  vi.mocked(h.storage.save).mockRejectedValueOnce(new LocalArtifactError('conflict', '题目待核对，提交已暂停'))
  await h.controller.submit()
  expect(h.controller.getSnapshot()).toMatchObject({ ready: false, error: '题目待核对，提交已暂停' })
  expect(h.stored).toMatchObject({ revision, submitted: false, answers: { short: '保留的草稿' } })
  await h.controller.reload()
  expect(h.controller.getSnapshot()).toMatchObject({ ready: true, form: { submitted: false, answers: { short: '保留的草稿' } } })
})
