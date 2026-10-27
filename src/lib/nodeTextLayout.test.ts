import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutNodeText } from './nodeTextLayout'
import { getTextMeasurementRevision, invalidateTextMeasurements, subscribeTextMeasurements } from './measure'
import { computeLayout } from './layout'
import { buildFixture } from '../test/fixture'

let widthFactor = 8
const nativeMeasure = vi.fn((text: string) => ({ width: text.length * widthFactor }))

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: nativeMeasure } as unknown as CanvasRenderingContext2D)
})
beforeEach(() => { widthFactor = 8; invalidateTextMeasurements(); nativeMeasure.mockClear() })
afterAll(() => { vi.restoreAllMocks() })

describe('节点排版缓存与字体失效', () => {
  it('完整标题复用不可变结果，不再逐字测量', () => {
    const first = layoutNodeText('定义 👩‍🔬\n独立推导关键步骤'.repeat(8), 16)
    expect(nativeMeasure).toHaveBeenCalled()
    nativeMeasure.mockClear()
    expect(layoutNodeText('定义 👩‍🔬\n独立推导关键步骤'.repeat(8), 16)).toBe(first)
    expect(nativeMeasure).not.toHaveBeenCalled()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.lines)).toBe(true)
    expect(() => Object.defineProperty(first.lines, '0', { value: '被污染' })).toThrow()
  })

  it('文本、字号、根字体、最大宽度均参与缓存身份', () => {
    const first = layoutNodeText('同一个标题'.repeat(8), 16)
    for (const next of [layoutNodeText('不同的标题', 16), layoutNodeText('同一个标题'.repeat(8), 14), layoutNodeText('同一个标题'.repeat(8), 16, true), layoutNodeText('同一个标题'.repeat(8), 16, false, 90)]) {
      expect(next).not.toBe(first)
    }
  })

  it('字体代次失效同时重测宽度和换行，退订后不再通知', () => {
    const old = layoutNodeText('原字体标题'.repeat(8), 16)
    const listener = vi.fn()
    const unsubscribe = subscribeTextMeasurements(listener)
    const revision = getTextMeasurementRevision()
    widthFactor = 16
    invalidateTextMeasurements()
    const current = layoutNodeText('原字体标题'.repeat(8), 16)
    expect(getTextMeasurementRevision()).toBe(revision + 1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(current).not.toBe(old)
    expect(current.lines.length).toBeGreaterThan(old.lines.length)
    unsubscribe(); invalidateTextMeasurements()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('字体事件仅注册一次且失败也触发失效', () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
    const fonts = new EventTarget()
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      const revision = getTextMeasurementRevision()
      getTextMeasurementRevision(); layoutNodeText('事件测试', 16)
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(getTextMeasurementRevision()).toBe(revision + 1)
      fonts.dispatchEvent(new Event('loadingerror'))
      expect(getTextMeasurementRevision()).toBe(revision + 2)
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor)
      else Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('2000条和字符预算都会淘汰旧结果，超长单条不缓存', () => {
    const first = layoutNodeText('条数旧项', 16)
    for (let i = 0; i < 2001; i++) layoutNodeText(`项${i}`, 16)
    expect(layoutNodeText('条数旧项', 16)).not.toBe(first)
    const weighted = layoutNodeText('字符旧项', 16)
    for (let i = 0; i < 180; i++) layoutNodeText(`${i}${'字'.repeat(1800)}`, 16)
    expect(layoutNodeText('字符旧项', 16)).not.toBe(weighted)
    const huge = '字'.repeat(8193)
    expect(layoutNodeText(huge, 16)).not.toBe(layoutNodeText(huge, 16))
  })

  for (const layout of ['logic', 'tree', 'org', 'fishbone', 'timeline'] as const) it(`${layout}混合夹具冷/热缓存保持完整几何，单点编辑不测量其他标题`, () => {
    const doc = buildFixture({ text: '章节', children: [{ text: '概念'.repeat(20), note: '我的理解', children: [{ text: '推导'.repeat(30) }] }, { text: '折叠', collapsed: true, children: [{ text: '隐藏' }] }, { text: '对照方案' }] }, layout)
    doc.nodes.n1.images = [{ id: 'image', blobId: 'synthetic', w: 160, h: 100 }]
    doc.relations = [{ id: 'rel', from: 'n1', to: 'n5', label: '关联' }]
    doc.summaries = [{ id: 'sum', members: ['n1', 'n3'], label: '总结' }]
    doc.boundaryBoxes = [{ id: 'box', members: ['n1', 'n2'], label: '范围' }]
    const cold = computeLayout(doc)
    nativeMeasure.mockClear()
    expect(computeLayout(doc)).toEqual(cold)
    expect(nativeMeasure).not.toHaveBeenCalled()
    invalidateTextMeasurements()
    expect(computeLayout(doc)).toEqual(cold)
    doc.nodes.n2 = { ...doc.nodes.n2, text: '新步骤' }
    nativeMeasure.mockClear()
    const edited = computeLayout(doc)
    expect(edited.nodes.get('n2')?.textLines?.join('')).toBe('新步骤')
    expect(nativeMeasure.mock.calls.every(([text]) => '新步骤'.includes(text))).toBe(true)
    expect(edited.relations).toHaveLength(1)
    expect(edited.boxes).toHaveLength(1)
  })
})
