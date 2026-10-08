import { FONT_BODY } from './theme'
import { LRUCache } from './lru'

let ctx: CanvasRenderingContext2D | null = null
/** 修 P-4/M8-P1：有界 LRU，防止超长会话/大量不同文本无限增长（≤2000，最久未用先淘汰） */
const cache = new LRUCache<number>(2000)

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
