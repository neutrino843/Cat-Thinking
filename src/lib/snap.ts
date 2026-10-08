/**
 * M12（PRD 4.4 P1）：对齐吸附 / 辅助线。
 *
 * 输入：被拖节点的矩形（已含本次 dx/dy 偏移）与其余节点矩形集合、吸附阈值。
 * 输出：需要回贴的偏移修正（snapDx, snapDy）与要绘制的辅助线坐标。
 *
 * 设计：对齐维度独立——水平方向比对 y 基准线（top/center/bottom），
 * 垂直方向比对 x 基准线（left/center/right）。每条基准线取最近且在阈值内的
 * 目标线吸附；最终取各维度最小残差的那条作为辅助线。
 */

export interface SnapRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GuideLine {
  /** 水平辅助线（y 固定，跨 x1..x2）或垂直辅助线（x 固定，跨 y1..y2） */
  orientation: 'horizontal' | 'vertical'
  /** 固定坐标：水平时为 y，垂直时为 x */
  pos: number
  /** 线段起止：水平时为 [x1,x2]，垂直时为 [y1,y2] */
  from: number
  to: number
}

export interface SnapResult {
  snapDx: number
  snapDy: number
  guides: GuideLine[]
}

const SNAP_THRESHOLD = 8

interface Axis {
  /** 被拖节点在该轴上的三条基准线坐标 */
  dragged: { left: number; center: number; right: number }
  /** 所有目标节点在该轴上的基准线集合 */
  targets: Array<{ left: number; center: number; right: number }>
}

/**
 * 单轴吸附：返回该轴的吸附偏移量（0 表示不吸附）与命中的目标线坐标。
 */
function snapAxis(
  axis: Axis,
  threshold: number,
): { delta: number; linePos: number | null } {
  const keys: Array<keyof Axis['dragged']> = ['left', 'center', 'right']
  let bestDelta = 0
  let bestLine: number | null = null
  let bestDist = threshold
  for (const k of keys) {
    const dv = axis.dragged[k]
    for (const t of axis.targets) {
      const tv = t[k]
      const dist = Math.abs(tv - dv)
      if (dist < bestDist) {
        bestDist = dist
        bestDelta = tv - dv
        bestLine = tv
      }
    }
  }
  return { delta: bestDelta, linePos: bestLine }
}

/**
 * 计算吸附结果。
 * @param dragged 被拖节点当前矩形（原位置 + 偏移）
 * @param others  其余节点矩形（不含被拖子树）
 * @param dx      本次拖拽已施加的偏移（world 单位）
 * @param dy      本次拖拽已施加的偏移（world 单位）
 * @param threshold 吸附阈值（world px），默认 8
 */
export function computeSnap(
  dragged: SnapRect,
  others: SnapRect[],
  dx: number,
  dy: number,
  threshold = SNAP_THRESHOLD,
): SnapResult {
  const cur: SnapRect = { x: dragged.x + dx, y: dragged.y + dy, w: dragged.w, h: dragged.h }
  const draggedX = { left: cur.x, center: cur.x + cur.w / 2, right: cur.x + cur.w }
  const draggedY = { left: cur.y, center: cur.y + cur.h / 2, right: cur.y + cur.h }
  const targetX = others.map((o) => ({ left: o.x, center: o.x + o.w / 2, right: o.x + o.w }))
  const targetY = others.map((o) => ({ left: o.y, center: o.y + o.h / 2, right: o.y + o.h }))

  const xRes = snapAxis({ dragged: draggedX, targets: targetX }, threshold)
  const yRes = snapAxis({ dragged: draggedY, targets: targetY }, threshold)

  const guides: GuideLine[] = []
  // 垂直辅助线（x 固定）：跨越被拖节点与目标节点的 y 范围
  if (xRes.linePos !== null) {
    const ys = [cur.y, cur.y + cur.h, ...others.map((o) => [o.y, o.y + o.h]).flat()]
    guides.push({
      orientation: 'vertical',
      pos: xRes.linePos,
      from: Math.min(...ys),
      to: Math.max(...ys),
    })
  }
  // 水平辅助线（y 固定）：跨越被拖节点与目标节点的 x 范围
  if (yRes.linePos !== null) {
    const xs = [cur.x, cur.x + cur.w, ...others.map((o) => [o.x, o.x + o.w]).flat()]
    guides.push({
      orientation: 'horizontal',
      pos: yRes.linePos,
      from: Math.min(...xs),
      to: Math.max(...xs),
    })
  }

  return { snapDx: xRes.delta, snapDy: yRes.delta, guides }
}
