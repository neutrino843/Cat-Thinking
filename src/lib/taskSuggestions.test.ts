import { describe, expect, it } from 'vitest'
import { buildFixture } from '../test/fixture'
import { suggestTasks } from './taskSuggestions'
import { computeGantt, criticalPath } from './gantt'
import { useDoc } from '../store/docStore'
import { toGanttCSV } from './openFormats'

describe('V3 task confirmation', () => {
  it('suggests actions without turning concepts or existing tasks into candidates, and never mutates input', () => {
    const doc = buildFixture({ children: [{ text: '复习第三章' }, { text: '牛顿第一定律' }, { text: '完成练习', task: { start: '2026-10-17' } }] })
    const before = JSON.stringify(doc)
    expect(suggestTasks(doc).map((item) => item.text)).toEqual(['复习第三章'])
    expect(JSON.stringify(doc)).toBe(before)
  })
  it('keeps confirmed unscheduled tasks, necessary groups, compact row positions, undo, and explicit removal', () => {
    const doc = buildFixture({ children: [{ text: '章节', children: [{ text: '复习章节' }] }, { text: '术语' }] })
    useDoc.getState().loadDoc(doc)
    const id = suggestTasks(doc)[0].id
    expect(computeGantt(doc, 'day', '2026-10-17', 'tasks').rows).toEqual([])
    useDoc.getState().beginEdit()
    useDoc.getState().setTask(id, { progress: 0 }, false)
    const updated = useDoc.getState().doc
    expect(updated.nodes[id].task).toEqual({ progress: 0 })
    const rows = computeGantt(updated, 'day', '2026-10-17', 'tasks').rows
    expect(rows.map((row) => row.text)).toContain('章节')
    expect(rows.map((row) => row.text)).not.toContain('术语')
    expect(toGanttCSV(updated, 'tasks')).not.toContain('术语')
    expect(toGanttCSV(updated, 'tasks')).toContain('复习章节')
    expect(rows[2].y - rows[1].y).toBe(34)
    expect(updated.nodes[id].task?.start).toBeUndefined()
    useDoc.getState().undo()
    expect(useDoc.getState().doc.nodes[id].task).toBeUndefined()
    useDoc.getState().setTask(id, { start: '2026-10-17', milestone: true })
    useDoc.getState().setTask(id, { start: undefined, end: undefined, progress: 0 })
    expect(useDoc.getState().doc.nodes[id].task?.start).toBeUndefined()
    expect(useDoc.getState().doc.nodes[id].task?.milestone).toBe(true)
    useDoc.getState().setTask(id, { progress: 0 })
    useDoc.getState().clearTask(id)
    expect(useDoc.getState().doc.nodes[id].text).toBe('复习章节')
    expect(useDoc.getState().doc.nodes[id].task).toBeUndefined()
  })
  it('uses inclusive duration for both a two-day task and a chain of two one-day tasks', () => {
    const doc = buildFixture({ children: [{ text: 'A', task: { start: '2026-01-01', end: '2026-01-02' } }, { text: 'B', task: { start: '2026-01-01' } }, { text: 'C', task: { start: '2026-01-02' } }] })
    const [a, b, c] = doc.nodes[doc.rootId].children
    doc.nodes[c].task = { ...doc.nodes[c].task, deps: [{ from: b, type: 'FS' }] }
    expect(criticalPath(doc)).toEqual(new Set([a, b, c]))
  })
})
