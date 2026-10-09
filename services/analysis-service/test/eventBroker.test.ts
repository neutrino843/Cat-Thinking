import { describe, expect, it, vi } from 'vitest'
import { RunEventBroker } from '../src/domain/eventBroker.js'

describe('run event broker', () => {
  it('wakes every waiter on publish and advances the observed version', async () => {
    const broker = new RunEventBroker()
    const observed = broker.version('run-1')
    const first = broker.wait('run-1', observed, 60_000)
    const second = broker.wait('run-1', observed, 60_000)

    broker.publish('run-1')
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(broker.version('run-1')).toBe(1)
  })

  it('resolves on timeout and removes an aborted waiter', async () => {
    vi.useFakeTimers()
    try {
      const broker = new RunEventBroker()
      const timed = broker.wait('run-timeout', 0, 50)
      await vi.advanceTimersByTimeAsync(50)
      await expect(timed).resolves.toBeUndefined()

      const controller = new AbortController()
      const aborted = broker.wait('run-abort', 0, 50, controller.signal)
      controller.abort()
      await expect(aborted).resolves.toBeUndefined()
      broker.publish('run-abort')
      expect(broker.version('run-abort')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns immediately for changed versions and already-aborted signals', async () => {
    const broker = new RunEventBroker()
    broker.publish('run-1')
    await expect(broker.wait('run-1', 0, 60_000)).resolves.toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    await expect(broker.wait('run-2', 0, 60_000, controller.signal)).resolves.toBeUndefined()
  })
})
