import { z } from 'zod'
import { ANALYSIS_LIMITS } from './constants.js'

export const identifierSchema = z
  .string()
  .min(1)
  .max(ANALYSIS_LIMITS.maxIdentifierLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'invalid identifier')

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'expected lowercase SHA-256 hex')

export const timestampSchema = z.number().int().nonnegative().finite()

export const boundedTextSchema = z.string().trim().min(1).max(ANALYSIS_LIMITS.maxTextField)

export const unitIntervalSchema = z.number().finite().min(0).max(1)

export const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const uniqueValues = <T>(values: readonly T[]): boolean => new Set(values).size === values.length

export type JsonPrimitive = string | number | boolean | null

export const jsonPrimitiveSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
