import { FONT_BODY } from './theme'

let ctx: CanvasRenderingContext2D | null = null
const cache = new Map<string, number>()
/** 修 P-4：缓存上限，防止超长会话/大量不同文本无限增长（Map 按插入序淘汰最旧项） */
const CACHE_MAX = 2000

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
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, w)
  return w
}
