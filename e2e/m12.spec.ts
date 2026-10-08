import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M12 E2E：i18n 切换、大纲内拖拽排序。
 * 对齐吸附由 src/lib/snap.test.ts 单测覆盖（E2E 拖拽+吸附时序易抖，不做端到端断言）。
 */

test('i18n：切换中/英后视图按钮文案变化，刷新保持', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const mindBtn = page.locator('.view-switch [role=tab]').first()
  await expect(mindBtn).toHaveText('导图')

  // 切到英文
  await page.locator('.lang-sel').selectOption('en-US')
  await expect(mindBtn).toHaveText('Mind')
  await expect(page.locator('.view-switch [role=tab]').nth(1)).toHaveText('Gantt')

  // 刷新后保持
  await page.reload()
  await waitForApp(page)
  await expect(mindBtn).toHaveText('Mind')

  // 切回中文
  await page.locator('.lang-sel').selectOption('zh-CN')
  await expect(mindBtn).toHaveText('导图')
})

/** 新建空白文档并打开大纲 */
async function blankWithOutline(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  // 大纲切换按钮（header 内，避免与大纲面板标题冲突）
  await page.locator('header.toolbar').getByRole('button', { name: /大纲/ }).click()
  await expect(page.locator('.outline')).toBeVisible()
}

/** 给根加一个子节点并填文本，返回新节点的大纲行定位 */
async function addRootChild(page: import('@playwright/test').Page, text: string) {
  await selectNode(page, 0) // 根
  await page.keyboard.press('Tab')
  const ed = page.locator('textarea.node-editor').first()
  await ed.fill(text)
  await ed.press('Enter')
}

/** 取大纲中第 n 行 input 的 value */
function rowInput(page: import('@playwright/test').Page, n: number) {
  return page.locator('.outline-row').nth(n).locator('input[data-oid]')
}

test('大纲内拖拽：拖到另一节点内部成为其子节点', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  await blankWithOutline(page)

  await addRootChild(page, '甲')
  await addRootChild(page, '乙')

  // 行 0=根，行 1=甲，行 2=乙
  const rows = page.locator('.outline-row')
  const src = rows.nth(2)
  const dst = rows.nth(1)
  const dstBox = await dst.boundingBox()
  if (!dstBox) throw new Error('找不到目标行')
  await src.dragTo(dst, { targetPosition: { x: dstBox.width / 2, y: dstBox.height / 2 } })

  // 乙行 input 仍存在
  await expect(rowInput(page, 2)).toHaveValue('乙')
  // 乙行缩进 > 甲行缩进（成为子节点）
  const jiaPad = await rows.nth(1).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  const yiPad = await rows.nth(2).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  expect(yiPad).toBeGreaterThan(jiaPad)
})

test('大纲内拖拽：在兄弟间排序（before 位置）', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
  await blankWithOutline(page)

  await addRootChild(page, '第一')
  await addRootChild(page, '第二')

  const rows = page.locator('.outline-row')
  const first = rows.nth(1)
  const second = rows.nth(2)

  const firstBox = await first.boundingBox()
  if (!firstBox) throw new Error('找不到第一行')
  await second.dragTo(first, { targetPosition: { x: firstBox.width / 2, y: firstBox.height * 0.1 } })

  await expect(rowInput(page, 1)).toHaveValue('第二')
  await expect(rowInput(page, 2)).toHaveValue('第一')
})
