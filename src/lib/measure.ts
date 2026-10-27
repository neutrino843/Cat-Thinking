import { FONT_BODY } from './theme'
import { LRUCache } from './lru'

let ctx: CanvasRenderingContext2D | null = null
/** 修 P-4/M8-P1：有界 LRU，防止超长会话/大量不同文本无限增长（≤2000，最久未用先淘汰） */
const cache = new LRUCache<number>(2000, { maxWeight: 128_000, weightOf: (key) => key.length })
let revision = 0
let observedFonts: FontFaceSet | undefined
const listeners = new Set<() => void>()

/** Width and wrapped-line caches share this revision. Font swaps affect geometry. */
export function invalidateTextMeasurements(): void {
  cache.clear()
  revision++
  for (const listener of listeners) listener()
}

function observeFonts(): void {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  if (!fonts || fonts === observedFonts) return
  observedFonts?.removeEventListener('loadingdone', invalidateTextMeasurements)
  observedFonts?.removeEventListener('loadingerror', invalidateTextMeasurements)
  observedFonts = fonts
  fonts.addEventListener('loadingdone', invalidateTextMeasurements)
  fonts.addEventListener('loadingerror', invalidateTextMeasurements)
}

export function getTextMeasurementRevision(): number {
  observeFonts()
  return revision
}

export function subscribeTextMeasurements(listener: () => void): () => void {
  observeFonts()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 用离屏 canvas 近似测量文本宽度（与 SVG 渲染一致性足够 MVP） */
export function measureText(text: string, fontSize: number, fontFamily = FONT_BODY): number {
  observeFonts()
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return text.length * fontSize
  }
  const key = fontFamily + '|' + fontSize + '|' + text
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  ctx.font = `${fontSize}px ${fontFamily}`
  const w = ctx.measureText(text || ' ').width
  cache.set(key, w)
  return w
}
