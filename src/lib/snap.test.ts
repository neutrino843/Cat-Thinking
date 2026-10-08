import { describe, expect, it } from 'vitest'
import { computeSnap } from './snap'

describe('computeSnap 对齐吸附', () => {
  it('无目标时不吸附、无辅助线', () => {
    const r = computeSnap({ x: 0, y: 0, w: 100, h: 40 }, [], 10, 20)
    expect(r.snapDx).toBe(0)
    expect(r.snapDy).toBe(0)
    expect(r.guides).toHaveLength(0)
  })

  it('左边缘在阈值内吸附到目标左边缘并产出垂直辅助线', () => {
    // y 故意错开（500）避免水平轴也吸附
    const dragged = { x: 0, y: 0, w: 100, h: 40 }
    const others = [{ x: 200, y: 500, w: 80, h: 40 }]
    // dx=195 → 左边缘到 195，距 200 差 5（<8）应吸附到 200，snapDx=5
    const r = computeSnap(dragged, others, 195, 0)
    expect(r.snapDx).toBe(5)
    expect(r.snapDy).toBe(0)
    expect(r.guides).toHaveLength(1)
    expect(r.guides[0].orientation).toBe('vertical')
    expect(r.guides[0].pos).toBe(200)
  })

  it('水平中心线吸附并产出水平辅助线', () => {
    // 不同高度 h，使只有中心线在阈值内（顶/底不吸附）
    const dragged = { x: 0, y: 0, w: 100, h: 40 } // center=20
    const others = [{ x: 500, y: 100, w: 80, h: 60 }] // center=130
    // dy=108 → 中心 128，距 130 差 2；顶 108 距 100 差 8（不吸附）→ 仅中心吸附
    const r = computeSnap(dragged, others, 0, 108)
    expect(r.snapDy).toBe(2)
    expect(r.guides[0].orientation).toBe('horizontal')
    expect(r.guides[0].pos).toBe(130)
  })

  it('超过阈值不吸附', () => {
    const dragged = { x: 0, y: 0, w: 100, h: 40 }
    const others = [{ x: 200, y: 500, w: 80, h: 40 }]
    const r = computeSnap(dragged, others, 100, 0) // 左边缘 100，距 200 差 100
    expect(r.snapDx).toBe(0)
    expect(r.guides).toHaveLength(0)
  })

  it('双轴同时吸附产出两条辅助线', () => {
    const dragged = { x: 0, y: 0, w: 100, h: 40 }
    const others = [{ x: 200, y: 100, w: 80, h: 40 }]
    // 左差 5，中心 y 差 3
    const r = computeSnap(dragged, others, 195, 97)
    expect(r.snapDx).toBe(5)
    expect(r.snapDy).toBe(3)
    expect(r.guides).toHaveLength(2)
  })

  it('右边缘吸附到目标右边缘', () => {
    // 不同宽度，使只有右边缘在阈值内
    const dragged = { x: 0, y: 0, w: 100, h: 40 } // right=100
    const others = [{ x: 0, y: 500, w: 80, h: 40 }] // right=80, center=40
    // dx=-16 → 右 84 距 80 差 4；中心 34 距 40 差 6 → 右边缘更近，snapDx=-4
    const r = computeSnap(dragged, others, -16, 0)
    expect(r.snapDx).toBe(-4)
    expect(r.guides[0].pos).toBe(80)
  })
})
