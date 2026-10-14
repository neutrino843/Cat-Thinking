export class RunEventBroker {
  private readonly versions = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()

  version(runId: string): number {
    return this.versions.get(runId) ?? 0
  }

  publish(runId: string): void {
    this.versions.set(runId, this.version(runId) + 1)
    const runWaiters = this.waiters.get(runId)
    if (!runWaiters) return
    this.waiters.delete(runId)
    for (const resolve of runWaiters) resolve()
  }

  async wait(runId: string, observedVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.version(runId) !== observedVersion || signal?.aborted) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        const runWaiters = this.waiters.get(runId)
        runWaiters?.delete(finish)
        if (runWaiters?.size === 0) this.waiters.delete(runId)
        resolve()
      }
      const runWaiters = this.waiters.get(runId) ?? new Set<() => void>()
      runWaiters.add(finish)
      this.waiters.set(runId, runWaiters)
      const timer = setTimeout(finish, timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
}
