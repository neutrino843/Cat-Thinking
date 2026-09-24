import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu, selectNode } from './helpers'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Markdown 往返（M6 §3.2）：导出 .md → 断言内容含标题/层级；导入该 .md → 节点恢复。
 * 解析只保证本应用导出格式的严格子集（计划 §五 风险对策）。
 */
test('MD 导出-导入往返一致', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  // 起名 + 纯键盘加两个兄弟子节点
  await page.locator('input.doc-title').fill('MD往返测试')
  await selectNode(page, 0)

  // Tab：root 下建子A（store 自动进入 editing）
  await page.keyboard.press('Tab')
  const editor1 = page.locator('textarea.node-editor').first()
  await expect(editor1).toBeVisible()
  await editor1.fill('子节点A')
  await editor1.press('Enter')
  await expect(editor1).toBeHidden()

  // Enter：A 的兄弟 B（App.tsx addSibling）
  await page.keyboard.press('Enter')
  const editor2 = page.locator('textarea.node-editor').first()
  await expect(editor2).toBeVisible()
  await editor2.fill('子节点B')
  await editor2.press('Enter')
  await expect(editor2).toBeHidden()

  // —— 导出 .md ——
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /Markdown/),
  ])
  expect(download.suggestedFilename()).toMatch(/\.md$/)
  const savePath = path.join(__dirname, 'tmp-export.md')
  await download.saveAs(savePath)
  const md = await fs.readFile(savePath, 'utf-8')
  expect(md).toContain('# MD往返测试')
  expect(md).toContain('子节点A')
  expect(md).toContain('子节点B')
  // 两子节点缩进相同（兄弟）
  const lineA = md.split('\n').find((l) => l.includes('子节点A'))
  const lineB = md.split('\n').find((l) => l.includes('子节点B'))
  expect(lineA).toBeTruthy()
  expect(lineB).toBeTruthy()
  const indentA = lineA!.match(/^\s*/)![0].length
  const indentB = lineB!.match(/^\s*/)![0].length
  expect(indentA).toBe(indentB)

  // —— 导入该 .md：导入后 loadDoc，新文档 active ——
  await page.locator('input[type=file]').setInputFiles(savePath)
  await expect(page.locator('input.doc-title')).toHaveValue('MD往返测试')
  await expect(page.locator('svg')).toContainText('子节点A')
  await expect(page.locator('svg')).toContainText('子节点B')

  await fs.unlink(savePath).catch(() => {})
})
