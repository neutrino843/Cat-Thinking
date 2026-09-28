import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, selectNode } from './helpers'

/**
 * M7-P3 C3：Blob 持久化端到端校验。
 * 场景：选中节点 → NodePanel 上传图片 → 刷新页面 → 验证图片仍渲染（blob 已落 IndexedDB）。
 */

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('上传图片后刷新仍存在（Blob 持久化）', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  // 选中第一个节点
  await selectNode(page, 0)

  // 通过 NodePanel 上传图片
  const fileInput = page.locator('.msz-node-panel input[type=file][accept="image/*"]')
  await fileInput.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: TINY_PNG })

  // 等待图片渲染（Canvas 中出现 <image> 元素）
  await expect(page.locator('svg image').first()).toBeVisible({ timeout: 5000 })

  // 刷新页面
  await page.reload()
  await waitForApp(page)

  // 重新选中同一节点（第一个）
  await selectNode(page, 0)

  // 验证图片仍渲染
  await expect(page.locator('svg image').first()).toBeVisible({ timeout: 5000 })
})

test('上传附件后刷新仍存在', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  await selectNode(page, 0)

  const fileInput = page.locator('.msz-node-panel input[type=file]:not([accept])')
  await fileInput.first().setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello blob') })

  // 附件列表出现
  await expect(page.locator('.msz-np-att-item').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.msz-np-att-name').first()).toContainText('note.txt')

  await page.reload()
  await waitForApp(page)
  await selectNode(page, 0)

  await expect(page.locator('.msz-np-att-name').first()).toContainText('note.txt')
})
