import { beforeEach, describe, expect, it, vi } from 'vitest'

// tabs.ts 只编排 IndexedDB 读写；单测用 mock 隔离 Dexie
vi.mock('../store/db', () => ({
  listDocs: vi.fn(),
  loadDoc: vi.fn(),
  saveDoc: vi.fn(),
}))
vi.mock('../data/templates', () => ({
  findTpl: () => ({}),
  buildDoc: () => ({
    id: 'new-blank',
    title: '未命名导图',
    rootId: '',
    nodes: {},
    version: 3,
    layout: 'logic',
    createdAt: 1,
    updatedAt: 1,
  }),
}))

import { EMPTY_DOC, useDoc } from '../store/docStore'
import { listDocs, loadDoc, saveDoc } from '../store/db'
import { closeDocTab, restoreTabIds } from './tabs'
import { simpleFixture } from '../test/fixture'
import type { DocData } from '../types'

const get = () => useDoc.getState()
const makeDoc = (id: string, title: string): DocData => {
  const d = simpleFixture()
  d.id = id
  d.title = title
  return d
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
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

describe('closeDocTab 编排', () => {
  it('关闭后台标签：不读库、不建文档，工作区保持不动', async () => {
    get().openDoc(makeDoc('A', '甲'))
    get().openDoc(makeDoc('B', '乙'))
    expect(get().doc.id).toBe('B')

    await closeDocTab('A')

    expect(loadDoc).not.toHaveBeenCalled()
    expect(saveDoc).not.toHaveBeenCalled()
    expect(get().doc.id).toBe('B')
    expect(get().tabs).toEqual(['B'])
  })

  it('关闭活动标签：自动切到相邻标签', async () => {
    const A = makeDoc('A', '甲')
    get().openDoc(A)
    get().openDoc(makeDoc('B', '乙'))
    vi.mocked(loadDoc).mockResolvedValue(A)

    await closeDocTab('B')

    expect(loadDoc).toHaveBeenCalledWith('A')
    expect(get().doc.id).toBe('A')
    expect(get().tabs).toEqual(['A'])
    expect(saveDoc).not.toHaveBeenCalled()
  })

  it('关闭最后一个标签：兜底新建空白文档并落盘挂标签', async () => {
    get().openDoc(makeDoc('A', '甲'))
    vi.mocked(saveDoc).mockResolvedValue(undefined)

    await closeDocTab('A')

    expect(saveDoc).toHaveBeenCalledTimes(1)
    expect(get().doc.id).toBe('new-blank')
    expect(get().tabs).toEqual(['new-blank'])
  })
})

describe('restoreTabIds', () => {
  it('剔除库中已不存在的 id，保持原顺序', async () => {
    localStorage.setItem('msz.openTabs', JSON.stringify(['A', 'X', 'B']))
    vi.mocked(listDocs).mockResolvedValue([
      { id: 'B' },
      { id: 'A' },
    ] as Awaited<ReturnType<typeof listDocs>>)
    expect(await restoreTabIds()).toEqual(['A', 'B'])
  })

  it('无存储或列表失败返回空数组', async () => {
    vi.mocked(listDocs).mockResolvedValue([])
    expect(await restoreTabIds()).toEqual([])
    localStorage.setItem('msz.openTabs', JSON.stringify(['A']))
    vi.mocked(listDocs).mockRejectedValue(new Error('idb down'))
    expect(await restoreTabIds()).toEqual([])
  })
})
