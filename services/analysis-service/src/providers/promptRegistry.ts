import type { ModelTaskRole } from './modelProvider.js'

const PROMPT_ID_PATTERN = /^[a-z][a-z0-9.-]{0,79}$/u
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u

export interface PromptDefinition<Variables = Readonly<Record<string, unknown>>> {
  readonly id: string
  readonly version: string
  readonly role: ModelTaskRole
  readonly system: string
  render(variables: Variables): string
}

export interface PromptMetadata {
  readonly id: string
  readonly version: string
  readonly role: ModelTaskRole
}

const keyFor = (id: string, version: string): string => `${id}\u0000${version}`

const validateDefinition = (definition: PromptDefinition<unknown>): void => {
  if (!PROMPT_ID_PATTERN.test(definition.id)) throw new TypeError('prompt id is invalid')
  if (!VERSION_PATTERN.test(definition.version)) throw new TypeError('prompt version is invalid')
  if (definition.system.trim().length === 0) throw new TypeError('prompt system instruction is empty')
  if (definition.system.length > 100_000) throw new RangeError('prompt system instruction is too large')
}

export class PromptRegistry {
  private readonly definitions = new Map<string, PromptDefinition<unknown>>()

  constructor(definitions: readonly PromptDefinition<unknown>[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register<Variables>(definition: PromptDefinition<Variables>): void {
    const genericDefinition = definition as PromptDefinition<unknown>
    validateDefinition(genericDefinition)
    const key = keyFor(definition.id, definition.version)
    if (this.definitions.has(key)) throw new TypeError(`duplicate prompt definition: ${definition.id}@${definition.version}`)
    this.definitions.set(key, Object.freeze({ ...genericDefinition }))
  }

  resolve<Variables>(id: string, version: string, expectedRole: ModelTaskRole): PromptDefinition<Variables> {
    const definition = this.definitions.get(keyFor(id, version))
    if (!definition) throw new PromptRegistryError('not_found', id, version)
    if (definition.role !== expectedRole) throw new PromptRegistryError('role_mismatch', id, version)
    return definition as PromptDefinition<Variables>
  }

  list(): readonly PromptMetadata[] {
    return [...this.definitions.values()]
      .map(({ id, version, role }) => Object.freeze({ id, version, role }))
      .sort((left, right) => keyFor(left.id, left.version).localeCompare(keyFor(right.id, right.version)))
  }
}

export class PromptRegistryError extends Error {
  constructor(
    readonly code: 'not_found' | 'role_mismatch',
    readonly promptId: string,
    readonly promptVersion: string,
  ) {
    super(`prompt registry lookup failed: ${code}`)
    this.name = 'PromptRegistryError'
  }
}
