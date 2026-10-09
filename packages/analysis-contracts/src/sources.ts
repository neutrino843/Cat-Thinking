import { z } from 'zod'
import { ANALYSIS_CONTRACT_VERSION, ANALYSIS_LIMITS } from './constants'
import { byteCountSchema, identifierSchema, sha256Schema, uniqueValues } from './common'

export const sourceKindSchema = z.enum(['text', 'markdown', 'pdf', 'docx'])

export const sourceRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end > range.start, {
    message: 'end must be greater than start',
    path: ['end'],
  })

export const sourceSnapshotSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    sourceId: identifierSchema,
    kind: sourceKindSchema,
    extractor: z.string().trim().min(1).max(120),
    contentHash: sha256Schema,
    charCount: z.number().int().nonnegative().max(ANALYSIS_LIMITS.maxSourceCharacters),
    byteCount: byteCountSchema,
    pageCount: z.number().int().positive().max(100_000).optional(),
    selectedRange: sourceRangeSchema.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.selectedRange && source.selectedRange.end > source.charCount) {
      context.addIssue({
        code: 'custom',
        message: 'selected range exceeds source length',
        path: ['selectedRange', 'end'],
      })
    }
    if (source.kind === 'pdf' && source.pageCount === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'PDF sources require pageCount',
        path: ['pageCount'],
      })
    }
  })

export const sourceManifestSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    sources: z.array(sourceSnapshotSchema).min(1).max(ANALYSIS_LIMITS.maxSourcesPerRun),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.sources.map((source) => source.sourceId)
    if (!uniqueValues(ids)) {
      context.addIssue({
        code: 'custom',
        message: 'source ids must be unique',
        path: ['sources'],
      })
    }
  })

export const uploadSourcePartSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    sourceId: identifierSchema,
    contentHash: sha256Schema,
    partHash: sha256Schema,
    partIndex: z.number().int().nonnegative(),
    partCount: z.number().int().positive().max(10_000),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    totalChars: z.number().int().nonnegative().max(ANALYSIS_LIMITS.maxSourceCharacters),
    text: z.string().max(ANALYSIS_LIMITS.maxUploadPartBytes),
  })
  .strict()
  .superRefine((part, context) => {
    if (part.partIndex >= part.partCount) {
      context.addIssue({ code: 'custom', message: 'partIndex exceeds partCount', path: ['partIndex'] })
    }
    if (part.end < part.start || part.end > part.totalChars) {
      context.addIssue({ code: 'custom', message: 'invalid part range', path: ['end'] })
    }
    if (part.text.length !== part.end - part.start) {
      context.addIssue({ code: 'custom', message: 'text length does not match part range', path: ['text'] })
    }
    if (new TextEncoder().encode(part.text).byteLength > ANALYSIS_LIMITS.maxUploadPartBytes) {
      context.addIssue({ code: 'too_big', maximum: ANALYSIS_LIMITS.maxUploadPartBytes, origin: 'string', path: ['text'] })
    }
  })

export const sourceReceiptSchema = z
  .object({
    version: z.literal(ANALYSIS_CONTRACT_VERSION),
    sourceId: identifierSchema,
    receivedParts: z.number().int().nonnegative(),
    partCount: z.number().int().positive(),
    complete: z.boolean(),
    computedHash: sha256Schema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.receivedParts > receipt.partCount) {
      context.addIssue({ code: 'custom', message: 'receivedParts exceeds partCount', path: ['receivedParts'] })
    }
    if (receipt.complete && receipt.computedHash === undefined) {
      context.addIssue({ code: 'custom', message: 'complete receipt requires computedHash', path: ['computedHash'] })
    }
  })

export type SourceKind = z.infer<typeof sourceKindSchema>
export type SourceRangeV1 = z.infer<typeof sourceRangeSchema>
export type SourceSnapshotV1 = z.infer<typeof sourceSnapshotSchema>
export type SourceManifestV1 = z.infer<typeof sourceManifestSchema>
export type UploadSourcePartV1 = z.infer<typeof uploadSourcePartSchema>
export type SourceReceiptV1 = z.infer<typeof sourceReceiptSchema>
