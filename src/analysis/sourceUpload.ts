import { uploadSourcePartSchema, type SourceSnapshotV1, type UploadSourcePartV1 } from '@cat-thinking/analysis-contracts'
import { sha256Hex } from './fingerprint'

/** Stable UTF-8 byte partition; never split a Unicode code point. Offsets remain UTF-16. */
export function sourcePartRanges(text: string, maxBytes: number): { start: number; end: number }[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Invalid upload part limit')
  const ranges: { start: number; end: number }[] = []
  let start = 0
  let end = 0
  let bytes = 0
  for (const point of text) {
    // Equivalent to UTF-8 encoding, including isolated surrogates (replacement
    // character = 3 bytes), without allocating an array for every character.
    const size = point.length === 2 ? 4 : point.charCodeAt(0) <= 0x7f ? 1 : point.charCodeAt(0) <= 0x7ff ? 2 : 3
    if (bytes + size > maxBytes) { ranges.push({ start, end }); start = end; bytes = 0 }
    end += point.length
    bytes += size
  }
  ranges.push({ start, end })
  if (ranges.length > 10_000) throw new RangeError('Too many upload parts')
  return ranges
}

export async function sourceUploadPart(snapshot: SourceSnapshotV1, text: string, partBytes: number, index: number, ranges = sourcePartRanges(text, partBytes)): Promise<UploadSourcePartV1> {
  const range = ranges[index]
  if (!range) throw new RangeError('Invalid upload part index')
  const part = text.slice(range.start, range.end)
  return uploadSourcePartSchema.parse({ version: 1, sourceId: snapshot.sourceId, contentHash: snapshot.contentHash,
    partHash: await sha256Hex(part), partIndex: index, partCount: ranges.length, ...range, totalChars: text.length, text: part })
}
