import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Same probe is run before and after optimization, in fresh isolated browser storage. */
test('profile repeated layout, one-node edit, outline input and large local import', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const posts: string[] = []
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'POST') posts.push(route.request().url())
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  })
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const profile = await page.evaluate(async () => {
    const { buildFixture } = await import('/src/test/fixture.ts')
    const { computeLayout } = await import('/src/lib/layout.ts')
    const { prepareDocumentImport } = await import('/src/lib/documentImport.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const { useSettings } = await import('/src/store/settings.ts')
    const nativeMeasure = CanvasRenderingContext2D.prototype.measureText
    let calls = 0
    CanvasRenderingContext2D.prototype.measureText = function (text) { calls++; return nativeMeasure.call(this, text) }
    try {
      const cases = []
      for (const count of [50, 200, 400, 1050]) {
        const doc = buildFixture({ text: `知识框架${count}`, children: Array.from({ length: count - 1 }, (_, index) => ({ text: `${count}/${index} ${String(index * 7919).padStart(8, '0')} ${'核对前提、理解概念并独立推导关键步骤'.repeat(4)}` })) })
        const startCalls = calls
        const start = performance.now()
        const initial = computeLayout(doc)
        const first = { ms: performance.now() - start, measureCalls: calls - startCalls }
        const warm = []
        for (let iteration = 0; iteration < 5; iteration++) {
          const previous = calls; const t = performance.now()
          computeLayout(doc)
          warm.push({ ms: performance.now() - t, measureCalls: calls - previous })
        }
        const changedId = doc.nodes[doc.rootId].children[0]
        const edited = { ...doc, nodes: { ...doc.nodes, [changedId]: { ...doc.nodes[changedId], text: '修改一个知识标题，其他节点保持不变' } } }
        const editCalls = calls; const editStart = performance.now()
        computeLayout(edited)
        const edit = { ms: performance.now() - editStart, measureCalls: calls - editCalls }
        const layouts = []
        for (const layout of ['logic', 'tree', 'org', 'fishbone', 'timeline'] as const) {
          const result = computeLayout({ ...doc, layout })
          layouts.push({ layout, bounds: result.bounds, nodes: [...result.nodes.values()].map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, lines: n.textLines })), edges: result.edges })
        }
        cases.push({ count, first, warm, edit, nodes: initial.nodes.size, geometry: layouts })
      }
      const text = '# 合成讲义\n\n' + Array.from({ length: 20_000 }, (_, index) => `第${index}条合成正文，用于核对原文范围并比较本地导入性能。`).join('\n\n')
      const imports = []
      for (let iteration = 0; iteration < 3; iteration++) {
        const start = performance.now()
        const draft = await prepareDocumentImport(new File([text], '大讲义.md'))
        imports.push({ ms: performance.now() - start, nodes: draft.stats.nodeCount, sourceCharacters: draft.source.charCount, locators: draft.source.locators?.length })
      }
      // Build a broad nested graph so editing its parent can expose unnecessary child renders.
      const outline = buildFixture({ text: '待编辑的章标题', children: Array.from({ length: 35 }, (_, index) => ({ text: `主题${index}`, children: Array.from({ length: 29 }, (_, child) => ({ text: `概念${index}/${child}` })) })) })
      useSettings.setState({ outline: true, sidebar: false })
      useDoc.getState().loadDoc(outline)
      return { cases, imports, outlineRootId: outline.rootId }
    } finally { CanvasRenderingContext2D.prototype.measureText = nativeMeasure }
  })
  const outlineInput = page.locator(`textarea[data-oid="${profile.outlineRootId}"]`)
  await expect(outlineInput).toBeVisible()
  const outlineTiming = await page.evaluate(async (rootId) => {
    const input = document.querySelector<HTMLTextAreaElement>(`textarea[data-oid="${rootId}"]`)
    if (!input) throw new Error('Missing outline fixture')
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new Error('Missing textarea value setter')
    const samples = []
    const dispatch = []
    const { useDoc } = await import('/src/store/docStore.ts')
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      setter.call(input, `待编辑的章标题${i}`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      dispatch.push(performance.now() - start)
      if (useDoc.getState().doc.nodes[rootId]?.text !== `待编辑的章标题${i}`) throw new Error('Outline input did not reach the store')
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      samples.push(performance.now() - start)
    }
    return { stableFrameMs: samples, synchronousDispatchMs: dispatch }
  }, profile.outlineRootId)
  expect(posts).toEqual([])
  for (const entry of profile.cases) expect(entry.nodes).toBe(entry.count)
  const directory = process.env.CAT_PERF_OUTPUT ?? 'reports/mindmap-performance-2026-10-21'
  const phase = process.env.CAT_PERF_PHASE ?? 'current'
  if (!/^[a-z-]+$/.test(phase)) throw new Error('Invalid performance phase')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${phase}.json`), JSON.stringify({ browser: browser.version(), viewport: page.viewportSize(), profile, outlineTiming, modelPosts: posts.length }, null, 2))
})

test('profile one genuinely cold graph in a page without app startup', async ({ page, browser }) => {
  await page.goto('/src/main.tsx')
  const result = await page.evaluate(async () => {
    const original = CanvasRenderingContext2D.prototype.measureText
    let calls = 0
    CanvasRenderingContext2D.prototype.measureText = function (text) { calls++; return original.call(this, text) }
    try {
      const { buildFixture } = await import('/src/test/fixture.ts')
      const { computeLayout } = await import('/src/lib/layout.ts')
      const doc = buildFixture({ text: '冷启动知识框架', children: Array.from({ length: 399 }, (_, index) => ({ text: `${index} ${String(index * 7919).padStart(8, '0')} ${'核对前提、理解概念并独立推导关键步骤'.repeat(4)}` })) })
      const start = performance.now()
      const geometry = computeLayout(doc)
      const cold = { ms: performance.now() - start, measureCalls: calls }
      const previous = calls; const warmStart = performance.now()
      computeLayout(doc)
      return { cold, warm: { ms: performance.now() - warmStart, measureCalls: calls - previous }, nodes: geometry.nodes.size }
    } finally { CanvasRenderingContext2D.prototype.measureText = original }
  })
  expect(result.nodes).toBe(400)
  const phase = process.env.CAT_PERF_PHASE ?? 'current'
  if (!/^[a-z-]+$/.test(phase)) throw new Error('Invalid performance phase')
  const directory = process.env.CAT_PERF_OUTPUT ?? 'reports/mindmap-performance-2026-10-21'
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${phase}-cold.json`), JSON.stringify({ browser: browser.version(), viewport: page.viewportSize(), result }, null, 2))
})
