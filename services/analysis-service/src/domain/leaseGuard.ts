import type { JobLease, JobStore, LeaseIdentity } from './jobStore.js'

export class LeaseGuardLostError extends Error {
  constructor() {
    super('job lease was lost')
    this.name = 'LeaseGuardLostError'
  }
}

export interface LeaseGuardOptions {
  readonly store: JobStore
  readonly identity: LeaseIdentity
  readonly leaseMs: number
  readonly parentSignal: AbortSignal
  readonly now?: () => number
  readonly heartbeatMs?: number
}

export class LeaseGuard {
  private readonly store: JobStore
  private readonly identity: LeaseIdentity
  private readonly leaseMs: number
  private readonly now: () => number
  private readonly controller = new AbortController()
  private readonly heartbeatMs: number
  private readonly parentSignal: AbortSignal
  private timer?: NodeJS.Timeout
  private renewal?: Promise<void>
  private stopped = false

  constructor(options: LeaseGuardOptions) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new RangeError('leaseMs must be a positive integer')
    }
    const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(options.leaseMs / 3))
    if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= options.leaseMs) {
      throw new RangeError('heartbeatMs must be positive and shorter than leaseMs')
    }
    this.store = options.store
    this.identity = options.identity
    this.leaseMs = options.leaseMs
    this.parentSignal = options.parentSignal
    this.now = options.now ?? Date.now
    this.heartbeatMs = heartbeatMs
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  start(): void {
    if (this.timer || this.stopped) return
    if (this.parentSignal.aborted) {
      this.abort(this.parentSignal.reason)
      return
    }
    this.parentSignal.addEventListener('abort', this.onParentAbort, { once: true })
    this.timer = setInterval(() => {
      if (!this.renewal) this.renewal = this.renew().finally(() => { this.renewal = undefined })
    }, this.heartbeatMs)
    this.timer.unref()
  }

  async ensure(): Promise<void> {
    if (this.signal.aborted) throw this.signal.reason ?? new LeaseGuardLostError()
    let lease: JobLease | undefined
    try {
      lease = await this.store.renewLease(this.identity, this.now(), this.leaseMs)
    } catch {
      const error = new LeaseGuardLostError()
      this.abort(error)
      throw error
    }
    if (!lease) {
      const error = new LeaseGuardLostError()
      this.abort(error)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.parentSignal.removeEventListener('abort', this.onParentAbort)
    await this.renewal
  }

  private readonly onParentAbort = (): void => this.abort(this.parentSignal.reason)

  private abort(reason: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private async renew(): Promise<void> {
    try {
      await this.ensure()
    } catch {
      // ensure() records the reason on the shared abort signal.
    }
  }
}
