import { getTextMeasurementRevision, measureText } from './measure'
import { LRUCache } from './lru'
import { FONT_BODY, FONT_HAND } from './theme'

export const NODE_TEXT_MAX_WIDTH = 320
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export interface NodeTextLayout {
  readonly lines: readonly string[]
  readonly lineHeight: number
  readonly width: number
  readonly height: number
}

// Bound both entry count and retained characters (keys + line contents).
const cache = new LRUCache<NodeTextLayout>(2000, {
  maxWeight: 512_000,
  weightOf: (key, value) => key.length + value.lines.reduce((sum, line) => sum + line.length, 0),
})
let cachedRevision = -1

/** One measured set of lines is shared by SVG drawing, hit bounds and export. */
export function layoutNodeText(text: string, fontSize: number, root = false, maxWidth = NODE_TEXT_MAX_WIDTH): NodeTextLayout {
  const revision = getTextMeasurementRevision()
  if (cachedRevision !== revision) { cache.clear(); cachedRevision = revision }
  const fontFamily = root ? FONT_HAND : FONT_BODY
  // Very long one-off source excerpts should not displace ordinary node titles.
  const key = text.length <= 8192 ? JSON.stringify([fontFamily, fontSize, maxWidth, text]) : undefined
  const hit = key === undefined ? undefined : cache.get(key)
  if (hit) return hit
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    for (const { segment } of segmenter.segment(paragraph)) {
      if (line && measureText(line + segment, fontSize, fontFamily) > maxWidth) {
        const space = line.lastIndexOf(' ')
        // Preserve word boundaries when possible; long words fall back to graphemes.
        if (space > line.length / 2 && segment !== ' ') {
          lines.push(line.slice(0, space + 1))
          line = line.slice(space + 1)
        } else { lines.push(line); line = '' }
      }
      line += segment
    }
    lines.push(line || ' ')
  }
  const lineHeight = Math.ceil(fontSize * 1.4)
  const result = Object.freeze({ lines: Object.freeze(lines), lineHeight, width: lines.reduce((width, line) => Math.max(width, measureText(line, fontSize, fontFamily)), 0), height: lines.length * lineHeight })
  if (key !== undefined) cache.set(key, result)
  return result
}
