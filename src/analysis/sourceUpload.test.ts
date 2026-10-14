import { describe, expect, it } from 'vitest'
import { sourcePartRanges, sourceUploadPart } from './sourceUpload'
import { sha256Hex } from './fingerprint'

describe('Unicode upload partition', () => {
  it('preserves full text and UTF-16 offsets within every byte limit', async () => {
    const text = '中🌱x\n文'.repeat(30)
    const snapshot = { version: 1 as const, sourceId: 'source', kind: 'text' as const, extractor: 'synthetic', contentHash: await sha256Hex(text), charCount: text.length, byteCount: new TextEncoder().encode(text).byteLength }
    for (const limit of [4, 5, 16, 128_000]) {
      const ranges = sourcePartRanges(text, limit)
      const parts = await Promise.all(ranges.map((_, i) => sourceUploadPart(snapshot, text, limit, i)))
      expect(parts.map((p) => p.text).join('')).toBe(text)
      for (const part of parts) expect(new TextEncoder().encode(part.text).length).toBeLessThanOrEqual(limit)
      expect(parts.at(-1)?.end).toBe(text.length)
    }
  })
  it('bounds malformed limits, part indexes, empty input and total part count', async () => {
    expect(() => sourcePartRanges('x', 3)).toThrow(RangeError)
    expect(() => sourcePartRanges('x', 4.5)).toThrow(RangeError)
    expect(() => sourcePartRanges('x'.repeat(40_001), 4)).toThrow('Too many')
    expect(sourcePartRanges('', 4)).toEqual([{ start: 0, end: 0 }])
    await expect(sourceUploadPart({ version: 1, sourceId: 's', kind: 'text', extractor: 'synthetic', contentHash: 'a'.repeat(64), charCount: 1, byteCount: 1 }, 'x', 4, 2)).rejects.toThrow('index')
  })
})
