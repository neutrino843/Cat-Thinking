import { describe, it, expect } from 'vitest'
import { computeVisibleRect, edgeInRect, nodeInRect, type VisibleRect } from './culling'
import type { LaidNode } from './layout'

const n = (x: number, y: number, w = 80, h = 36): LaidNode => ({
  x, y, w, h, side: 1, level: 2, color: '', collapsed: false, hasChildren: false,
  hidden: 0, fontSize: 14, imgH: 0, id: `n${x}_${y}`,
})

const rect: VisibleRect = { x0: 0, y0: 0, x1: 400, y1: 300 }

describe('M8-P2 culling 纯函数', () => {
  describe('computeVisibleRect', () => {
    it('disabled 时返回 null（演示/导出全量渲染）', () => {
      expect(computeVisibleRect({ tx: 0, ty: 0, k: 1 }, 800, 600, 300, true)).toBeNull()
    })
    it('容器尺寸为 0 时返回 null（初始化期不裁剪）', () => {
      expect(computeVisibleRect({ tx: 0, ty: 0, k: 1 }, 0, 0, 300)).toBeNull()
      expect(computeVisibleRect({ tx: 0, ty: 0, k: 1 }, 800, 0, 300)).toBeNull()
    })
    it('k=1、tx=ty=0、容器 800x600、margin 300：矩形覆盖 [-300,1100]×[-300,900]', () => {
      const r = computeVisibleRect({ tx: 0, ty: 0, k: 1 }, 800, 600, 300)
      expect(r).not.toBeNull()
      expect(r!.x0).toBe(-300)
      expect(r!.y0).toBe(-300)
      expect(r!.x1).toBe(1100)
      expect(r!.y1).toBe(900)
    })
    it('缩放 k=2：世界可视范围收窄一半（margin 也按 1/k 缩）', () => {
      const r = computeVisibleRect({ tx: 0, ty: 0, k: 2 }, 800, 600, 300)
      expect(r!.x0).toBe(-150)
      expect(r!.x1).toBe(550)
      expect(r!.y1).toBe(450)
    })
    it('平移 tx=100,ty=50,k=1：矩形右移', () => {
      const r = computeVisibleRect({ tx: 100, ty: 50, k: 1 }, 800, 600, 300)
      expect(r!.x0).toBe(-400)
      expect(r!.y0).toBe(-350)
      expect(r!.x1).toBe(1000)
      expect(r!.y1).toBe(850)
    })
  })

  describe('nodeInRect', () => {
    it('节点在矩形内：相交', () => {
      expect(nodeInRect(n(100, 100), rect)).toBe(true)
    })
    it('节点完全在矩形外：不相交', () => {
      expect(nodeInRect(n(500, 100), rect)).toBe(false)
      expect(nodeInRect(n(100, 400), rect)).toBe(false)
      expect(nodeInRect(n(-200, 100), rect)).toBe(false)
    })
    it('节点与矩形边缘相切（包含边界）：相交', () => {
      // 节点右边 x=400 正好贴矩形右边
      expect(nodeInRect(n(320, 100, 80, 36), rect)).toBe(true)
      // 节点左边 x=0 贴矩形左边
      expect(nodeInRect(n(0, 100, 80, 36), rect)).toBe(true)
    })
    it('节点跨越矩形边界（部分在内）：相交', () => {
      // 节点从 360 到 440，与 [0,400] 部分重叠
      expect(nodeInRect(n(360, 100, 80, 36), rect)).toBe(true)
    })
    it('节点恰在矩形右上角外（不相切）：不相交', () => {
      expect(nodeInRect(n(401, 301, 80, 36), rect)).toBe(false)
    })
  })

  describe('edgeInRect', () => {
    it('端点在矩形内：相交', () => {
      // p0=(50,50), p3=(200,200)，全在 [0,400]×[0,300] 内
      expect(edgeInRect([50, 50, 100, 50, 150, 200, 200, 200], rect)).toBe(true)
    })
    it('端点全在矩形外、控制点也在外：不相交', () => {
      expect(edgeInRect([500, 500, 600, 500, 700, 600, 800, 600], rect)).toBe(false)
    })
    it('控制点在矩形内（端点在外）：相交（保守上界）', () => {
      // p0=(500,500) 在外，c1=(100,100) 在内
      expect(edgeInRect([500, 500, 100, 100, 600, 600, 800, 800], rect)).toBe(true)
    })
    it('边跨越矩形（一端在内一端在外）：相交', () => {
      expect(edgeInRect([100, 100, 200, 200, 600, 600, 800, 800], rect)).toBe(true)
    })
  })
})
