import type { SourceStructureBlock } from '../documentExtractors'
import { isDocumentMetadata } from '../importTitles'
import { explicitPlainHeading, numberedHeadingContext, type PlainHeading } from '../importHeadings'

interface Line { text: string; x: number; y: number; size: number; right: number }
interface Item { str: string; transform?: number[]; width?: number; height?: number }

/** Conservative text layout recovery. It produces evidence blocks, not concept inference. */
export function pdfPageStructure(input: unknown[]): { text: string; blocks: SourceStructureBlock[] } {
  const items = input.filter((value): value is Item => !!value && typeof value === 'object' && typeof (value as Item).str === 'string')
  const rows: Line[] = []
  const rowBuckets = new Map<number, Line[]>()
  const sizes = new Map<number, number>()
  for (const [index, item] of items.entries()) {
    const text = item.str.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? -index * 16
    const size = Math.max(1, Math.abs(item.height || item.transform?.[3] || item.transform?.[0] || 12))
    if (![x, y, size].every(Number.isFinite)) continue
    sizes.set(Math.round(size), (sizes.get(Math.round(size)) ?? 0) + text.length)
    const width = typeof item.width === 'number' && Number.isFinite(item.width) && item.width >= 0 ? item.width : text.length * size * .5
    const bucket = Math.round(y / 4)
    const candidates = [-1, 0, 1].flatMap((delta) => rowBuckets.get(bucket + delta) ?? [])
    const row = candidates.find((line) => Math.abs(line.y - y) <= Math.max(2, size * .2) && x >= line.x && x - line.right < size * 2)
    if (row) { row.text += ` ${text}`; row.right = Math.max(row.right, x + width); row.size = Math.max(row.size, size) }
    else {
      const line = { text, x, y, size, right: x + width }
      rows.push(line)
      rowBuckets.set(bucket, [...(rowBuckets.get(bucket) ?? []), line])
    }
  }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12
  const ordinary = rows.filter((line) => line.size <= bodySize * 1.15)
  const starts = [...new Set(ordinary.map((line) => Math.round(line.x / 12) * 12))].sort((a, b) => a - b)
  let split: number | undefined
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] < bodySize * 8) continue
    const boundary = (starts[i] + starts[i - 1]) / 2
    const left = ordinary.filter((line) => line.x < boundary && line.right < starts[i])
    const right = ordinary.filter((line) => line.x >= boundary)
    if (left.length >= 3 && right.length >= 3 && Math.min(Math.max(...left.map((l) => l.y)), Math.max(...right.map((l) => l.y)))
      - Math.max(Math.min(...left.map((l) => l.y)), Math.min(...right.map((l) => l.y))) > bodySize * 2) { split = boundary; break }
  }
  const topDown = (a: Line, b: Line) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x
  let ordered = [...rows].sort(topDown)
  if (split !== undefined) {
    const boundary = split
    // Full-width headings delimit reading bands; read each band left column then right.
    const result: Line[] = []
    let band: Line[] = []
    const flush = () => { result.push(...band.filter((line) => line.x < boundary).sort(topDown), ...band.filter((line) => line.x >= boundary).sort(topDown)); band = [] }
    for (const line of ordered) {
      if (line.x < split && line.right > split || line.size > bodySize * 1.3) { flush(); result.push(line) }
      else band.push(line)
    }
    flush(); ordered = result
  }
  const pageNumber = (text: string) => /^(?:page\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?$|^第\s*\d{1,4}\s*页$/i.test(text)
  if (ordered[0] && pageNumber(ordered[0].text)) ordered.shift()
  const last = ordered.at(-1)
  if (last && pageNumber(last.text)) ordered.pop()
  const blocks: SourceStructureBlock[] = []
  let text = ''
  let previous: Line | undefined
  const context = numberedHeadingContext(ordered.map((line) => explicitPlainHeading(line.text)).filter((heading): heading is PlainHeading => !!heading))
  const leftBase = ordinary.filter((line) => split === undefined || line.x < split).reduce((x, line) => Math.min(x, line.x), Infinity)
  const rightBase = ordinary.filter((line) => split !== undefined && line.x >= split).reduce((x, line) => Math.min(x, line.x), Infinity)
  for (const [lineIndex, line] of ordered.entries()) {
    const bullet = line.text.match(/^(?:[•◦▪●\-*]|\d+[.)、])\s+(.+)/)
    const candidate = explicitPlainHeading(line.text)
    const explicit = candidate && context(candidate) ? candidate : null
    const heading = !isDocumentMetadata(line.text) && line.text.length <= 120 && (line.size > bodySize * 1.15 || explicit)
    const kind = heading ? 'heading' : bullet ? 'list' : 'paragraph'
    const prior = blocks.at(-1)
    const continuation = kind === 'paragraph' && prior?.kind === 'paragraph' && previous
      && !candidate && !explicitPlainHeading(previous.text)
      && !/[。！？.!?:：；;]$/.test(previous.text) && !isDocumentMetadata(previous.text) && !isDocumentMetadata(line.text)
      && Math.abs(line.x - previous.x) < bodySize * 2 && Math.abs(line.y - previous.y) < bodySize * 1.8
    if (text) text += continuation ? '\n' : '\n\n'
    const start = text.length
    text += line.text
    const base = split !== undefined && line.x >= split ? rightBase : leftBase
    if (continuation && prior) prior.end = text.length
    else blocks.push({ kind, level: heading ? explicit?.level ?? (line.size > bodySize * 1.55 ? 1 : 2) : bullet ? Math.min(8, Math.max(0, Math.round((line.x - (Number.isFinite(base) ? base : line.x)) / (bodySize * 2)))) : 0,
      start, end: text.length, ...(bullet && !heading ? { label: bullet[1] } : {}),
      ...(lineIndex === 0 ? { edge: 'top' as const, position: Math.round(line.y / 12) } : lineIndex === ordered.length - 1 ? { edge: 'bottom' as const, position: Math.round(line.y / 12) } : {}) })
    previous = line
  }
  return { text, blocks }
}

/** Exclude repeated decorations from the tree; their text stays at the same offsets. */
export function excludeRepeatedPdfDecorations(pages: readonly { text: string; blocks: SourceStructureBlock[] }[]): { blocks: SourceStructureBlock[][]; excluded: number } {
  const counts = new Map<string, Set<number>>()
  const keyFor = (text: string, block: SourceStructureBlock) => {
    const value = text.slice(block.start, block.end)
    return block.edge && block.kind !== 'list' && value.length <= 100 && !value.includes('\n')
      ? `${block.edge}:${block.position}:${value}` : ''
  }
  for (const [page, item] of pages.entries()) for (const block of item.blocks) {
    const key = keyFor(item.text, block)
    if (key) { const found = counts.get(key) ?? new Set<number>(); found.add(page); counts.set(key, found) }
  }
  const minimum = Math.max(2, Math.ceil(pages.length * .6))
  let excluded = 0
  const blocks = pages.map((page, index) => page.blocks.filter((block) => {
    const occurrences = counts.get(keyFor(page.text, block))
    const repeated = (occurrences?.size ?? 0) >= minimum
    if (repeated && block.edge === 'top' && block.kind === 'heading' && occurrences?.values().next().value === index) return true
    if (repeated) excluded++
    return !repeated
  }))
  return { blocks, excluded }
}
