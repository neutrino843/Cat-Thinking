import { test, expect, type Page } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * v2.1 需求5：画布平移 / 节点拖拽回归。
 * 根因：Canvas/Gantt 的 aliveRef 只在 cleanup 置 false，StrictMode（dev）
 * setup→cleanup→setup 后标记永久为 false，拖拽监听第一次 pointermove 即自清理。
 * 这些用例必须使用真实鼠标（page.mouse），合成 dispatchEvent 不经过 React 指针链路。
 */

async function readView(page: Page): Promise<{ tx: number; ty: number; k: number }> {
  const t = await page.locator('svg.canvas-svg > g').first().getAttribute('transform')
  const m = /translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(t ?? '')
  if (!m) throw new Error('读不到画布 transform：' + t)
  return { tx: Number(m[1]), ty: Number(m[2]), k: Number(m[3]) }
}

/** 在画布上找一个命中 [data-bg] 的空白点（视口坐标） */
async function findBackgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const svg = document.querySelector('svg.canvas-svg')
    if (!(svg instanceof SVGSVGElement)) return null
    const r = svg.getBoundingClientRect()
    for (let gy = 0.82; gy > 0.15; gy -= 0.08) {
      for (let gx = 0.85; gx > 0.15; gx -= 0.08) {
        const x = Math.round(r.left + r.width * gx)
        const y = Math.round(r.top + r.height * gy)
        const el = document.elementFromPoint(x, y)
        if (el instanceof Element && el.hasAttribute('data-bg')) return { x, y }
      }
    }
    return null
  })
  if (!point) throw new Error('画布上找不到 data-bg 空白点')
  return point
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 })
  await page.mouse.up()
}

test('空白处真实鼠标拖拽：画布跟随平移，连续平移与反向拖回均生效', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  await expect(page.locator('svg.canvas-svg')).toBeVisible()

  const start = await findBackgroundPoint(page)
  const v0 = await readView(page)
  await drag(page, start, 140, 100)
  const v1 = await readView(page)
  expect(v1.tx - v0.tx).toBeCloseTo(140, 0)
  expect(v1.ty - v0.ty).toBeCloseTo(100, 0)
  expect(v1.k).toBeCloseTo(v0.k, 5)

  // 连续 5 次同向平移仍可继续（背景矩形边界 / 监听不丢失）
  let last = v1
  for (let i = 0; i < 5; i++) {
    const p = await findBackgroundPoint(page)
    await drag(page, p, 60, 40)
    const next = await readView(page)
    expect(next.tx).not.toBeCloseTo(last.tx, 0)
    last = next
  }

  // 反向拖回
  const beforeBack = await readView(page)
  const p2 = await findBackgroundPoint(page)
  await drag(page, p2, -120, -80)
  const afterBack = await readView(page)
  expect(afterBack.tx - beforeBack.tx).toBeCloseTo(-120, 0)
  expect(afterBack.ty - beforeBack.ty).toBeCloseTo(-80, 0)
})

test('拖拽节点时画布不平移（节点拖拽与背景平移互不干扰）', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  await expect(page.locator('svg g[role=button]').first()).toBeVisible()

  const before = await readView(page)
  // selectNode 是一次落在空白处的真实微拖拽：仅选中节点，不应推动画布视口
  await selectNode(page, 0)
  const after = await readView(page)
  expect(Math.abs(after.tx - before.tx)).toBeLessThan(2)
  expect(Math.abs(after.ty - before.ty)).toBeLessThan(2)
})

test('缩放后再平移：scale 保持、translate 更新', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const box = await page.locator('.canvas-wrap').boundingBox()
  if (!box) throw new Error('找不到 .canvas-wrap')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -260)
  await expect.poll(async () => (await readView(page)).k, { timeout: 3000 }).not.toBeCloseTo(0.5, 1)
  const zoomed = await readView(page)

  const p = await findBackgroundPoint(page)
  await drag(page, p, 90, 60)
  const moved = await readView(page)
  expect(moved.k).toBeCloseTo(zoomed.k, 5)
  expect(moved.tx - zoomed.tx).toBeCloseTo(90, 0)
  expect(moved.ty - zoomed.ty).toBeCloseTo(60, 0)
})

test('甘特任务条可横向拖拽改期（Gantt aliveRef 同构回归）', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('svg g[role=button]').first().waitFor({ timeout: 10000 })

  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const ed = page.locator('textarea.node-editor').first()
  await ed.fill('A')
  await ed.press('Enter')

  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  await expect(page.locator('#gantt-world')).toBeAttached()
  const row = page.locator('.gantt-left .gantt-row').nth(1)
  await row.locator('.gantt-add').click()

  // computeGantt 的 day0 = 最早任务开始日 - 3：单任务拖动时时间轴原点随之平移，
  // 条形 rect 的 x 属性保持恒定，因此改期通过左栏日期输入框（绑定 task.start/end）断言。
  const addDaysISO = (iso: string, n: number) => {
    const d = new Date(iso + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const dateInputs = row.locator('input.gantt-date')
  await expect(dateInputs.nth(0)).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
  const startBefore = await dateInputs.nth(0).inputValue()
  const endBefore = await dateInputs.nth(1).inputValue()

  const bar = page.locator('#gantt-world rect[rx="7"]').first()
  await expect(bar).toBeAttached()
  await bar.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }))
  const bbox = await bar.boundingBox()
  if (!bbox) throw new Error('任务条不可视，无法拖拽')
  // pxPerDay=44（标准档）：拖 120px → 平移 3 天，move 模式开始/结束日同步平移、工期不变
  await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2)
  await page.mouse.down()
  await page.mouse.move(bbox.x + bbox.width / 2 + 120, bbox.y + bbox.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect(dateInputs.nth(0)).toHaveValue(addDaysISO(startBefore, 3))
  await expect(dateInputs.nth(1)).toHaveValue(addDaysISO(endBefore, 3))
})
