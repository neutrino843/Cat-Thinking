import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { buildFixture } = await import('/src/test/fixture.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const { useSettings } = await import('/src/store/settings.ts')
    useSettings.setState({ outline: true, sidebar: false })
    useDoc.getState().loadDoc(buildFixture({ text: '章节', children: [{ text: '方案甲' }, { text: '方案乙' }, { text: '方案丙' }] }))
  })
})

test('兄弟重排后未变化行刷新缩进按钮，并使用最新前一个兄弟', async ({ page }) => {
  const row = (id: string) => page.locator('.outline-row').filter({ has: page.locator(`textarea[data-oid="${id}"]`) })
  await expect(row('n1').locator('button.outdent')).toBeDisabled()
  await expect(row('n2').locator('button.outdent')).toBeEnabled()
  await page.evaluate(async () => {
    const { useDoc } = await import('/src/store/docStore.ts')
    useDoc.getState().reparentAt('n1', 'n0', 2)
  })
  await expect(row('n2').locator('button.outdent')).toBeDisabled()
  await expect(row('n1').locator('button.outdent')).toBeEnabled()
  // n3 itself did not change; its previous sibling changed from n2 to n1.
  await page.evaluate(async () => {
    const { useDoc } = await import('/src/store/docStore.ts')
    useDoc.getState().reparentAt('n1', 'n0', 1)
  })
  await row('n3').locator('button.outdent').click()
  const parent = () => page.evaluate(async () => (await import('/src/store/docStore.ts')).useDoc.getState().doc.nodes.n3.parent)
  await expect.poll(parent).toBe('n1')
  await row('n3').locator('button.indent').click()
  await expect.poll(parent).toBe('n0')
})

test('字体失效在文档未变时更新Canvas，重新挂载后仍订阅并可导出', async ({ page }) => {
  await page.evaluate(() => document.fonts.ready)
  const shape = page.locator('[data-node-id="n1"] .msz-node-in > path').first()
  const before = await shape.getAttribute('d')
  await page.evaluate(async () => {
    const { useDoc } = await import('/src/store/docStore.ts')
    const originalDoc = useDoc.getState().doc
    const original = CanvasRenderingContext2D.prototype.measureText
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const metrics = original.call(this, text)
      return new Proxy(metrics, { get(target, property) { return property === 'width' ? target.width * 1.7 : Reflect.get(target, property, target) } })
    }
    try {
      document.fonts.dispatchEvent(new Event('loadingdone'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (useDoc.getState().doc !== originalDoc) throw new Error('Font invalidation must not mutate the document')
    } finally { CanvasRenderingContext2D.prototype.measureText = original }
  })
  await expect.poll(() => shape.getAttribute('d')).not.toBe(before)
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingerror')))
  await expect.poll(() => shape.getAttribute('d')).toBe(before)
  // Switching workspaces unmounts Canvas. Return with a fresh font revision.
  await page.evaluate(() => { location.hash = '' })
  await expect(page.locator('[data-node-id="n1"]')).toHaveCount(0)
  await page.evaluate(async () => {
    const { invalidateTextMeasurements } = await import('/src/lib/measure.ts')
    invalidateTextMeasurements()
    location.hash = '#mindmap'
  })
  await expect(shape).toHaveAttribute('d', before!)
  await page.evaluate(async () => {
    const { invalidateTextMeasurements } = await import('/src/lib/measure.ts')
    const { computeLayout } = await import('/src/lib/layout.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    invalidateTextMeasurements()
    const exported = computeLayout(useDoc.getState().doc)
    if (exported.nodes.get('n1')?.textLines?.join('') !== '方案甲') throw new Error('Export layout lost text')
  })
  await expect(shape).toHaveAttribute('d', before!)
})
