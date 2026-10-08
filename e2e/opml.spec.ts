import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu, selectNode } from './helpers'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * M10（PRD 4.3 P1）：OPML 大纲交换格式导出-导入往返。
 * 结构（标题/层级/文本）必须保留；任务等非 OPML 字段本就不属于交换范围。
 */
test('OPML 导出-导入往返一致', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input.doc-title').fill('OPML往返')
  await selectNode(page, 0)

  await page.keyboard.press('Tab')
  const editor1 = page.locator('textarea.node-editor').first()
  await expect(editor1).toBeVisible()
  await editor1.fill('分支A')
  await editor1.press('Enter')
  await expect(editor1).toBeHidden()

  await page.keyboard.press('Enter')
  const editor2 = page.locator('textarea.node-editor').first()
  await expect(editor2).toBeVisible()
  await editor2.fill('分支B')
  await editor2.press('Enter')
  await expect(editor2).toBeHidden()

  // —— 导出 .opml ——
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /OPML/),
  ])
  expect(download.suggestedFilename()).toMatch(/\.opml$/)
  const savePath = path.join(__dirname, 'tmp-export.opml')
  await download.saveAs(savePath)
  const xml = await fs.readFile(savePath, 'utf-8')

  // OPML 结构断言
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  expect(xml).toContain('<opml version="2.0">')
  expect(xml).toContain('<title>OPML往返</title>')
  expect(xml).toContain('text="分支A"')
  expect(xml).toContain('text="分支B"')
  // 两分支为兄弟（在 XML 中缩进相同）
  const lineA = xml.split('\n').find((l) => l.includes('分支A'))
  const lineB = xml.split('\n').find((l) => l.includes('分支B'))
  if (!lineA || !lineB) throw new Error('OPML 中缺少两个分支行')
  expect(lineA.match(/^\s*/)?.[0].length).toBe(lineB.match(/^\s*/)?.[0].length)

  // —— 导入该 .opml ——
  await page.locator('input[type=file][accept*=".opml"]').setInputFiles(savePath)
  await expect(page.locator('input.doc-title')).toHaveValue('OPML往返')
  await expect(page.locator('svg')).toContainText('分支A')
  await expect(page.locator('svg')).toContainText('分支B')

  await fs.unlink(savePath).catch(() => {})
})
