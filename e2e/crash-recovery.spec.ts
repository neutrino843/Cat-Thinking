import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, selectNode } from './helpers'

/**
 * R-4：崩溃恢复端到端验证。
 * 场景：修改文档标题 + 节点文本 → 等待 700ms 自动保存落盘 → reload → 内容仍在。
 * 这条链路代码在 M1 即就绪，但 happy-dom 无 IndexedDB 从未端到端证明（M6 §一）。
 */
test('reload 后文档与标题持久', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  // App 启动自动建了 welcome 文档，标题输入框可见
  const title = page.locator('input.doc-title')
  await expect(title).toBeVisible()
  await title.fill('崩溃恢复测试-标题')

  // 选中根节点（只选中不编辑）→ F2 进入编辑 → 输入 → 回车提交
  await selectNode(page, 0)
  await page.keyboard.press('F2')
  const editor = page.locator('textarea.node-editor').first()
  await expect(editor).toBeVisible()
  await editor.fill('根节点新文本')
  await editor.press('Enter')
  await expect(editor).toBeHidden()

  // 等 700ms 自动保存 + 余量
  await page.waitForTimeout(1200)

  // reload：模拟崩溃后重开
  await page.reload()
  await expect(page.locator('.loading')).toBeHidden({ timeout: 15_000 })

  // 标题与节点文本应仍在
  await expect(page.locator('input.doc-title')).toHaveValue('崩溃恢复测试-标题')
  await expect(page.locator('svg')).toContainText('根节点新文本')
})
