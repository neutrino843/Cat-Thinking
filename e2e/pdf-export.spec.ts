import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu } from './helpers'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * M10（PRD 4.3 P1）：PDF 导出。自研生成器产出的文件必须：
 * - 扩展名 .pdf、以 %PDF 魔数开头、%%EOF 结尾（真实 PDF，可被阅读器打开）；
 * - 导图视图与甘特视图都可导出。
 */
test('导图视图导出真实 PDF 文件', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)
  await page.locator('input.doc-title').fill('PDF导图')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /^PDF/),
  ])
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
  const savePath = path.join(__dirname, 'tmp-mind.pdf')
  await download.saveAs(savePath)
  const buf = await fs.readFile(savePath)
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  const tail = buf.subarray(-8).toString('latin1')
  expect(tail).toContain('%%EOF')
  // 含 JPEG 图像 XObject 与页面对象
  const all = buf.toString('latin1')
  expect(all).toContain('/DCTDecode')
  expect(all).toContain('/Type /Page')
  await fs.unlink(savePath).catch(() => {})
})

test('甘特视图导出 PDF 文件名带甘特后缀', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)
  await page.locator('input.doc-title').fill('PDF甘特')

  // 切到甘特视图（M11 起 doc-tab 也是 role=tab，需 exact 锁定视图切换按钮）
  await page.getByRole('tab', { name: '甘特', exact: true }).click()
  await expect(page.locator('#gantt-world')).toBeAttached()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /^PDF/),
  ])
  expect(download.suggestedFilename()).toMatch(/甘特\.pdf$/)
  const savePath = path.join(__dirname, 'tmp-gantt.pdf')
  await download.saveAs(savePath)
  const buf = await fs.readFile(savePath)
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  await fs.unlink(savePath).catch(() => {})
})
