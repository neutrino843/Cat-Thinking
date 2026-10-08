/**
 * M11（PRD 4.1.1 P1）：画布视口数学——滚轮/捏合缩放共用。
 * 纯函数、零 DOM 依赖，便于单测；Canvas 持有 {k,tx,ty} 状态并调用 zoomAt。
 */

export interface View {
  /** 缩放系数，钳制在 MIN_K..MAX_K（PRD：15%–300%） */
  k: number
  tx: number
  ty: number
}

export const MIN_K = 0.15
export const MAX_K = 3

/** 普通鼠标滚轮：每档 100 deltaY ≈ 缩放 12% */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0012)
}

/**
 * 触控板捏合：浏览器把捏合映射为 ctrlKey=true 的 wheel 事件，
 * deltaY 逐事件连续且通常远小于滚轮档位，用更灵敏的系数。
 */
export function pinchFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.01)
}

/**
 * 以屏幕点 (mx,my) 为锚点缩放：锚点对应的世界坐标在缩放前后不变。
 * factor>1 放大、<1 缩小；结果 k 钳制在 15%–300%。
 */
export function zoomAt(v: View, mx: number, my: number, factor: number): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
  const s = k / v.k
  return { k, tx: mx - (mx - v.tx) * s, ty: my - (my - v.ty) * s }
}
