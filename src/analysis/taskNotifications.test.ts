import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisBindingChange } from './taskNotifications'

class TestBroadcastChannel {
  static instances: TestBroadcastChannel[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  postMessage = vi.fn()
  close = vi.fn()
  constructor(readonly name: string) { TestBroadcastChannel.instances.push(this) }
  receive(data: unknown) { this.onmessage?.({ data } as MessageEvent<unknown>) }
}
const changes = (docId = 'doc-1'): AnalysisBindingChange => ({ version: 1, docId, type: 'binding', origin: 'tab-1' })
const subscriptions: (() => void)[] = []
beforeEach(() => {
  vi.resetModules()
  TestBroadcastChannel.instances = []
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel)
})
afterEach(() => { subscriptions.splice(0).forEach((unsubscribe) => unsubscribe()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('analysis binding notifications', () => {
  it('scopes local and remote notifications by document and strips non-metadata payloads', async () => {
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const first = vi.fn(); const second = vi.fn()
    subscriptions.push(subscribeAnalysisBinding('doc-1', first), subscribeAnalysisBinding('doc-2', second))
    expect(TestBroadcastChannel.instances).toHaveLength(1)
    const channel = TestBroadcastChannel.instances[0]!
    expect(channel.name).toBe('cat-analysis-bindings-v1')
    notifyAnalysisBinding(changes())
    expect(first).toHaveBeenCalledExactlyOnceWith(changes())
    expect(second).not.toHaveBeenCalled()
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith(changes())
    channel.receive({ version: 1, docId: 'doc-2', type: 'deleted', payload: 'untrusted output', authorization: 'untrusted token' })
    expect(second).toHaveBeenCalledExactlyOnceWith({ version: 1, docId: 'doc-2', type: 'deleted' })
    expect(first).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed remote metadata without notifying any subscriber', async () => {
    const { subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn(); subscriptions.push(subscribeAnalysisBinding('doc-1', listener))
    const channel = TestBroadcastChannel.instances[0]!
    for (const value of [null, '', 1, {}, { ...changes(), version: 2 }, { ...changes(), docId: '../bad' },
      { ...changes(), type: 'payload' }, { ...changes(), origin: '' }, { ...changes(), origin: '../bad' }]) channel.receive(value)
    expect(listener).not.toHaveBeenCalled()
    channel.receive({ version: 1, docId: 'doc-1', type: 'artifact' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ version: 1, docId: 'doc-1', type: 'artifact' })
  })
  it('shares one channel until the final subscription closes and permits reopening', async () => {
    const { subscribeAnalysisBinding } = await import('./taskNotifications')
    const first = subscribeAnalysisBinding('doc-1', vi.fn())
    const second = subscribeAnalysisBinding('doc-1', vi.fn())
    const third = subscribeAnalysisBinding('doc-2', vi.fn())
    subscriptions.push(first, second, third)
    const channel = TestBroadcastChannel.instances[0]!
    first(); second(); expect(channel.close).not.toHaveBeenCalled()
    third(); expect(channel.close).toHaveBeenCalledTimes(1)
    subscriptions.length = 0
    subscriptions.push(subscribeAnalysisBinding('doc-1', vi.fn()))
    expect(TestBroadcastChannel.instances).toHaveLength(2)
  })
  it('makes unsubscribe idempotent without removing a newer subscription for the same document', async () => {
    const { subscribeAnalysisBinding, notifyAnalysisBinding } = await import('./taskNotifications')
    const first = subscribeAnalysisBinding('doc-1', vi.fn()); first()
    const listener = vi.fn(); subscriptions.push(subscribeAnalysisBinding('doc-1', listener))
    const activeChannel = TestBroadcastChannel.instances[1]!
    first(); notifyAnalysisBinding(changes())
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
    expect(activeChannel.close).not.toHaveBeenCalled()
  })
  it('opens and closes a temporary sender when there are no local subscribers', async () => {
    const { notifyAnalysisBinding } = await import('./taskNotifications')
    notifyAnalysisBinding(changes())
    const channel = TestBroadcastChannel.instances[0]!
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith(changes())
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
  it('continues same-tab delivery when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn(); subscriptions.push(subscribeAnalysisBinding('doc-1', listener))
    notifyAnalysisBinding(changes())
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
    expect(TestBroadcastChannel.instances).toHaveLength(0)
  })
  it('supports a non-browser caller without attempting to create a browser channel', async () => {
    vi.stubGlobal('window', undefined)
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn(); subscriptions.push(subscribeAnalysisBinding('doc-1', listener))
    notifyAnalysisBinding(changes())
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
    expect(TestBroadcastChannel.instances).toHaveLength(0)
  })
  it('falls back to same-tab notifications if browser policy rejects channel construction', async () => {
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new DOMException('Synthetic blocked channel', 'SecurityError') } })
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn()
    expect(() => subscriptions.push(subscribeAnalysisBinding('doc-1', listener))).not.toThrow()
    expect(() => notifyAnalysisBinding(changes())).not.toThrow()
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
  })
  it('does not convert a committed local change into a failure when posting or closing throws', async () => {
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn(); const unsubscribe = subscribeAnalysisBinding('doc-1', listener)
    subscriptions.push(unsubscribe)
    const channel = TestBroadcastChannel.instances[0]!
    channel.postMessage.mockImplementation(() => { throw new DOMException('Synthetic closed sender', 'InvalidStateError') })
    channel.close.mockImplementation(() => { throw new Error('Synthetic close failure') })
    expect(() => notifyAnalysisBinding(changes())).not.toThrow()
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
    expect(() => unsubscribe()).not.toThrow()
  })
  it('isolates a subscriber failure from other subscribers and cross-tab delivery', async () => {
    const { notifyAnalysisBinding, subscribeAnalysisBinding } = await import('./taskNotifications')
    const listener = vi.fn()
    subscriptions.push(subscribeAnalysisBinding('doc-1', () => { throw new Error('Synthetic listener failure') }),
      subscribeAnalysisBinding('doc-1', listener))
    expect(() => notifyAnalysisBinding(changes())).not.toThrow()
    expect(listener).toHaveBeenCalledExactlyOnceWith(changes())
    expect(TestBroadcastChannel.instances[0]!.postMessage).toHaveBeenCalledExactlyOnceWith(changes())
  })
})
