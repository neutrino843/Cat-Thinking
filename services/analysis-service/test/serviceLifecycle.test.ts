import { describe, expect, it, vi } from 'vitest'
import { createServiceLifecycle } from '../src/serviceLifecycle.js'

describe('service startup and shutdown coordination', () => {
  it('waits for initialization before closing and never starts workers after shutdown was requested', async () => {
    let finish: () => void = () => {}
    const initialized = new Promise<void>((resolve) => { finish = resolve })
    const worker = vi.fn()
    const stop = vi.fn(async () => {})
    const onStopRequested = vi.fn()
    const lifecycle = createServiceLifecycle({ start: async (stopping) => {
      await initialized
      if (!stopping()) worker()
    }, stop, onStopRequested })
    const startup = lifecycle.start()
    await Promise.resolve()
    const shutdown = lifecycle.shutdown('parent-ipc')
    expect(lifecycle.shutdown('SIGTERM')).toBe(shutdown)
    await Promise.resolve()
    expect(stop).not.toHaveBeenCalled()
    finish()
    await Promise.all([startup, shutdown])
    expect(worker).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(onStopRequested).toHaveBeenCalledTimes(1)
  })
  it('shares startup-failure and parent shutdown cleanup', async () => {
    const stop = vi.fn(async () => {})
    const lifecycle = createServiceLifecycle({ start: async () => { throw new Error('synthetic-startup-failure') }, stop, onStopRequested: vi.fn() })
    const failed = lifecycle.start()
    const observed = expect(failed).rejects.toThrow('synthetic-startup-failure')
    await Promise.resolve()
    const shutdown = lifecycle.shutdown('parent-ipc')
    await observed
    await lifecycle.shutdown('startup-failure')
    await shutdown
    expect(stop).toHaveBeenCalledTimes(1)
  })
  it('does not initialize after shutdown and shares a failed cleanup promise without retrying resources', async () => {
    const start = vi.fn(async () => {})
    const stop = vi.fn(async () => { throw new Error('synthetic-cleanup-failure') })
    const lifecycle = createServiceLifecycle({ start, stop, onStopRequested: vi.fn() })
    const shutdown = lifecycle.shutdown('SIGINT')
    await expect(shutdown).rejects.toThrow('synthetic-cleanup-failure')
    expect(lifecycle.shutdown('SIGTERM')).toBe(shutdown)
    await lifecycle.start()
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
