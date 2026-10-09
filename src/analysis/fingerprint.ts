import {
  ANALYSIS_CONTRACT_VERSION,
  ARTIFACT_KINDS,
  canonicalizeJson,
  sourceRangeSchema,
  type AnalysisOptionsV1,
  type ArtifactKind,
  type SourceRangeV1,
  type SourceSnapshotV1,
} from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'

export type DigestFunction = (bytes: Uint8Array) => Promise<ArrayBuffer>

const defaultDigest: DigestFunction = async (bytes) => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return crypto.subtle.digest('SHA-256', buffer)
}

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (value: string, digest: DigestFunction = defaultDigest): Promise<string> => {
  const bytes = new TextEncoder().encode(value)
  return toHex(await digest(bytes))
}

const orderedArtifacts = (artifacts: readonly ArtifactKind[]): ArtifactKind[] => {
  const requested = new Set(artifacts)
  return ARTIFACT_KINDS.filter((kind) => requested.has(kind))
}

export const createSourceSnapshot = async (
  source: SourceDocument,
  selectedRange?: SourceRangeV1,
  digest: DigestFunction = defaultDigest,
): Promise<SourceSnapshotV1> => {
  const range = selectedRange === undefined ? undefined : sourceRangeSchema.parse(selectedRange)
  if (range && range.end > source.charCount) throw new RangeError('Selected source range exceeds source length')
  const pageCount = source.kind === 'pdf'
    ? Math.max(1, ...source.anchors.map((anchor) => anchor.page ?? 1))
    : undefined

  return {
    version: ANALYSIS_CONTRACT_VERSION,
    sourceId: source.id,
    kind: source.kind,
    extractor: source.extractor,
    contentHash: await sha256Hex(source.text, digest),
    charCount: source.charCount,
    byteCount: new TextEncoder().encode(source.text).byteLength,
    pageCount,
    selectedRange: range,
  }
}

export interface RequestKeyInput {
  docId: string
  sources: readonly SourceSnapshotV1[]
  artifacts: readonly ArtifactKind[]
  options: AnalysisOptionsV1
  engineCapabilityVersion: string
}

export const createAnalysisRequestKey = async (
  input: RequestKeyInput,
  digest: DigestFunction = defaultDigest,
): Promise<string> => {
  const canonical = canonicalizeJson({
    version: ANALYSIS_CONTRACT_VERSION,
    docId: input.docId,
    sources: [...input.sources]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        contentHash: source.contentHash,
        selectedRange: source.selectedRange ?? null,
        extractor: source.extractor,
      })),
    artifacts: orderedArtifacts(input.artifacts),
    options: input.options,
    engineCapabilityVersion: input.engineCapabilityVersion,
  })
  return sha256Hex(canonical, digest)
}
