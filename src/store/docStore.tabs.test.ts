import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_DOC, loadSavedTabs, useDoc } from '../store/docStore'
import { simpleFixture } from '../test/fixture'

/**
 * M11（PRD 4.4 P1）：多文档标签会话、过滤视图态、批量操作。
 * 纯 store 测试：不碰 IndexedDB（自动保存在 App 层订阅，单测不挂载）。
 */
const get = () => useDoc.getState()

const makeDoc = (id: string, title: string) => {
  const d = simpleFixture()
  d.id = id
  d.title = title
  return d
}

const kidsOfRoot = (d: ReturnType<typeof simpleFixture>) => d.nodes[d.rootId].children

beforeEach(() => {
  localStorage.clear()
  // 完整重置（loadDoc 不清 tabs/sessions）
  useDoc.setState({
    doc: EMPTY_DOC,
    tabs: [],
    sessions: {},
    selection: [],
    editing: null,
    past: [],
    future: [],
    clipboard: null,
    filter: { tag: '', status: '' },
  })
})

describe('多文档标签会话', () => {
  it('openDoc：挂标签、切文档时暂存并恢复各自会话（撤销栈/剪贴板独立）', () => {
    const A = makeDoc('A', '文档甲')
    const B = makeDoc('B', '文档乙')

    get().openDoc(A)
    expect(get().tabs).toEqual(['A'])

    // 在 A 中做一次编辑 + 复制
    const aRoot = A.rootId
    get().addChild(aRoot)
    const aChildCount = Object.keys(get().doc.nodes).length
    get().select([kidsOfRoot(A)[0]])
    get().copySel()
    expect(get().past).toHaveLength(1)
    expect(get().clipboard).not.toBeNull()

    // 切到 B：A 的历史/剪贴板进入后台会话，B 是干净会话
    get().openDoc(B)
    expect(get().tabs).toEqual(['A', 'B'])
    expect(get().doc.id).toBe('B')
    expect(get().past).toHaveLength(0)
    expect(get().clipboard).toBeNull()
    expect(get().selection).toEqual([])
    expect(get().sessions.A).toBeTruthy()
    expect(get().sessions.A.past).toHaveLength(1)

    // 在 B 中编辑：不影响 A 的文档内容
    get().addChild(B.rootId)
    expect(get().past).toHaveLength(1)

    // 切回 A：撤销栈与剪贴板原样恢复，A 的节点数不含 B 的新增
    get().openDoc(A)
    expect(get().doc.id).toBe('A')
    expect(get().past).toHaveLength(1)
    expect(get().clipboard).not.toBeNull()
    expect(Object.keys(get().doc.nodes)).toHaveLength(aChildCount)
    // 活动会话提升到顶层，sessions 不再占位
    expect(get().sessions.A).toBeUndefined()
    expect(get().sessions.B).toBeTruthy()
    expect(get().sessions.B.past).toHaveLength(1)

    // 撤销 A 的一步：A 回到 4 节点；B 会话不受影响
    get().undo()
    expect(Object.keys(get().doc.nodes)).toHaveLength(aChildCount - 1)
    expect(get().sessions.B.past).toHaveLength(1)
  })

  it('openDoc 同一文档重复打开不产生重复标签', () => {
    const A = makeDoc('A', '文档甲')
    get().openDoc(A)
    get().openDoc(A)
    expect(get().tabs).toEqual(['A'])
  })

  it('openDoc 可用 opts.tabs 一次性恢复整组标签（启动场景）', () => {
    const A = makeDoc('A', '甲')
    get().openDoc(A, { tabs: ['X', 'A', 'Y'] })
    expect(get().tabs).toEqual(['X', 'A', 'Y'])
  })

  it('closeTab：关后台标签不影响工作区；关活动标签清空工作区', () => {
    const A = makeDoc('A', '甲')
    const B = makeDoc('B', '乙')
    get().openDoc(A)
    get().openDoc(B)
    expect(get().doc.id).toBe('B')

    // 关后台标签 A
    get().closeTab('A')
    expect(get().tabs).toEqual(['B'])
    expect(get().doc.id).toBe('B')
    expect(get().sessions.A).toBeUndefined()

    // 关活动标签 B
    get().closeTab('B')
    expect(get().tabs).toEqual([])
    expect(get().doc.id).toBe('')
    expect(get().past).toEqual([])
    expect(get().clipboard).toBeNull()
    expect(get().selection).toEqual([])
  })

  it('标签条持久化到 localStorage（msz.openTabs），loadSavedTabs 可读回', () => {
    get().openDoc(makeDoc('A', '甲'))
    get().openDoc(makeDoc('B', '乙'))
    expect(loadSavedTabs()).toEqual(['A', 'B'])
    get().closeTab('A')
    expect(loadSavedTabs()).toEqual(['B'])
  })
})

describe('过滤视图态', () => {
  it('setFilter/clearFilter 更新过滤条件但不进撤销栈', () => {
    get().openDoc(makeDoc('A', '甲'))
    get().addChild(get().doc.rootId)
    const histLen = get().past.length

    get().setFilter({ tag: '重点' })
    expect(get().filter).toEqual({ tag: '重点', status: '' })
    get().setFilter({ status: 'done' })
    expect(get().filter).toEqual({ tag: '重点', status: 'done' })
    expect(get().past).toHaveLength(histLen)

    get().clearFilter()
    expect(get().filter).toEqual({ tag: '', status: '' })
    expect(get().past).toHaveLength(histLen)
  })

  it('切换文档自动重置过滤', () => {
    get().openDoc(makeDoc('A', '甲'))
    get().setFilter({ status: 'doing' })
    get().openDoc(makeDoc('B', '乙'))
    expect(get().filter).toEqual({ tag: '', status: '' })
  })
})

describe('批量操作（单次快照可撤销）', () => {
  beforeEach(() => {
    get().openDoc(makeDoc('A', '甲'))
  })

  it('batchColor：多节点同时改色，一次历史，撤销整体回退', () => {
    const d = get().doc
    const [a, b] = kidsOfRoot(d)
    get().batchColor([a, b], 'b3')
    expect(get().doc.nodes[a].color).toBe('b3')
    expect(get().doc.nodes[b].color).toBe('b3')
    expect(get().past).toHaveLength(1)

    get().undo()
    expect(get().doc.nodes[a].color).toBeUndefined()
    expect(get().doc.nodes[b].color).toBeUndefined()
  })

  it("batchColor('') 清除自定义色", () => {
    const d = get().doc
    const [a] = kidsOfRoot(d)
    get().batchColor([a], 'b0')
    get().batchColor([a], '')
    expect(get().doc.nodes[a].color).toBeUndefined()
  })

  it('batchAddTag：trim、按文本去重；空文本不入历史', () => {
    const d = get().doc
    const [a, b] = kidsOfRoot(d)
    const hist0 = get().past.length
    get().batchAddTag([a, b], '  重点  ', 'red')
    expect(get().doc.nodes[a].tags?.[0]).toMatchObject({ text: '重点', color: 'red' })
    expect(get().doc.nodes[b].tags).toHaveLength(1)
    expect(get().past).toHaveLength(hist0 + 1)

    // 同文本再批量加一次：两节点都不重复
    get().batchAddTag([a, b], '重点', 'blue')
    expect(get().doc.nodes[a].tags).toHaveLength(1)
    expect(get().doc.nodes[b].tags).toHaveLength(1)

    // 空白文本：no-op，无历史
    get().batchAddTag([a, b], '   ', 'blue')
    expect(get().past).toHaveLength(hist0 + 2)
  })

  it('batchUpdate：不存在的 id 全部过滤掉，不入历史', () => {
    const hist0 = get().past.length
    get().batchUpdate(['ghost-1', 'ghost-2'], (n) => ({ ...n, text: 'x' }))
    expect(get().past).toHaveLength(hist0)
  })

  it('批量操作与单节点编辑共用同一撤销栈，顺序正确', () => {
    const d = get().doc
    const [a, b] = kidsOfRoot(d)
    get().batchColor([a, b], 'b2')
    get().addChild(d.rootId)
    expect(get().past).toHaveLength(2)
    get().undo() // 撤新增
    expect(get().doc.nodes[a].color).toBe('b2')
    get().undo() // 撤批量改色
    expect(get().doc.nodes[a].color).toBeUndefined()
    expect(get().doc.nodes[b].color).toBeUndefined()
  })
})
