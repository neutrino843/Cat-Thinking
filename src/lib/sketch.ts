/** 自研手绘笔触：种子随机抖动路径生成（Rough.js 思路，~100 行） */

export type Pt = [number, number]

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SketchOpts {
  seed: number
  /** 抖动幅度（世界坐标像素） */
  jitter: number
  /** 复写遍数（1 = 单线） */
  passes: number
}

function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const d = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(1, Math.ceil(d / step))
    for (let j = 1; j <= n; j++) out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n])
  }
  return out
}

function jitterPts(pts: Pt[], rnd: () => number, jitter: number): Pt[] {
  if (jitter <= 0) return pts
  return pts.map((p, i) => {
    const k = i === 0 || i === pts.length - 1 ? 0.6 : 2
    return [p[0] + (rnd() - 0.5) * jitter * k, p[1] + (rnd() - 0.5) * jitter * k] as Pt
  })
}

/** 把折线/采样点列转成手绘 path d（多遍复写时为多段 M 子路径） */
export function sketchPath(pts: Pt[], o: SketchOpts): string {
  const rnd = mulberry32(o.seed)
  const base = resample(pts, 12)
  const parts: string[] = []
  const passes = Math.max(1, o.passes)
  for (let p = 0; p < passes; p++) {
    const jp = jitterPts(base, rnd, o.jitter)
    parts.push(
      jp
        .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`)
        .join(''),
    )
  }
  return parts.join('')
}

/** 圆角矩形轮廓采样点（顺时针，首尾闭合） */
export function roundedRectPts(x: number, y: number, w: number, h: number, r: number, step = 10): Pt[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  const pts: Pt[] = []
  const PI = Math.PI
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.ceil(((a1 - a0) * r) / step))
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const d = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(1, Math.ceil(d / step))
    for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n])
  }
  seg(x + r, y, x + w - r, y)
  arc(x + w - r, y + r, -PI / 2, 0)
  seg(x + w, y + r, x + w, y + h - r)
  arc(x + w - r, y + h - r, 0, PI / 2)
  seg(x + w - r, y + h, x + r, y + h)
  arc(x + r, y + h - r, PI / 2, PI)
  seg(x, y + h - r, x, y + r)
  arc(x + r, y + r, PI, 1.5 * PI)
  return pts
}

/** 三次贝塞尔采样点列 */
export function cubicPts(
  x0: number, y0: number,
  c1x: number, c1y: number,
  c2x: number, c2y: number,
  x1: number, y1: number,
  n = 14,
): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    pts.push([
      u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1,
      u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1,
    ])
  }
  return pts
}
