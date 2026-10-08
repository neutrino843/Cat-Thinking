import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M13 E2E：甘特表格视图就地编辑（日期/进度/里程碑）。
 */

test('甘特表格：变为任务后可就地编辑开始日期、进度，切换里程碑', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 新建空白文档
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('svg g[role=button]').first().waitFor({ timeout: 10000 })

  // 给根加一个子节点
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const ed = page.locator('textarea.node-editor').first()
  await ed.fill('任务A')
  await ed.press('Enter')

  // 切到甘特视图
  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  await expect(page.locator('#gantt-world')).toBeAttached()

  // 表格头存在
  await expect(page.locator('.gantt-corner')).toContainText('任务')
  await expect(page.locator('.gantt-corner')).toContainText('开始')
  await expect(page.locator('.gantt-corner')).toContainText('结束')
  await expect(page.locator('.gantt-corner')).toContainText('进度')
  await expect(page.locator('.gantt-corner')).toContainText('里程碑')
  await expect(page.locator('.gantt-corner')).toContainText('依赖')

  // 子节点（第 2 行）当前非任务，依赖列显示「0 项」之前应先变为任务
  const childRow = page.locator('.gantt-left .gantt-row').nth(1)
  // 点击「＋变为任务」
  await childRow.locator('.gantt-add').click()

  // 变为任务后：开始/结束出现 date input，进度出现 range，里程碑出现 checkbox，依赖显示「0 项」
  await expect(childRow.locator('input.gantt-date').first()).toBeVisible()
  await expect(childRow.locator('input.gantt-range')).toBeVisible()
  await expect(childRow.locator('input.gantt-check')).toBeVisible()
  await expect(childRow.locator('.gantt-deps-btn')).toContainText('0 项')

  // 编辑开始日期
  const startInput = childRow.locator('input.gantt-date').first()
  await startInput.fill('2026-01-15')
  await startInput.press('Enter')

  // 编辑进度：拖动 range 到 50（React 受控 input 需用原生 setter 触发 onChange）
  const range = childRow.locator('input.gantt-range')
  await range.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, '50')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(childRow.locator('.gantt-prog-text')).toHaveText('50%')

  // 切换里程碑：勾选后结束列变为 ◆
  await childRow.locator('input.gantt-check').check()
  await expect(childRow.locator('.gantt-muted')).toContainText('◆')

  // 刷新后数据保持（验证已持久化）
  await page.reload()
  await waitForApp(page)
  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  const childRowAfter = page.locator('.gantt-left .gantt-row').nth(1)
  await expect(childRowAfter.locator('input.gantt-date').first()).toHaveValue('2026-01-15')
  await expect(childRowAfter.locator('.gantt-prog-text')).toHaveText('50%')
  await expect(childRowAfter.locator('input.gantt-check')).toBeChecked()
})
