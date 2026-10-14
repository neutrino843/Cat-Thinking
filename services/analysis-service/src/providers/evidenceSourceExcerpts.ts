import { ANALYSIS_CONTRACT_VERSION, type SourceCitationV1 } from '@cat-thinking/analysis-contracts'
import type { EvidenceMapInput } from '../domain/evidenceGenerator.js'

/** Matches the default planner's hard chunk limit; never omit excess source text. */
export const MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS = 8_000
export const MAX_EVIDENCE_EXCERPTS = 64
const MAX_NATURAL_EXCERPT_CHARACTERS = 800
export const MAX_EVIDENCE_EXCERPT_CHARACTERS = 2_000

export interface EvidenceSourceExcerpt {
  readonly excerptId: string
  readonly start: number
  readonly end: number
  readonly text: string
}

export class EvidenceExcerptResolutionError extends Error {
  constructor(readonly code: 'excerpt_not_found' | 'excerpt_capacity_exceeded') {
    super(`evidence source excerpt rejected: ${code}`)
    this.name = 'EvidenceExcerptResolutionError'
  }
}

const safeEnd = (text: string, start: number, proposed: number): number => {
  let end = proposed
  if (end < text.length) {
    const left = text.charCodeAt(end - 1)
    const right = text.charCodeAt(end)
    if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
      || text[end - 1] === '\r' && text[end] === '\n') end -= 1
  }
  if (end <= start) throw new EvidenceExcerptResolutionError('excerpt_capacity_exceeded')
  return end
}

/** Partition the complete immutable chunk; boundaries organize text without rewriting it. */
export const createEvidenceSourceExcerpts = (input: EvidenceMapInput): readonly EvidenceSourceExcerpt[] => {
  if (input.text.length !== input.chunk.end - input.chunk.start) throw new RangeError('evidence chunk text length differs from its range')
  if (input.text.length === 0 || input.text.length > MAX_EVIDENCE_EXCERPT_SOURCE_CHARACTERS) {
    throw new EvidenceExcerptResolutionError('excerpt_capacity_exceeded')
  }
  const ranges: { start: number; end: number }[] = []
  let start = 0
  while (start < input.text.length) {
    const hardEnd = safeEnd(input.text, start, Math.min(input.text.length, start + MAX_NATURAL_EXCERPT_CHARACTERS))
    let end = hardEnd
    for (let cursor = start; cursor < hardEnd; cursor += 1) {
      const character = input.text[cursor]
      if (character === '\n' || character === '\r' || /[。！？!?；;]/u.test(character ?? '')
        || character === '.' && (cursor + 1 === input.text.length || /\s/u.test(input.text[cursor + 1] ?? ''))) {
        end = character === '\r' && input.text[cursor + 1] === '\n' ? cursor + 2 : cursor + 1
        break
      }
    }
    ranges.push({ start, end })
    start = end
  }
  // Very densely punctuated input is still complete. Merge adjacent ranges only
  // when necessary to meet the bounded prompt capacity, retaining every byte.
  const bounded = ranges.length <= MAX_EVIDENCE_EXCERPTS ? ranges : ranges.reduce<typeof ranges>((groups, range) => {
    const last = groups.at(-1)
    if (last && range.end - last.start <= MAX_EVIDENCE_EXCERPT_CHARACTERS) last.end = range.end
    else groups.push({ ...range })
    return groups
  }, [])
  if (bounded.length > MAX_EVIDENCE_EXCERPTS) throw new EvidenceExcerptResolutionError('excerpt_capacity_exceeded')
  return bounded.map((range, index) => Object.freeze({ excerptId: `excerpt-${index + 1}`,
    start: input.chunk.start + range.start, end: input.chunk.start + range.end,
    text: input.text.slice(range.start, range.end) }))
}

/** Accept only IDs supplied in this invocation; never search or approximate source text. */
export const resolveEvidenceSourceExcerpt = (input: EvidenceMapInput, excerpts: readonly EvidenceSourceExcerpt[],
  citation: Readonly<{ excerptId: string }>): SourceCitationV1 => {
  const excerpt = excerpts.find((item) => item.excerptId === citation.excerptId)
  if (!excerpt) throw new EvidenceExcerptResolutionError('excerpt_not_found')
  return { version: ANALYSIS_CONTRACT_VERSION, provenance: 'source', sourceId: input.chunk.sourceId,
    start: excerpt.start, end: excerpt.end, quote: excerpt.text }
}
