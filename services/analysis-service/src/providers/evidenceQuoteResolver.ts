import {
  ANALYSIS_CONTRACT_VERSION,
  type EvidenceCardV1,
  type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'
import type { EvidenceMapInput } from '../domain/evidenceGenerator.js'
import { validateEvidenceCard } from '../domain/evidenceValidator.js'
import type { EvidenceQuoteModelOutput } from './evidenceMapPrompt.js'

export class EvidenceQuoteResolutionError extends Error {
  constructor(readonly code: 'quote_not_found' | 'quote_ambiguous') {
    super(`evidence quotation rejected: ${code}`)
    this.name = 'EvidenceQuoteResolutionError'
  }
}

type QuoteCitation = EvidenceQuoteModelOutput['claims'][number]['citations'][number]

/** Locate only exact occurrences in this immutable chunk, including overlaps. */
export const resolveEvidenceQuote = (input: EvidenceMapInput, citation: QuoteCitation): SourceCitationV1 => {
  let match: number | undefined
  let cursor = 0
  while (cursor <= input.text.length - citation.quote.length) {
    const start = input.text.indexOf(citation.quote, cursor)
    if (start < 0) break
    const end = start + citation.quote.length
    cursor = start + 1
    if (start < citation.prefix.length || end + citation.suffix.length > input.text.length
      || input.text.slice(start - citation.prefix.length, start) !== citation.prefix
      || input.text.slice(end, end + citation.suffix.length) !== citation.suffix) continue
    if (match !== undefined) throw new EvidenceQuoteResolutionError('quote_ambiguous')
    match = start
  }
  if (match === undefined) throw new EvidenceQuoteResolutionError('quote_not_found')
  return {
    version: ANALYSIS_CONTRACT_VERSION,
    provenance: 'source',
    sourceId: input.chunk.sourceId,
    start: input.chunk.start + match,
    end: input.chunk.start + match + citation.quote.length,
    quote: citation.quote,
  }
}

/** Reuse the domain validator against the actual chunk text, without synthetic padding. */
export const validateEvidenceCardForChunk = (input: EvidenceMapInput, card: EvidenceCardV1): EvidenceCardV1 => {
  const localCitation = (citation: SourceCitationV1): SourceCitationV1 => ({
    ...citation, start: citation.start - input.chunk.start, end: citation.end - input.chunk.start,
  })
  validateEvidenceCard({
    card: {
      ...card,
      claims: card.claims.map((claim) => ({ ...claim, citations: claim.citations.map(localCitation) })),
      terms: card.terms.map((term) => ({ ...term, citations: term.citations.map(localCitation) })),
    },
    chunk: { ...input.chunk, start: 0, end: input.text.length },
    snapshot: {
      version: ANALYSIS_CONTRACT_VERSION, sourceId: input.chunk.sourceId, kind: 'text',
      extractor: 'chunk-validation-v1', contentHash: input.chunk.chunkHash,
      charCount: input.text.length, byteCount: new TextEncoder().encode(input.text).byteLength,
    },
    sourceText: input.text,
  })
  return card
}
