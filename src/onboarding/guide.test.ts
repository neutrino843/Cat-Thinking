import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFirstQuestion, commitGuide, GUIDE_KEY, guideHelp, guideImportProblem, guidePreview, guideRead, guideReview, guideSaved,
  guideViewSource, normalizeRecallAnswer, parseGuideProgress, pauseGuide, resumeGuide, scriptedGuide, setGuideAnswer, startGuide,
  submitGuideAnswer, useGuide } from './guide'

beforeEach(() => {
  localStorage.clear()
  startGuide()
})
const binding = { docId: 'document-1', sourceId: 'source-1', courseId: 'course-1', sourceHash: 'a'.repeat(64) }
const progress = () => useGuide.getState().progress
function saved() { guidePreview(); guideSaved(binding, progress().sessionId) }

describe('first imported-source exercise and guide recovery', () => {
  it('advances only from saved data, survives serialization and preserves an answer across pause', () => {
    guideRead(); expect(progress().step).toBe('import')
    guidePreview(); expect(progress().binding).toBeNull()
    expect(guideSaved(binding, 'old-session')).toBe(false)
    saved(); guideRead(); setGuideAnswer('光合作用'); pauseGuide()
    const restored = parseGuideProgress(JSON.parse(localStorage.getItem(GUIDE_KEY) ?? 'null'))
    expect(restored.status).toBe('paused'); expect(restored.answer).toBe('光合作用')
    resumeGuide(); guideViewSource(); submitGuideAnswer('match', progress().sessionId)
    expect(progress()).toMatchObject({ status: 'completed', step: 'complete', outcome: 'match', assisted: true })
  })
  it('does not lose a successful save while paused, or accept a late submission into a new session', () => {
    guidePreview(); pauseGuide(); expect(guideSaved(binding, progress().sessionId)).toBe(true)
    expect(progress()).toMatchObject({ status: 'paused', step: 'read' })
    resumeGuide(); guideRead(); const old = progress().sessionId
    startGuide(); submitGuideAnswer('match', old)
    expect(progress()).toMatchObject({ status: 'active', step: 'import', outcome: null })
  })
  it('cancellation and import failure never become a completed import', () => {
    guidePreview(); guideImportProblem(true)
    expect(progress()).toMatchObject({ step: 'import', binding: null })
    guideImportProblem(); expect(progress().events.at(-1)?.kind).toBe('import-error')
  })
  it('exports help reasons without raw source, answers or free-form dialogue', () => {
    guideHelp('不知道下一步'); saved(); guideRead(); setGuideAnswer('private answer')
    const review = guideReview(progress())
    expect(review).toContain('不知道下一步'); expect(review).not.toContain('private answer'); expect(review).not.toContain(binding.docId)
  })
  it('rejects malformed, injected, overlong and inconsistent stored progress', () => {
    const p = progress()
    for (const bad of [{ ...p, version: 2 }, { ...p, extra: 'injected' }, { ...p, answer: 'a'.repeat(161) },
      { ...p, step: 'question' }, { ...p, status: 'completed' }, { ...p, events: [{ ...p.events[0], rawText: 'private' }] },
      { ...p, binding: { ...binding, sourceHash: 'invalid' } }, { ...p, binding: { ...binding, extra: true } }]) {
      expect(() => parseGuideProgress(bad)).toThrow()
    }
  })
  it('warns when saving fails, retaining in-page progress without claiming persistence', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    try { commitGuide(progress()); expect(useGuide.getState().storageError).toContain('无法保存') } finally { spy.mockRestore() }
  })
  it('makes a literal, traceable fill-in question without inventing document facts', () => {
    const text = '第一章 植物\n\n光合作用把光能转化为化学能，并释放氧气。\n这份资料用于复习。'
    const q = buildFirstQuestion({ text })
    expect(q).not.toBeNull(); expect(q?.answer).toBe('光合作用')
    expect(text.slice(q?.start, q?.end)).toBe(q?.quote)
    expect(q?.prompt.replace('（____）', q.answer)).toBe(q?.quote)
    expect(buildFirstQuestion({ text: '12345' })).toBeNull()
    expect(buildFirstQuestion({ text: '' })).toBeNull()
    expect(normalizeRecallAnswer(' ＰＬＡＮＴ ')).toBe('plant')
  })
  it('keeps unknown chat honest and contextual responses local', () => {
    expect(scriptedGuide.reply('preview', '下一步怎么做')).toContain('创建可编辑导图')
    expect(scriptedGuide.reply('question', '会收费吗')).toContain('不调用模型')
    expect(scriptedGuide.reply('read', '请帮我解一道微分方程')).toContain('预设台词')
  })
})
