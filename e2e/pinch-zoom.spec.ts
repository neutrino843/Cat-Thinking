import { test, expect, type Page } from './helpers'
import { resetStore, waitForApp } from './helpers'

/**
 * M11（PRD 4.1.1 P1）：触控板捏合缩放。
 * Chromium/Edge/Firefox 把捏合映射为 ctrlKey=true 的 wheel 事件（deltaMode 连续小值），
 * 这里派发合成 WheelEvent 验证接线：ctrlKey 通道缩放、非 ctrl 滚轮通道并存、且 k 有上下钳制。
 * 锚点数学本身由 src/lib/viewport.test.ts 覆盖。
 */
async function readScale(page: Page): Promise<number> {
  const t = await page.locator('svg.canvas-svg > g').getAttribute('transform')
  const m = /scale\(([-\d.]+)\)/.exec(t ?? '')
  if (!m) throw new Error('读不到画布 scale：' + t)
  return Number(m[1])
}

async function wheel(page: Page, opts: { deltaY: number; ctrlKey: boolean }) {
  await page.evaluate((o) => {
    const el = document.querySelector('.canvas-wrap') as HTMLElement | null
    if (!el) throw new Error('找不到 .canvas-wrap')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: o.deltaY,
        ctrlKey: o.ctrlKey,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, opts)
}

test('捏合（ctrlKey wheel）缩放，且与普通滚轮通道并存', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const k0 = await readScale(page)

  // 捏合放大（deltaY<0 + ctrlKey）
  await wheel(page, { deltaY: -20, ctrlKey: true })
  await expect
    .poll(() => readScale(page), { timeout: 3000 })
    .toBeGreaterThan(k0)
  const kPinchedIn = await readScale(page)
  expect(kPinchedIn).toBeCloseTo(k0 * Math.exp(0.2), 4)

  // 捏合缩小回去
  await wheel(page, { deltaY: 20, ctrlKey: true })
  await expect
    .poll(() => readScale(page), { timeout: 3000 })
    .toBeLessThan(kPinchedIn)

  // 普通滚轮（无 ctrlKey）同样可缩放
  const k1 = await readScale(page)
  await wheel(page, { deltaY: -100, ctrlKey: false })
  await expect
    .poll(() => readScale(page), { timeout: 3000 })
    .toBeGreaterThan(k1)
})

test('缩放钳制在 15%–300%', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  for (let i = 0; i < 40; i++) await wheel(page, { deltaY: -50, ctrlKey: true })
  await expect
    .poll(() => readScale(page), { timeout: 5000 })
    .toBeLessThanOrEqual(3.0001)
  expect(await readScale(page)).toBeCloseTo(3, 3)

  for (let i = 0; i < 80; i++) await wheel(page, { deltaY: 50, ctrlKey: true })
  await expect
    .poll(() => readScale(page), { timeout: 5000 })
    .toBeGreaterThanOrEqual(0.15 - 1e-6)
  expect(await readScale(page)).toBeCloseTo(0.15, 3)
})
