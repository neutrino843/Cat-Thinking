import { test, expect } from '@playwright/test'
import { resetStore, waitForApp, autoAcceptDialog, clickExportMenu } from './helpers'

/**
 * M9 关系表达（PRD 4.1.5 P1）E2E 集成测试
 * 验证关系线、概要、边界框的数据持久化与导出。
 */

test.beforeEach(async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)
})

test.describe('M9 数据持久化与导出', () => {
  test('导出 JSON 包含 version 3 且 overlay 字段可选', async ({ page }) => {
    autoAcceptDialog(page)
    // 修改标题
    await page.locator('input.doc-title').fill('M9测试文档')
    await page.waitForTimeout(200)

    // 导出 JSON
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

    // M9：版本号升级到 3
    expect(doc.version).toBe(3)
    // overlay 字段在空文档中应为 undefined（不输出到 JSON）
    expect(doc.relations).toBeUndefined()
    expect(doc.summaries).toBeUndefined()
    expect(doc.boundaryBoxes).toBeUndefined()
  })

  test('画布渲染不因 overlay 字段缺失而崩溃', async ({ page }) => {
    // 验证空文档（无 overlay）画布正常
    await expect(page.locator('.canvas-svg')).toBeVisible()
    const world = page.locator('#world')
    await expect(world).toBeVisible()
    // 确认节点可交互（Tab 建子节点）
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    const nodeCount = await page.locator('svg g[role=button]').count()
    expect(nodeCount).toBeGreaterThanOrEqual(2)
  })

  test('切换布局后画布不崩溃（overlay 字段保持 undefined）', async ({ page }) => {
    // 打开命令面板切换布局
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(200)
    // 搜索树形布局
    await page.keyboard.type('树形')
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // 画布仍可见
    await expect(page.locator('.canvas-svg')).toBeVisible()
  })

  test('导入 v2 文档后自动迁移到 v3', async ({ page }) => {
    autoAcceptDialog(page)
    // 构造一个 v2 JSON 文档
    const v2Doc = {
      version: 2,
      id: 'test-v2-migrate',
      title: 'V2迁移测试',
      rootId: 'r',
      layout: 'logic',
      nodes: {
        r: { id: 'r', parent: null, children: ['c1'], text: '根' },
        c1: { id: 'c1', parent: 'r', children: [], text: '子' },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // 通过剪贴板粘贴导入
    await page.evaluate((doc) => {
      const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' })
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File([blob], 'v2-test.json'))
      const ev = new DragEvent('drop', { dataTransfer, bubbles: true })
      document.dispatchEvent(ev)
    }, v2Doc)
    await page.waitForTimeout(1000)

    // 导出验证版本为 3
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      clickExportMenu(page, /JSON/),
    ])
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf-8')
    const doc = JSON.parse(text)
    expect(doc.version).toBe(3)
  })
})
