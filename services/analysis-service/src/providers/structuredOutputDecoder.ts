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

/** 语法级容错候选：仅在严格解析失败后依次尝试。字符串内容保持原样，不触碰语义。 */
const removeTrailingCommas = (text: string): string => {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      out += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      out += character
      continue
    }
    if (character === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += character
  }
  return out
}

const unwrapMarkdownFence = (text: string): string | undefined => {
  if (!text.startsWith('```') || !text.endsWith('```')) return undefined
  const firstBreak = text.indexOf('\n')
  if (firstBreak === -1) return undefined
  const inner = text.slice(firstBreak + 1, text.length - 3).trim()
  return inner || undefined
}

const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } }
}

/**
 * 结构化输出的语法级容错（对应迭代计划 C1-a「校验容错」）：
 * 严格 JSON.parse 失败后，仅尝试剥离 BOM / Markdown 代码围栏 / 尾逗号这三类
 * 纯语法包装，再走完整的形状与 schema 校验。不放宽字节上限，不做语义改写。
 */
const parseStructuredJson = (outputText: string): unknown => {
  const direct = tryParse(outputText)
  if (direct.ok) return direct.value
  let text = outputText.trim()
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1).trim()
  const candidates = [text]
  const unwrapped = unwrapMarkdownFence(text)
  if (unwrapped) candidates.push(unwrapped, removeTrailingCommas(unwrapped))
  candidates.push(removeTrailingCommas(text))
  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (parsed.ok) return parsed.value
  }
  throw new StructuredOutputDecodeError('invalid_json')
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
  const value = parseStructuredJson(outputText)
  validateJsonShape(value)
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new StructuredOutputDecodeError('schema_invalid', parsed.error.issues.length)
  return parsed.data
}
