import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const enabled = process.env.ANALYSIS_LIVE_SMOKE === 'I_ACKNOWLEDGE_BILLABLE_SYNTHETIC_SMOKE'
  && process.env.ANALYSIS_LIVE_SMOKE_PREREQUISITES_READY === 'true'
// Even an explicitly selected live test goes through the protected CLI. It has
// no direct Provider path or temporary boolean that can bypass durable recovery.
describe.skipIf(!enabled)('protected billable synthetic Provider smoke', () => {
  it('delegates to exact-config, signed-checkpoint validation and leaves admission held', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/run-live-provider-smoke.mjs')], {
      cwd: resolve('.'), env: process.env, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Dedicated smoke verification completed using its reusable nonce and signed checkpoint')
    expect(result.stdout).toContain('admission remains held')
  }, 610000)
})
