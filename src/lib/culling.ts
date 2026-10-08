/**
 * M8-P2-1：视口裁剪纯函数。
 *
 * 将屏幕可视矩形映射到世界坐标，提供节点/边的 AABB 相交判定，
 * 供 Canvas 渲染前筛选可见集合。纯函数不依赖 DOM/React，便于单测。
 */

import type { LaidNode } from './layout'

export interface View {
  tx: number
  ty: number
  k: number
}

export interface VisibleRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 计算世界坐标下的可见矩形。
 * 屏幕原点在容器左上；世界点 (wx,wy) 映射到屏幕 (wx*k + tx, wy*k + ty)。
 * 反推：屏幕 x → 世界 (x - tx) / k。四边各外扩 margin 像素（屏幕空间），换算为世界空间 margin/k。
 *
 * 返回 null 表示「不裁剪」（disabled 或容器尺寸未就绪）。
 */
export function computeVisibleRect(
  view: View,
  wrapW: number,
  wrapH: number,
  margin: number,
  disabled = false,
): VisibleRect | null {
  if (disabled) return null
  if (wrapW === 0 || wrapH === 0) return null
  const k = view.k
  return {
    x0: (-view.tx - margin) / k,
    y0: (-view.ty - margin) / k,
    x1: (wrapW - view.tx + margin) / k,
    y1: (wrapH - view.ty + margin) / k,
  }
}

/** 节点 AABB 与可见矩形相交判定（含相切） */
export function nodeInRect(n: LaidNode, r: VisibleRect): boolean {
  return n.x <= r.x1 && n.x + n.w >= r.x0 && n.y <= r.y1 && n.y + n.h >= r.y0
}

/**
 * 边的 4 个控制点 bbox 与可见矩形相交判定。
 * 三次贝塞尔 points=[x0,y0,c1x,c1y,c2x,c2y,x1,y1]，控制点 bbox 是曲线包围盒的保守上界。
 */
export function edgeInRect(points: number[], r: VisibleRect): boolean {
  const minX = Math.min(points[0], points[2], points[4], points[6])
  const maxX = Math.max(points[0], points[2], points[4], points[6])
  const minY = Math.min(points[1], points[3], points[5], points[7])
  const maxY = Math.max(points[1], points[3], points[5], points[7])
  return maxX >= r.x0 && minX <= r.x1 && maxY >= r.y0 && minY <= r.y1
}
