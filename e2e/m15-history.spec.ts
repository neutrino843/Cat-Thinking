import { test, expect } from './helpers'
import { resetStore, waitForApp, selectNode } from './helpers'

/**
 * M15 E2E：文档版本历史。
 * 编辑并保存两个版本（节点文本 Original → Modified）→ 打开历史面板 →
 * 找到包含 "Original" 的旧版本并恢复 → 节点文本回退为 Original。
 * 通过 __resetVersionThrottle 绕过 5 分钟节流，确保测试可控。
 */
test('版本历史：保存两个版本后恢复旧版本，内容回退', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  // 新建空白文档
  await page.getByRole('button', { name: '新建文档' }).click()
  await page.locator('.tpl-row').first().locator('button').first().click()
  await page.locator('svg g[role=button]').first().waitFor({ timeout: 10000 })

  // 加一个子节点 "Original"
  await selectNode(page, 0)
  await page.keyboard.press('Tab')
  let ed = page.locator('textarea.node-editor').first()
  await ed.fill('Original')
  await ed.press('Enter')

  // 保存第一个版本（绕过 700ms 防抖），并重置节流
  await page.evaluate(async () => {
    const { saveDoc, __resetVersionThrottle } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    __resetVersionThrottle()
    await saveDoc(useDoc.getState().doc)
  })

  // 修改节点为 "Modified"
  await selectNode(page, 1)
  await page.keyboard.press('F2')
  ed = page.locator('textarea.node-editor').first()
  await expect(ed).toBeVisible()
  await ed.fill('Modified')
  await ed.press('Enter')

  // 保存第二个版本（节流已重置，会产生新快照）
  await page.evaluate(async () => {
    const { saveDoc, __resetVersionThrottle } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    __resetVersionThrottle()
    await saveDoc(useDoc.getState().doc)
  })

  // 打开版本历史面板（活动文档行的 ⟳ 按钮）
  await page.locator('.sb-item.active .sb-history').click()
  const modal = page.locator('.modal-mask')
  await expect(modal).toBeVisible()

  // 应至少有两个版本（自动持久化可能多产一个，不做强计数）
  const items = page.locator('.vh-item')
  await expect.poll(async () => await items.count()).toBeGreaterThanOrEqual(2)

  // 在页面内找到包含 "Original" 节点的旧版本并恢复
  await page.evaluate(async () => {
    const { listVersions, loadVersion, restoreVersion } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const docId = useDoc.getState().doc.id
    const vers = await listVersions(docId)
    // 从旧到新找第一个 payload 中含 "Original" 节点的版本
    for (let i = vers.length - 1; i >= 0; i--) {
      const v = await loadVersion(vers[i].id)
      if (!v) continue
      const hasOriginal = Object.values(v.nodes).some((n: any) => n.text === 'Original')
      const hasModified = Object.values(v.nodes).some((n: any) => n.text === 'Modified')
      if (hasOriginal && !hasModified) {
        await restoreVersion(vers[i].id)
        useDoc.getState().loadDoc((await loadVersion(vers[i].id))!)
        break
      }
    }
  })

  // 面板应关闭：点击关闭按钮
  await page.locator('.modal-head .tbtn').click()
  await expect(modal).toBeHidden()

  // 节点文本回退为 Original
  const nodeTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('svg g[role=button] text')).map((t) => t.textContent),
  )
  expect(nodeTexts).toContain('Original')
  expect(nodeTexts).not.toContain('Modified')
})
