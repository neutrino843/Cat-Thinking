import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import * as storage from '../store/db'
import { installLearningTestStore } from './testStore'
import { createExampleCourse } from './exampleCourse'
import { loadCourseSnapshot, saveEntity } from './repository'
import { createGuidedSession, sessionStepIndex } from './session'
import { SessionRunner } from './sessionRunner'
import type { CourseSnapshot, LearningSession } from './model'

beforeEach(() => {
  installLearningTestStore(); vi.stubGlobal('Blob', NodeBlob); localStorage.clear()
  vi.spyOn(storage, 'saveDocumentBundle').mockImplementation(async (doc, sources) => {
    await storage.db.docs.put({ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, payload: JSON.stringify(doc) })
    await storage.db.sources.bulkPut(sources)
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setup(): Promise<{ snapshot: CourseSnapshot; session: LearningSession }> {
  const example = await createExampleCourse()
  const snapshot = await loadCourseSnapshot(example.id)
  const session = await saveEntity(createGuidedSession(snapshot, snapshot.points.slice(0, 1)), null)
  return { snapshot: await loadCourseSnapshot(example.id), session }
}

describe('SessionRunner 串行持久化编排', () => {
  it('连续文字保存严格串行且最终文字落库到当前步骤', async () => {
    const { snapshot, session } = await setup()
    const runner = new SessionRunner(session, snapshot)
    await Promise.all([runner.writeNote('第一稿'), runner.writeNote('第二稿'), runner.writeNote('终稿')])
    expect(runner.isWriting).toBe(false)
    expect(runner.latest.steps[0].note).toBe('终稿')
    const reloaded = await loadCourseSnapshot(snapshot.course.id)
    expect(reloaded.sessions[0].steps[0].note).toBe('终稿')
  })

  it('完成阅读步后推进到回忆步并隐藏核心说明、重置滚动位', async () => {
    const { snapshot, session } = await setup()
    const runner = new SessionRunner(session, snapshot)
    const saved = await runner.step('completed', '')
    expect(saved).toBeDefined()
    expect(sessionStepIndex(runner.latest)).toBe(1)
    expect(runner.latest.steps[0].status).toBe('completed')
    expect(runner.latest.checkpoint?.hidden).toBe(true)
    expect(runner.latest.checkpoint?.position).toBe(0)
  })

  it('可为无 checkpoint 的旧会话首次写入检查点并完成绑定', async () => {
    const { snapshot, session } = await setup()
    const legacy = structuredClone(session); delete legacy.checkpoint
    const runner = new SessionRunner(legacy, snapshot)
    const saved = await runner.checkpoint({ position: 32, paused: true })
    expect(saved?.checkpoint).toMatchObject({ position: 32, paused: true, goalVersion: snapshot.course.goalVersion })
  })

  it('练习与原文依据步可按当前知识点互跳', async () => {
    const { snapshot, session } = await setup()
    const runner = new SessionRunner(session, snapshot)
    expect(runner.latest.steps[2]).toMatchObject({ action: 'practice' })
    expect(runner.latest.steps[3]).toMatchObject({ action: 'source' })
    await runner.goToPointStep('source')
    expect(runner.latest.checkpoint?.stepIndex).toBe(3)
    await runner.goToPointStep('practice')
    expect(runner.latest.checkpoint?.stepIndex).toBe(2)
  })

  it('结束学习写入 ended 与 user 原因', async () => {
    const { snapshot, session } = await setup()
    const runner = new SessionRunner(session, snapshot)
    await runner.end()
    expect(runner.latest.status).toBe('ended')
    expect(runner.latest.endedAt).toEqual(expect.any(Number))
    expect(runner.latest.checkpoint?.endedReason).toBe('user')
    const again = await runner.end()
    expect(again?.status).toBe('ended')
  })

  it('保存失败后熔断后续写入，reset 后恢复并可继续保存', async () => {
    const { session, snapshot } = await setup()
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('revision conflict'))
      .mockImplementation(async (updated: LearningSession) => updated)
    const runner = new SessionRunner(session, snapshot, save)
    await expect(runner.writeNote('冲突稿')).rejects.toThrow('revision conflict')
    expect(runner.hasFailed).toBe(true)
    await runner.writeNote('不应落库').catch(() => undefined)
    expect(save).toHaveBeenCalledTimes(1)
    runner.reset(runner.latest)
    expect(runner.hasFailed).toBe(false)
    await runner.writeNote('恢复稿')
    expect(save).toHaveBeenCalledTimes(2)
    expect(runner.latest.steps[0].note).toBe('恢复稿')
  })

  it('调整预留分钟会随保存刷新 planning 日期', async () => {
    const { snapshot, session } = await setup()
    const originalDate = session.planning?.date
    const runner = new SessionRunner(session, snapshot)
    await runner.setPlanning(25)
    expect(runner.latest.planning?.minutes).toBe(25)
    expect(runner.latest.planning?.date).toBeTruthy()
    expect(typeof originalDate).toBe('string')
  })
})
