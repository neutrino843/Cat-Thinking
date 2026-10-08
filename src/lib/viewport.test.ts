import { describe, expect, it } from 'vitest'
import { MAX_K, MIN_K, pinchFactor, wheelFactor, zoomAt, type View } from './viewport'

/** 屏幕点 (mx,my) 对应的世界坐标 */
const world = (v: View, mx: number, my: number) => ({
  x: (mx - v.tx) / v.k,
  y: (my - v.ty) / v.k,
})

describe('viewport 缩放因子', () => {
  it('wheelFactor：下滚（deltaY>0）缩小，上滚放大；100 档约 12%', () => {
    expect(wheelFactor(100)).toBeCloseTo(Math.exp(-0.12), 10)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(0)).toBe(1)
  })

  it('pinchFactor 比 wheelFactor 更灵敏（同 deltaY 下）', () => {
    expect(pinchFactor(10)).toBeCloseTo(Math.exp(-0.1), 10)
    expect(pinchFactor(10)).toBeLessThan(wheelFactor(10))
    expect(pinchFactor(-10)).toBeGreaterThan(wheelFactor(-10))
  })
})

describe('zoomAt 锚点缩放', () => {
  const v0: View = { k: 1, tx: 80, ty: 60 }

  it('锚点处世界坐标在缩放前后保持不变', () => {
    const mx = 420
    const my = 300
    const before = world(v0, mx, my)
    const v1 = zoomAt(v0, mx, my, 1.5)
    expect(v1.k).toBeCloseTo(1.5, 10)
    const after = world(v1, mx, my)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('缩小同样保持锚点', () => {
    const mx = 100
    const my = 200
    const before = world(v0, mx, my)
    const v1 = zoomAt(v0, mx, my, 0.4)
    expect(v1.k).toBeCloseTo(0.4, 10)
    const after = world(v1, mx, my)
    expect(after.x).toBeCloseTo(before.x, 9)
  })

  it('factor=1 时视图不变', () => {
    expect(zoomAt(v0, 500, 500, 1)).toEqual(v0)
  })

  it('k 被钳制在 15%–300%', () => {
    expect(zoomAt(v0, 0, 0, 100).k).toBe(MAX_K)
    expect(zoomAt(v0, 0, 0, 0.0001).k).toBe(MIN_K)
    // 已在上界继续放大：保持上界
    expect(zoomAt({ ...v0, k: MAX_K }, 10, 10, 10).k).toBe(MAX_K)
    expect(zoomAt({ ...v0, k: MIN_K }, 10, 10, 0.01).k).toBe(MIN_K)
  })
})
