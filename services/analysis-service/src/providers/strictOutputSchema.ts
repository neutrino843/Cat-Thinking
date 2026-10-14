type JsonSchema = Record<string, unknown>

// Strict providers require every object key in `required`. Encode optional keys as null.
export const strictOutputSchema = (schema: Readonly<JsonSchema>): JsonSchema => {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    const node = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
      const required = new Set(node.required as string[] | undefined)
      const properties = node.properties as JsonSchema
      for (const key of Object.keys(properties)) {
        if (!required.has(key)) properties[key] = { anyOf: [properties[key], { type: 'null' }] }
      }
      node.required = Object.keys(properties)
      node.additionalProperties = false
    }
    return node
  }
  return visit(schema) as JsonSchema
}

// Only omit null for schema-optional keys; required nullable fields (parentId) remain null.
export const normalizeOptionalNulls = (value: unknown, schema: Readonly<JsonSchema>): unknown => {
  const resolve = (node: JsonSchema): JsonSchema => {
    if (typeof node.$ref !== 'string') return node
    let resolved: unknown = schema
    for (const key of node.$ref.replace(/^#\//u, '').split('/')) {
      resolved = (resolved as JsonSchema)[key.replace(/~1/gu, '/').replace(/~0/gu, '~')]
    }
    return resolved as JsonSchema
  }
  const visit = (input: unknown, definition: JsonSchema): unknown => {
    const node = resolve(definition)
    const alternatives = (node.anyOf ?? node.oneOf) as JsonSchema[] | undefined
    if (alternatives && input && typeof input === 'object' && !Array.isArray(input)) {
      const chosen = alternatives.find((candidate) => {
        const properties = resolve(candidate).properties as Record<string, JsonSchema> | undefined
        return properties && Object.entries(properties).every(([key, prop]) => prop.const === undefined || (input as JsonSchema)[key] === prop.const)
      })
      if (chosen) return visit(input, chosen)
    }
    if (Array.isArray(input) && node.items) return input.map((item) => visit(item, node.items as JsonSchema))
    if (!input || typeof input !== 'object' || Array.isArray(input) || !node.properties) return input
    const properties = node.properties as Record<string, JsonSchema>
    const required = new Set(node.required as string[] | undefined)
    return Object.fromEntries(Object.entries(input).filter(([key, child]) => !(child === null && properties[key] && !required.has(key)))
      .map(([key, child]) => [key, properties[key] ? visit(child, properties[key]) : child]))
  }
  return visit(value, schema)
}
