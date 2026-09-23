import { FONT_BODY } from './theme'

let ctx: CanvasRenderingContext2D | null = null
const cache = new Map<string, number>()

/** 用离屏 canvas 近似测量文本宽度（与 SVG 渲染一致性足够 MVP） */
export function measureText(text: string, fontSize: number): number {
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return text.length * fontSize
  }
  const key = fontSize + '|' + text
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  ctx.font = `${fontSize}px ${FONT_BODY}`
  const w = ctx.measureText(text || ' ').width
  cache.set(key, w)
  return w
}
