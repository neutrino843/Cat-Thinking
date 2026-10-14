import type { ZodType } from 'zod'

export type StructuredOutputFailure = 'invalid_json' | 'schema_invalid' | 'too_large'

export class StructuredOutputDecodeError extends Error {
  constructor(
    readonly code: StructuredOutputFailure,
    readonly issueCount?: number,
  ) {
    super(`structured provider output rejected: ${code}`)
    this.name = 'StructuredOutputDecodeError'
  }
}

const validateJsonShape = (root: unknown): void => {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    nodes += 1
    if (nodes > 100_000 || current.depth > 64) throw new StructuredOutputDecodeError('schema_invalid')
    if (typeof current.value !== 'object' || current.value === null) continue
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 })
      continue
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (key === '__proto__' || key === 'prototype') throw new StructuredOutputDecodeError('schema_invalid')
      pending.push({ value, depth: current.depth + 1 })
    }
  }
}

export const decodeStructuredOutput = <Output>(
  outputText: string,
  schema: ZodType<Output>,
  maxBytes: number,
): Output => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive integer')
  if (new TextEncoder().encode(outputText).byteLength > maxBytes) {
    throw new StructuredOutputDecodeError('too_large')
  }
  let value: unknown
  try {
    value = JSON.parse(outputText)
  } catch {
    throw new StructuredOutputDecodeError('invalid_json')
  }
  validateJsonShape(value)
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new StructuredOutputDecodeError('schema_invalid', parsed.error.issues.length)
  return parsed.data
}
