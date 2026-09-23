import { describe, expect, it } from 'vitest'
import { cubicPts, hashSeed, mulberry32, roundedRectPts, sketchPath, type Pt } from '../lib/sketch'

describe('sketch 手绘笔触', () => {
  it('hashSeed 确定且不同字符串不同', () => {
    expect(hashSeed('a>b')).toBe(hashSeed('a>b'))
    expect(hashSeed('a>b')).not.toBe(hashSeed('b>a'))
  })

  it('mulberry32 同种子序列一致', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('jitter=0 时路径为直线', () => {
    const pts: Pt[] = [
      [0, 0],
      [100, 0],
    ]
    const d = sketchPath(pts, { seed: 1, jitter: 0, passes: 1 })
    // 所有采样点 y 应严格为 0
    const ys = [...d.matchAll(/[\d.]+ ([\d.-]+)/g)].map((m) => Number(m[1]))
    expect(ys.every((y) => y === 0)).toBe(true)
    expect(d.startsWith('M0.0 0.0')).toBe(true)
  })

  it('同种子抖动稳定，不同种子不同', () => {
    const pts: Pt[] = [
      [0, 0],
      [60, 30],
    ]
    const o = { jitter: 2, passes: 2 }
    const d1 = sketchPath(pts, { seed: 7, ...o })
    const d2 = sketchPath(pts, { seed: 7, ...o })
    const d3 = sketchPath(pts, { seed: 8, ...o })
    expect(d1).toBe(d2)
    expect(d1).not.toBe(d3)
  })

  it('roundedRectPts 闭合且顶点范围正确', () => {
    const pts = roundedRectPts(10, 20, 100, 50, 8)
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(10, 5)
    expect(Math.max(...xs)).toBeCloseTo(110, 5)
    expect(Math.min(...ys)).toBeCloseTo(20, 5)
    expect(Math.max(...ys)).toBeCloseTo(70, 5)
    const first = pts[0]
    const last = pts[pts.length - 1]
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(12)
  })

  it('cubicPts 起止点精确', () => {
    const pts = cubicPts(0, 0, 10, 10, 40, 10, 50, 0)
    expect(pts[0]).toEqual([0, 0])
    expect(pts[pts.length - 1]).toEqual([50, 0])
    expect(pts.length).toBe(15)
  })
})
