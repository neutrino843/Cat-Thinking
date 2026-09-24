import { test, expect } from './helpers'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu } from './helpers'

/**
 * R-1：导出产物端到端校验。
 * 场景：导出 JSON → 拦截 download → 解析文件内容 → 断言 title/rootId 与当前文档一致。
 * 修审核 R-1：之前从未对下载产物做实际内容校验。
 */
test('导出 JSON 内容与当前文档一致', async ({ page }) => {
  autoAcceptDialog(page)
  await resetStore(page)
  await waitForApp(page)

  // 修改标题让断言更具体
  const title = page.locator('input.doc-title')
  await title.fill('导出测试-2026')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExportMenu(page, /JSON/),
  ])
  expect(download.suggestedFilename()).toMatch(/\.json$/)

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf-8')
  const doc = JSON.parse(text)
  expect(doc.title).toBe('导出测试-2026')
  expect(typeof doc.rootId).toBe('string')
  expect(doc.nodes[doc.rootId]).toBeDefined()
  // 节点结构基本断言
  for (const id of Object.keys(doc.nodes)) {
    expect(doc.nodes[id].id).toBe(id)
    expect(Array.isArray(doc.nodes[id].children)).toBe(true)
  }
})
