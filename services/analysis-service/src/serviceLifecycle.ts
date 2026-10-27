/** Coordinate startup and shutdown without closing resources under initialization. */
export function createServiceLifecycle(options: {
  start: (isStopping: () => boolean) => Promise<void>
  stop: () => Promise<void>
  onStopRequested: (reason: string) => void
}) {
  let stopping = false
  let startup: Promise<void> | undefined
  let shutdown: Promise<void> | undefined
  return {
    start(): Promise<void> {
      return startup ??= Promise.resolve().then(async () => {
        if (!stopping) await options.start(() => stopping)
      })
    },
    shutdown(reason: string): Promise<void> {
      if (shutdown) return shutdown
      stopping = true
      shutdown = Promise.resolve().then(async () => {
        options.onStopRequested(reason)
        await startup?.catch(() => undefined)
        await options.stop()
      })
      return shutdown
    },
  }
}
