import { randomUUID } from 'node:crypto'
import type { JobStore, ExpiredRunReference, LeaseIdentity } from './jobStore.js'
import { LeaseGuard } from './leaseGuard.js'

export interface DispatchWorker {
  runOnce(tenantId: string, runId: string, ownerId: string, signal: AbortSignal): Promise<unknown>
}

/** A version/profile mismatch needs a compatible consumer, not repeated acquisition by this one. */
const defersIncompatibleWork = (result: unknown): boolean => {
  if (result === null || typeof result !== 'object') return false
  const status = result as { outcome?: unknown; reason?: unknown }
  return status.outcome === 'stopped'
    && (status.reason === 'unsupported_execution_version' || status.reason === 'provider_profile_mismatch')
}
export interface PersistentDispatcherOptions {
  readonly store: JobStore
  readonly evidence: DispatchWorker
  readonly artifacts: DispatchWorker
  readonly cleanupExpired: () => Promise<unknown>
  readonly ownerId?: string
  readonly leaseMs: number
  readonly pollMs: number
  readonly maxRunMs: number
  readonly concurrency?: number
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
  readonly canDispatch?: () => Promise<boolean>
}

export class PersistentDispatcher {
  private readonly ownerId: string
  private readonly now: () => number
  private readonly concurrency: number
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private timer?: NodeJS.Timeout
  private polling?: Promise<void>
  private stopping = false
  private healthy = false

  constructor(private readonly options: PersistentDispatcherOptions) {
    for (const [name, value] of Object.entries({ leaseMs: options.leaseMs, pollMs: options.pollMs, maxRunMs: options.maxRunMs, concurrency: options.concurrency ?? 2 })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
    }
    this.ownerId = options.ownerId ?? randomUUID()
    this.now = options.now ?? Date.now
    this.concurrency = options.concurrency ?? 2
  }
  isReady(): boolean { return this.healthy && !this.stopping && this.timer !== undefined }
  async start(): Promise<void> {
    if (this.timer) return
    if (this.stopping) throw new Error('dispatcher has stopped')
    this.healthy = await this.options.store.checkHealth()
    if (!this.healthy) throw new Error('dispatcher store is unavailable')
    this.timer = setInterval(() => {
      if (!this.polling) {
        this.polling = this.tick().catch((error: unknown) => {
          this.healthy = false
          this.options.onError?.(error)
        }).finally(() => { this.polling = undefined })
      }
    }, this.options.pollMs)
    this.timer.unref()
    // Discover work immediately; do not wait for long-running jobs during startup.
    this.polling = this.tick().catch((error: unknown) => {
      this.healthy = false
      this.options.onError?.(error)
    }).finally(() => { this.polling = undefined })
  }
  async tick(): Promise<void> {
    if (this.stopping) return
    if (!await this.options.store.checkHealth() || !await this.canDispatch()) {
      this.healthy = false
      for (const task of this.active.values()) task.controller.abort(new Error('release_gate_closed'))
      return
    }
    this.healthy = true
    await this.options.cleanupExpired()
    if (this.stopping) return
    const available = this.concurrency - this.active.size
    if (available <= 0) return
    const refs = await this.options.store.listDispatchableRuns(this.now(), available)
    for (const ref of refs) {
      if (this.stopping || this.active.size >= this.concurrency) break
      const key = `${ref.tenantId}\u0000${ref.runId}`
      if (this.active.has(key)) continue
      const controller = new AbortController()
      const promise = this.dispatch(ref, controller).finally(() => { this.active.delete(key) })
      this.active.set(key, { controller, promise })
    }
    await Promise.all([...this.active.values()].map((task) => task.promise))
    this.healthy = await this.options.store.checkHealth()
  }
  async stop(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('stop timeout must be positive')
    this.stopping = true
    this.healthy = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const task of this.active.values()) task.controller.abort(new Error('dispatcher_shutdown'))
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        (async () => {
          await this.polling?.catch(() => undefined)
          await Promise.allSettled([...this.active.values()].map((task) => task.promise))
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('dispatcher_shutdown_timeout')), timeoutMs) }),
      ])
    } finally { if (timeout) clearTimeout(timeout) }
  }

  private async dispatch(ref: ExpiredRunReference, controller: AbortController): Promise<void> {
    const lease = await this.options.store.acquireLease({ ...ref, ownerId: this.ownerId, nodeKey: 'dispatcher:run', now: this.now(), durationMs: this.options.leaseMs })
    if (!lease) return
    const identity: LeaseIdentity = { ...ref, ...lease }
    const guard = new LeaseGuard({ store: this.options.store, identity, leaseMs: this.options.leaseMs, parentSignal: controller.signal, now: this.now })
    const startedAt = this.now()
    let checking = false
    const watchdog = setInterval(() => {
      if (checking) return
      checking = true
      void (async () => {
        if (!await this.options.store.checkHealth() || !await this.canDispatch()) { this.healthy = false; controller.abort(new Error('execution_not_ready')); return }
        const run = await this.options.store.getRun(ref.tenantId, ref.runId)
        if (!run || (run.expiresAt ?? Infinity) <= this.now() || this.now() - startedAt >= this.options.maxRunMs
          || ['cancelled', 'expired', 'failed', 'partial', 'succeeded'].includes(run.status)) controller.abort(new Error('dispatcher_run_stopped'))
      })().catch(() => controller.abort(new Error('dispatcher_store_unavailable'))).finally(() => { checking = false })
    }, Math.max(1, Math.min(this.options.pollMs, Math.floor(this.options.leaseMs / 3))))
    watchdog.unref()
    guard.start()
    let deferUntilLeaseExpires = false
    try {
      await guard.ensure()
      if (!await this.canDispatch()) return
      let run = await this.options.store.getRun(ref.tenantId, ref.runId)
      if (!run || (run.expiresAt ?? Infinity) <= this.now()) return
      if (run.status !== 'generating') {
        const result = await this.options.evidence.runOnce(ref.tenantId, ref.runId, this.ownerId, guard.signal)
        if (!guard.signal.aborted && defersIncompatibleWork(result)) { deferUntilLeaseExpires = true; return }
      }
      run = await this.options.store.getRun(ref.tenantId, ref.runId)
      if (!guard.signal.aborted && run?.status === 'generating') {
        await guard.ensure()
        if (!await this.canDispatch()) return
        const result = await this.options.artifacts.runOnce(ref.tenantId, ref.runId, this.ownerId, guard.signal)
        if (!guard.signal.aborted && defersIncompatibleWork(result)) deferUntilLeaseExpires = true
      }
    } catch (error) {
      if (!guard.signal.aborted) throw error
    } finally {
      clearInterval(watchdog)
      await guard.stop()
      // Discovery excludes active dispatcher leases. Stop renewing this one and
      // retain its existing, bounded expiry so newer work gets a turn. Its source,
      // run state and usage ledger remain available to a compatible instance.
      if (!deferUntilLeaseExpires || guard.signal.aborted || this.stopping) await this.options.store.releaseLease(identity)
    }
  }
  private async canDispatch(): Promise<boolean> {
    try { return this.options.canDispatch ? await this.options.canDispatch() : true } catch { return false }
  }
}
