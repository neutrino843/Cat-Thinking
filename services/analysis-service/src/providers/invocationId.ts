import { createHash } from 'node:crypto'
import type { ModelTaskRole } from './modelProvider.js'

export interface StableInvocationIdInput {
  readonly runId: string
  readonly nodeKey: string
  readonly runAttempt: number
  readonly role: ModelTaskRole
}

const field = (value: string): string => `${new TextEncoder().encode(value).byteLength}:${value}`

export const createStableInvocationId = (input: StableInvocationIdInput): string => {
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 0) {
    throw new RangeError('runAttempt must be a non-negative safe integer')
  }
  const digest = createHash('sha256')
    .update([
      'cat-thinking-provider-invocation-v1',
      field(input.runId),
      field(input.nodeKey),
      String(input.runAttempt),
      input.role,
    ].join('\n'), 'utf8')
    .digest('hex')
  return `inv-${digest}`
}
