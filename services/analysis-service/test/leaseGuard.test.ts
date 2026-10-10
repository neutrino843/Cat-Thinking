import { describe, expect, it, vi } from 'vitest'
import type { JobStore, LeaseIdentity } from '../src/domain/jobStore.js'
import { LeaseGuard, LeaseGuardLostError } from '../src/domain/leaseGuard.js'

const identity: LeaseIdentity = {
  tenantId: 'tenant-lease',
  runId: 'run-lease',
  nodeKey: 'node-lease',
  ownerId: 'worker-lease',
  attempt: 1,
}

const storeWithRenewal = (
  renewal: JobStore['renewLease'],
): JobStore => ({ renewLease: renewal } as unknown as JobStore)

describe('lease guard', () => {
  it('validates heartbeat configuration and renews an owned lease', async () => {
    const renewLease = vi.fn<JobStore['renewLease']>().mockResolvedValue({ ...identity, expiresAt: 3_000 })
    const store = storeWithRenewal(renewLease)
    const parent = new AbortController()

    expect(() => new LeaseGuard({ store, identity, leaseMs: 0, parentSignal: parent.signal })).toThrow(RangeError)
    expect(() => new LeaseGuard({
      store,
      identity,
      leaseMs: 1_000,
      heartbeatMs: 1_000,
      parentSignal: parent.signal,
    })).toThrow(RangeError)

    const guard = new LeaseGuard({
      store,
      identity,
      leaseMs: 1_000,
      parentSignal: parent.signal,
      now: () => 1_500,
    })
    await guard.ensure()

    expect(renewLease).toHaveBeenCalledWith(identity, 1_500, 1_000)
    expect(guard.signal.aborted).toBe(false)
    await guard.stop()
  })

  it('aborts work when lease renewal fails', async () => {
    const guard = new LeaseGuard({
      store: storeWithRenewal(vi.fn<JobStore['renewLease']>().mockResolvedValue(undefined)),
      identity,
      leaseMs: 1_000,
      parentSignal: new AbortController().signal,
    })

    await expect(guard.ensure()).rejects.toBeInstanceOf(LeaseGuardLostError)
    expect(guard.signal.aborted).toBe(true)
    expect(guard.signal.reason).toBeInstanceOf(LeaseGuardLostError)

    const rejected = new LeaseGuard({
      store: storeWithRenewal(vi.fn<JobStore['renewLease']>().mockRejectedValue(new Error('database unavailable'))),
      identity,
      leaseMs: 1_000,
      parentSignal: new AbortController().signal,
    })
    await expect(rejected.ensure()).rejects.toBeInstanceOf(LeaseGuardLostError)
    expect(rejected.signal.aborted).toBe(true)
  })

  it('propagates parent cancellation and performs periodic renewal', async () => {
    vi.useFakeTimers()
    try {
      const renewLease = vi.fn<JobStore['renewLease']>().mockResolvedValue({ ...identity, expiresAt: 3_000 })
      const parent = new AbortController()
      const reason = new Error('service shutdown')
      const guard = new LeaseGuard({
        store: storeWithRenewal(renewLease),
        identity,
        leaseMs: 900,
        heartbeatMs: 300,
        parentSignal: parent.signal,
        now: () => 1_500,
      })
      guard.start()
      await vi.advanceTimersByTimeAsync(300)
      expect(renewLease).toHaveBeenCalledTimes(1)

      parent.abort(reason)
      expect(guard.signal.aborted).toBe(true)
      expect(guard.signal.reason).toBe(reason)
      await guard.stop()
      await guard.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
