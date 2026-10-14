import { createHash } from 'node:crypto'
import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_LIMITS,
  evidenceChunkSchema,
  type EvidenceChunkV1,
  type SourceLocatorV1,
  type SourceSnapshotV1,
} from '@cat-thinking/analysis-contracts'

export const EVIDENCE_CHUNK_POLICY_VERSION = 'chunk-v1'

export interface ChunkSourceInput {
  readonly snapshot: SourceSnapshotV1
  readonly text: string
}

export interface ChunkPlannerPolicy {
  readonly version: string
  readonly targetCharacters: number
  readonly maxCharacters: number
  readonly overlapCharacters: number
  readonly minimumBoundaryRatio: number
}

export type TokenEstimator = (text: string) => number

export const defaultChunkPlannerPolicy: ChunkPlannerPolicy = Object.freeze({
  version: EVIDENCE_CHUNK_POLICY_VERSION,
  targetCharacters: 6_000,
  maxCharacters: 8_000,
  overlapCharacters: 300,
  minimumBoundaryRatio: 0.6,
})

export const conservativeTokenEstimate: TokenEstimator = (text) =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3))

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const safeBoundary = (text: string, offset: number, direction: -1 | 1): number => {
  let next = offset
  if (next <= 0 || next >= text.length) return Math.max(0, Math.min(text.length, next))
  const left = text.charCodeAt(next - 1)
  const right = text.charCodeAt(next)
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) next += direction
  return Math.max(0, Math.min(text.length, next))
}

const isBoundary = (text: string, offset: number, strength: 1 | 2 | 3): boolean => {
  const before = text[offset - 1] ?? ''
  const after = text[offset] ?? ''
  if (strength === 3) return before === '\n' && after === '\n'
  if (strength === 2) return before === '\n'
  return /[。！？!?；;.]|\s/u.test(before) || /\s/u.test(after)
}

const findChunkEnd = (
  text: string,
  start: number,
  selectedEnd: number,
  policy: ChunkPlannerPolicy,
): number => {
  const target = Math.min(selectedEnd, start + policy.targetCharacters)
  if (target >= selectedEnd) return selectedEnd
  const hardEnd = Math.min(selectedEnd, start + policy.maxCharacters)
  const minimum = Math.min(target, start + Math.max(1, Math.floor(policy.targetCharacters * policy.minimumBoundaryRatio)))

  for (const strength of [3, 2, 1] as const) {
    for (let offset = target; offset >= minimum; offset -= 1) {
      if (isBoundary(text, offset, strength)) return safeBoundary(text, offset, -1)
    }
    for (let offset = target + 1; offset <= hardEnd; offset += 1) {
      if (isBoundary(text, offset, strength)) return safeBoundary(text, offset, 1)
    }
  }
  return safeBoundary(text, hardEnd, -1)
}

const locatorOverlap = (locator: SourceLocatorV1, start: number, end: number): number =>
  Math.max(0, Math.min(locator.end, end) - Math.max(locator.start, start))

const chunkLocation = (
  locators: readonly SourceLocatorV1[],
  start: number,
  end: number,
): Pick<EvidenceChunkV1, 'titlePath' | 'pageStart' | 'pageEnd'> => {
  const overlapping = locators.filter((locator) => locatorOverlap(locator, start, end) > 0)
  const primary = [...overlapping].sort((left, right) =>
    locatorOverlap(right, start, end) - locatorOverlap(left, start, end)
    || right.start - left.start,
  )[0]
  const pages = overlapping.flatMap((locator) => locator.page === undefined ? [] : [locator.page])
  return {
    titlePath: primary?.titlePath ?? [],
    ...(pages.length === 0 ? {} : { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) }),
  }
}

const validatePolicy = (policy: ChunkPlannerPolicy): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(policy.version)) throw new TypeError('invalid chunk policy version')
  if (!Number.isInteger(policy.targetCharacters) || policy.targetCharacters < 100) {
    throw new RangeError('targetCharacters must be an integer of at least 100')
  }
  if (!Number.isInteger(policy.maxCharacters) || policy.maxCharacters < policy.targetCharacters) {
    throw new RangeError('maxCharacters must be an integer no smaller than targetCharacters')
  }
  if (
    !Number.isInteger(policy.overlapCharacters)
    || policy.overlapCharacters < 0
    || policy.overlapCharacters >= policy.targetCharacters
  ) throw new RangeError('overlapCharacters must be smaller than targetCharacters')
  if (policy.minimumBoundaryRatio <= 0 || policy.minimumBoundaryRatio > 1) {
    throw new RangeError('minimumBoundaryRatio must be within (0, 1]')
  }
}

export const planEvidenceChunks = (
  sources: readonly ChunkSourceInput[],
  policy: ChunkPlannerPolicy = defaultChunkPlannerPolicy,
  estimateTokens: TokenEstimator = conservativeTokenEstimate,
): EvidenceChunkV1[] => {
  validatePolicy(policy)
  const drafts: Omit<EvidenceChunkV1, 'ordinal' | 'total' | 'overlapAfter'>[] = []
  for (const { snapshot, text } of sources) {
    if (text.length !== snapshot.charCount) throw new RangeError(`source ${snapshot.sourceId} length differs from manifest`)
    const selectedStart = snapshot.selectedRange?.start ?? 0
    const selectedEnd = snapshot.selectedRange?.end ?? snapshot.charCount
    let start = selectedStart
    let previousEnd = selectedStart
    while (start < selectedEnd) {
      const end = findChunkEnd(text, start, selectedEnd, policy)
      if (end <= start) throw new Error('chunk planner did not advance')
      const chunkText = text.slice(start, end)
      const chunkHash = sha256(chunkText)
      const identityHash = sha256([
        policy.version,
        snapshot.sourceId,
        snapshot.contentHash,
        String(start),
        String(end),
        chunkHash,
      ].join(':'))
      drafts.push({
        version: ANALYSIS_CONTRACT_VERSION,
        chunkId: `chunk:${identityHash.slice(0, 40)}`,
        chunkHash,
        sourceId: snapshot.sourceId,
        start,
        end,
        ...chunkLocation(snapshot.locators ?? [], start, end),
        estimatedTokens: estimateTokens(chunkText),
        overlapBefore: Math.max(0, previousEnd - start),
      })
      if (end === selectedEnd) break
      previousEnd = end
      start = safeBoundary(text, Math.max(start + 1, end - policy.overlapCharacters), -1)
    }
  }
  if (drafts.length === 0) throw new RangeError('selected source range is empty')
  if (drafts.length > ANALYSIS_LIMITS.maxEvidenceChunks) {
    throw new RangeError(`evidence chunk count exceeds ${ANALYSIS_LIMITS.maxEvidenceChunks}`)
  }
  return drafts.map((draft, ordinal) => evidenceChunkSchema.parse({
    ...draft,
    ordinal,
    total: drafts.length,
    overlapAfter: ordinal + 1 < drafts.length && drafts[ordinal + 1]?.sourceId === draft.sourceId
      ? Math.max(0, draft.end - (drafts[ordinal + 1]?.start ?? draft.end))
      : 0,
  }))
}

export const hashChunkPlan = (chunks: readonly EvidenceChunkV1[]): string => sha256(JSON.stringify(
  chunks.map(({ chunkId, chunkHash, sourceId, start, end }) => ({ chunkId, chunkHash, sourceId, start, end })),
))
