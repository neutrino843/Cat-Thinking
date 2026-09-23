import { beforeEach, describe, expect, it } from 'vitest'
import { navigate, useDoc } from '../store/docStore'
import { simpleFixture } from '../test/fixture'
import { addDays, todayISO } from '../lib/date'

/** 每次取最新状态，避免持有快照读到旧 doc */
const get = () => useDoc.getState()
const doc = () => get().doc
const ids = () => {
  const d = doc()
  const children = d.nodes[d.rootId].children
  return { root: d.rootId, a: children[0], b: children[1], a1: d.nodes[children[0]].children[0] }
}

beforeEach(() => {
  get().loadDoc(simpleFixture())
})

describe('docStore 节点操作', () => {
  it('addChild：挂载、选中、打历史；折叠父自动展开', () => {
    const { b } = ids()
    const before = Object.keys(doc().nodes).length
    const id = get().addChild(b)
    expect(Object.keys(doc().nodes)).toHaveLength(before + 1)
    expect(doc().nodes[id].parent).toBe(b)
    expect(doc().nodes[b].children).toContain(id)
    expect(get().selection).toEqual([id])
    expect(get().past).toHaveLength(1)

    get().setNode(b, { collapsed: true })
    get().addChild(b)
    expect(doc().nodes[b].collapsed).toBe(false)
  })

  it('addSibling：根节点不可加兄弟；其他按位置插入', () => {
    const { root, a, b } = ids()
    get().addSibling(root)
    expect(doc().nodes[root].children).toHaveLength(2)
    get().addSibling(a)
    const children = doc().nodes[root].children
    expect(children[0]).toBe(a)
    expect(children[2]).toBe(b)
    expect(doc().nodes[children[1]].parent).toBe(root)
  })

  it('removeNodes：整棵子树删除并清理父引用，根节点受保护', () => {
    const { root, a, a1, b } = ids()
    get().removeNodes([root])
    expect(Object.keys(doc().nodes)).toHaveLength(4)
    get().removeNodes([a])
    expect(doc().nodes[a]).toBeUndefined()
    expect(doc().nodes[a1]).toBeUndefined()
    expect(doc().nodes[root].children).toEqual([b])
  })

  it('reparent：换父成功；自环/挂到后代/移动根全部拒绝', () => {
    const { root, a, a1, b } = ids()
    get().reparent(a1, b)
    expect(doc().nodes[a1].parent).toBe(b)
    expect(doc().nodes[a].children).toEqual([])
    expect(doc().nodes[b].children).toEqual([a1])

    get().reparent(a1, a1) // 自环
    get().reparent(root, b) // 移动根
    expect(doc().nodes[a1].parent).toBe(b)
    expect(doc().nodes[root].parent).toBeNull()

    get().reparent(a1, a)
    expect(doc().nodes[a1].parent).toBe(a)
    get().reparent(a, a1) // 不能挂到后代下
    expect(doc().nodes[a].parent).toBe(root)
  })

  it('moveOrder：边界不动，中间交换', () => {
    const { a, b, root } = ids()
    get().moveOrder(a, -1)
    expect(doc().nodes[root].children[0]).toBe(a)
    get().moveOrder(b, -1)
    expect(doc().nodes[root].children[0]).toBe(b)
  })

  it('剪贴板：子树复制后 id 全部重映射、文本保留', () => {
    const { a, b } = ids()
    get().select([a])
    get().copySel()
    get().paste(b)
    const pastedRootId = doc().nodes[b].children[0]
    expect(pastedRootId).toBeTruthy()
    const pastedRoot = doc().nodes[pastedRootId]
    expect(pastedRoot.text).toBe('a')
    expect(pastedRoot.parent).toBe(b)
    expect(pastedRoot.children).toHaveLength(1)
    expect(doc().nodes[pastedRoot.children[0]].text).toBe('a1')
    expect(Object.keys(doc().nodes)).toHaveLength(6)
  })

  it('navigate：四向导航', () => {
    const { a, a1, b } = ids()
    const nodes = doc().nodes
    expect(navigate(nodes, a1, 'left')).toBe(a)
    expect(navigate(nodes, a1, 'right')).toBeNull()
    expect(navigate(nodes, a, 'right')).toBe(a1)
    expect(navigate(nodes, a, 'down')).toBe(b)
    expect(navigate(nodes, a, 'up')).toBeNull()
  })
})

describe('docStore 撤销重做', () => {
  it('普通动作进入历史；undo/redo 往返一致', () => {
    const { b } = ids()
    const newId = get().addChild(b)
    expect(get().past).toHaveLength(1)
    get().undo()
    expect(doc().nodes[newId]).toBeUndefined()
    expect(get().future).toHaveLength(1)
    get().redo()
    expect(doc().nodes[newId]).toBeDefined()
  })

  it('文本编辑：beginEdit 打一次快照，输入期间不刷屏历史', () => {
    const { a } = ids()
    get().beginEdit()
    get().setText(a, 'a-')
    get().setText(a, 'a-x')
    get().setText(a, 'a-xyz')
    expect(get().past).toHaveLength(1)
    get().undo()
    expect(doc().nodes[a].text).toBe('a')
    get().redo()
    expect(doc().nodes[a].text).toBe('a-xyz')
  })

  it('甘特拖拽（commit:false）整体只占一步历史', () => {
    const { a } = ids()
    const t = todayISO()
    get().setTask(a, { start: t, end: addDays(t, 3) })
    get().beginEdit()
    get().setTask(a, { start: addDays(t, 1), end: addDays(t, 4) }, false)
    get().setTask(a, { start: addDays(t, 2), end: addDays(t, 5) }, false)
    get().undo()
    const task = doc().nodes[a].task
    expect(task?.start).toBe(t)
    expect(task?.end).toBe(addDays(t, 3))
    // 拖拽前的常规提交是独立历史步（回归：commit 布尔曾被二次取反）
    get().undo()
    expect(doc().nodes[a].task).toBeUndefined()
  })
})

describe('docStore 甘特任务', () => {
  it('setTask：日期颠倒自动纠正、进度钳制、清空后移除 task', () => {
    const { a } = ids()
    const t = todayISO()
    get().setTask(a, { start: addDays(t, 9), end: t, progress: 2 })
    const task = doc().nodes[a].task!
    expect(task.start).toBe(t)
    expect(task.end).toBe(addDays(t, 9))
    expect(task.progress).toBe(1)
    get().setTask(a, { start: undefined, end: undefined, milestone: undefined })
    expect(doc().nodes[a].task).toBeUndefined()
  })

  it('里程碑只保留开始日', () => {
    const { a } = ids()
    const t = todayISO()
    get().setTask(a, { start: t, end: addDays(t, 5), progress: 0.3, milestone: true })
    const task = doc().nodes[a].task!
    expect(task.milestone).toBe(true)
    expect(task.start).toBe(t)
    expect(task.end).toBeUndefined()
  })

  it('addDep：成环拒绝；removeDep 可移除', () => {
    const { a, b, a1 } = ids()
    const t = todayISO()
    get().setTask(a, { start: t, end: addDays(t, 1) })
    get().setTask(b, { start: addDays(t, 2), end: addDays(t, 3) })
    expect(get().addDep(a, b)).toBe(true)
    expect(get().addDep(b, a)).toBe(false) // 成环
    expect(doc().nodes[b].task!.deps).toHaveLength(1)
    get().removeDep(a, b)
    expect(doc().nodes[b].task!.deps ?? []).toHaveLength(0)
    expect(get().addDep(a1, a1)).toBe(false) // 自环
  })

  it('clearTask：仅移除任务信息，节点本体保留', () => {
    const { a } = ids()
    const t = todayISO()
    get().setTask(a, { start: t, end: t })
    get().clearTask(a)
    expect(doc().nodes[a]).toBeDefined()
    expect(doc().nodes[a].task).toBeUndefined()
  })
})
