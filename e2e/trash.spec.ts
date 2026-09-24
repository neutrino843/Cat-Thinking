import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog } from './helpers'

/**
 * 回收站全链路（M6 §3.1）：软删 → 回收站 → 还原 → 再软删 → 永久删 → 刷新持久。
 * 注意：Sidebar 列表仅在 activeId 变化时刷新，故这里不依赖标题文本定位，
 * 一律用 .sb-item.active（当前文档）与计数断言。
 */
test('软删-还原-永久删-清空-刷新全链路', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  const libItems = page.locator('.sb-list:not(.sb-trash-list) .sb-item')
  const trashBtn = page.locator('button.sb-trash-btn')

  // 初始：App 自动建 welcome，文档库 1 条且 active
  await expect(libItems).toHaveCount(1)
  const docRow = page.locator('.sb-item.active').first()
  await expect(docRow).toBeVisible()

  // —— 软删（当前文档被删后 Sidebar 兜底新建 blank，文档库仍为 1 条）——
  await docRow.locator('button.sb-del[title="删除"]').click()
  await expect(trashBtn).toContainText('(1)')

  // 切到回收站视图，应看到 1 条
  await trashBtn.click()
  const trashRow = page.locator('.sb-trash-item').first()
  await expect(trashRow).toBeVisible()
  await expect(page.locator('.sb-trash-item')).toHaveCount(1)

  // —— 还原：还原后自动 loadDoc，welcome 回到文档库并 active（文档库共 2 条）——
  await trashRow.locator('button[title="还原"]').click()
  await page.locator('button[aria-label="返回文档库"]').click()
  await expect(libItems).toHaveCount(2)
  await expect(page.locator('.sb-item.active')).toBeVisible()
  await expect(trashBtn).not.toContainText('(1)')

  // —— 再次软删当前 active 文档 → 永久删 ——
  await page.locator('.sb-item.active').first().locator('button.sb-del[title="删除"]').click()
  await expect(trashBtn).toContainText('(1)')
  await trashBtn.click()
  const trashRow2 = page.locator('.sb-trash-item').first()
  await expect(trashRow2).toBeVisible()
  await trashRow2.locator('button[title="永久删除"]').click()
  await expect(trashRow2).toBeHidden()
  await expect(page.locator('.sb-trash-empty')).toBeVisible()

  // —— 刷新后回收站仍为空，文档库剩 1 条（blank）——
  await page.reload()
  await expect(page.locator('.loading')).toBeHidden({ timeout: 15_000 })
  await expect(libItems).toHaveCount(1)
  await page.locator('button.sb-trash-btn').click()
  await expect(page.locator('.sb-trash-empty')).toBeVisible()
})
