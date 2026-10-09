export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

const normalize = (value: unknown, path: string): CanonicalJsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`)
    return Object.is(value, -0) ? 0 : value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${index}]`))
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Unsupported object at ${path}`)
    }

    const normalized: Record<string, CanonicalJsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new TypeError(`Undefined value at ${path}.${key}`)
      normalized[key] = normalize(item, `${path}.${key}`)
    }
    return normalized
  }

  throw new TypeError(`Unsupported value at ${path}`)
}

export const canonicalizeJson = (value: unknown): string => JSON.stringify(normalize(value, '$'))
