import { identifierSchema } from '@cat-thinking/analysis-contracts'

export interface AnalysisBindingChange {
  version: 1
  docId: string
  type: 'binding' | 'artifact' | 'deleted'
  origin?: string
}

const listeners = new Map<string, Set<(change: AnalysisBindingChange) => void>>()
let channel: BroadcastChannel | undefined
const emit = (change: AnalysisBindingChange) => {
  for (const listener of listeners.get(change.docId) ?? []) {
    try { listener(change) } catch { /* Advisory notifications cannot roll back a committed transaction. */ }
  }
}
const decode = (value: unknown): AnalysisBindingChange | undefined => {
  if (!value || typeof value !== 'object') return
  const change = value as Partial<AnalysisBindingChange>
  const parsedId = identifierSchema.safeParse(change.docId)
  const type = change.type
  if (change.version !== 1 || !parsedId.success
    || type !== 'binding' && type !== 'artifact' && type !== 'deleted'
    || change.origin !== undefined && !identifierSchema.safeParse(change.origin).success) return
  return { version: 1, docId: parsedId.data, type, ...(change.origin ? { origin: change.origin } : {}) }
}
const openChannel = () => {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return
  try {
    const instance = new BroadcastChannel('cat-analysis-bindings-v1')
    instance.onmessage = (event: MessageEvent<unknown>) => { const change = decode(event.data); if (change) emit(change) }
    return instance
  } catch { return undefined }
}
const closeChannel = (instance?: BroadcastChannel) => { try { instance?.close() } catch { /* Best-effort cleanup. */ } }

/** Advisory metadata only. Consumers invalidate immediately, then reread IndexedDB. */
export function notifyAnalysisBinding(change: AnalysisBindingChange): void {
  emit(change)
  const sender = channel ?? openChannel()
  try { sender?.postMessage(change) } catch { /* Focus reconciliation also detects binding changes. */ }
  if (sender !== channel) closeChannel(sender)
}

export function subscribeAnalysisBinding(docId: string, listener: (change: AnalysisBindingChange) => void): () => void {
  const set = listeners.get(docId) ?? new Set()
  set.add(listener)
  listeners.set(docId, set)
  channel ??= openChannel()
  let active = true
  return () => {
    if (!active) return
    active = false
    set.delete(listener)
    if (!set.size) listeners.delete(docId)
    if (!listeners.size) { closeChannel(channel); channel = undefined }
  }
}
