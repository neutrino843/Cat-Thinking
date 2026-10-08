import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M11（PRD 4.4 P1）：多文档标签页。
 * - 新建文档产生标签，标签间切换；
 * - 每文档撤销栈独立（A 里撤销不影响 B 的内容）；
 * - ✕ 关闭标签（含后台关闭）；
 * - 刷新后标签条从 localStorage（msz.openTabs）恢复。
 */

/** 在当前选中节点下新增一个子节点并写入文本（参考 msz-file.spec 的编辑节奏） */
async function addChildText(page: import('@playwright/test').Page, text: string) {
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  const editor = page.locator('textarea.node-editor').first()
  await expect(editor).toBeVisible()
  await editor.fill(text)
  await editor.press('Enter')
}

/** 连续撤销直到某文本在画布消失（新增节点流程的历史步数随实现微调，循环更稳） */
async function undoUntilGone(page: import('@playwright/test').Page, text: string) {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Control+z')
    const gone = await page.evaluate(
      (t) => !document.querySelector('svg.canvas-svg')?.textContent?.includes(t),
      text,
    )
    if (gone) return
  }
  throw new Error(`撤销 ${text} 失败：4 步后仍在画布上`)
}

test('标签页：切换、独立撤销、关闭、刷新恢复', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 初始：欢迎教程自动以单标签打开
  await expect(page.locator('.doc-tab')).toHaveCount(1)
  await page.locator('input.doc-title').fill('文档A')

  // 新建空白文档 → 第二个标签
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await expect(page.locator('.doc-tab')).toHaveCount(2)
  await page.locator('input.doc-title').fill('文档B')

  // 标签顺序与活动态
  const names0 = await page.locator('.doc-tab-name').allTextContents()
  expect(names0).toEqual(['文档A', '文档B'])
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('文档B')

  // 在 B 中添加独有节点
  await addChildText(page, 'B特有')
  await expect(page.locator('svg.canvas-svg')).toContainText('B特有')

  // 切到 A，添加 A 独有节点
  await page.locator('.doc-tab', { hasText: '文档A' }).click()
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('文档A')
  await addChildText(page, 'A特有')
  await expect(page.locator('svg.canvas-svg')).toContainText('A特有')
  await expect(page.locator('svg.canvas-svg')).not.toContainText('B特有')

  // A 中撤销到 A特有消失；B 会话不受影响
  await undoUntilGone(page, 'A特有')
  await expect(page.locator('svg.canvas-svg')).not.toContainText('A特有')

  await page.locator('.doc-tab', { hasText: '文档B' }).click()
  await expect(page.locator('svg.canvas-svg')).toContainText('B特有')

  // B 自身也撤销干净
  await undoUntilGone(page, 'B特有')
  await expect(page.locator('svg.canvas-svg')).not.toContainText('B特有')

  // 后台关闭 A（当前活动为 B）
  await page.locator('.doc-tab', { hasText: '文档A' }).locator('.doc-tab-close').click()
  await expect(page.locator('.doc-tab')).toHaveCount(1)
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('文档B')
  const savedTabs = await page.evaluate(() => localStorage.getItem('msz.openTabs'))
  expect(savedTabs).not.toBeNull()
  expect(JSON.parse(savedTabs as string)).toHaveLength(1)

  // 刷新：标签条恢复，仍停在 B
  await page.reload()
  await waitForApp(page)
  await expect(page.locator('.doc-tab')).toHaveCount(1)
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('文档B')
  await expect(page.locator('input.doc-title')).toHaveValue('文档B')
})
