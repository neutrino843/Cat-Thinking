import { expect, test, type Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { strToU8, zipSync } from 'fflate'
import { readFile, writeFile } from 'node:fs/promises'
import { clickExportMenu } from './helpers'

async function seed(page: Page, text = '原文内容。'.repeat(900)) {
  return page.evaluate(async (text) => {
    const { prepareDocumentImport } = await import('/src/lib/documentImport.ts')
    const { saveDocumentBundle } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    const draft = await prepareDocumentImport(new File([`# 章节\n\n${text}`], '合成讲义.md'))
    await saveDocumentBundle(draft.doc, [draft.source])
    useDoc.getState().openDoc(draft.doc)
    return { docId: draft.doc.id, rootId: draft.doc.rootId, childId: draft.doc.nodes[draft.doc.rootId].children[0] }
  }, text)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic offline' } }) }))
  await page.goto('/#mindmap')
  await expect(page.getByRole('button', { name: 'AI 分析', exact: true })).toBeVisible()
})

test('单击看全文，连续Tab保存文字并创建三级节点，根节点退级不丢焦点', async ({ page }) => {
  const ids = await seed(page)
  await page.locator(`[data-node-id="${ids.childId}"]`).click()
  await expect(page.locator('textarea.node-editor')).toHaveCount(0)
  const panel = page.getByRole('complementary', { name: '当前节点资料' })
  await expect(panel.getByLabel('当前节点原文')).toContainText('原文内容。')
  await panel.getByRole('button', { name: '下一段', exact: true }).click()
  await expect(panel).toContainText('4001–')
  await page.locator(`[data-node-id="${ids.rootId}"]`).click()
  await page.keyboard.press('F2')
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('textarea.node-editor')).toBeFocused()
  await page.locator('textarea.node-editor').fill('不应保存的修改')
  await page.keyboard.press('Escape')
  await expect(page.locator(`[data-node-id="${ids.rootId}"]`)).toBeFocused()
  await expect(page.locator(`[data-node-id="${ids.rootId}"]`)).not.toContainText('不应保存的修改')
  for (const text of ['定义', '关键步骤', '我的推导']) {
    await page.keyboard.press('Tab')
    const editor = page.locator('textarea.node-editor')
    await expect(editor).toBeFocused()
    await editor.fill(text)
  }
  await page.keyboard.press('Enter')
  await expect(page.locator('textarea.node-editor')).toHaveCount(0)
  await expect(page.locator('[data-node-id][tabindex="0"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('textarea.node-editor')).toBeFocused()
  await page.locator('textarea.node-editor').fill('同级补充')
  await page.keyboard.press('Enter')
  const result = await page.evaluate(async () => {
    const { useDoc } = await import('/src/store/docStore.ts')
    const doc = useDoc.getState().doc
    const find = (text: string) => Object.values(doc.nodes).find((node) => node.text === text)!
    return { correct: find('我的推导').parent === find('关键步骤').id && find('关键步骤').parent === find('定义').id && find('同级补充').parent === find('我的推导').parent, count: Object.keys(doc.nodes).length }
  })
  expect(result).toEqual({ correct: true, count: 6 })
})

test('大纲保留换行，退级后继续输入；弹窗与组合输入不执行图结构命令', async ({ page }) => {
  const ids = await seed(page, '短原文。')
  await page.evaluate(async ({ rootId, childId }) => {
    const { useDoc } = await import('/src/store/docStore.ts')
    const { useSettings } = await import('/src/store/settings.ts')
    useSettings.setState({ outline: true })
    useDoc.getState().setText(childId, '第一行\n第二行')
    const nested = useDoc.getState().addChild(childId, 'outline')
    useDoc.getState().setText(nested, '嵌套节点')
    useDoc.getState().setEditing(null)
    useDoc.getState().select([rootId])
  }, ids)
  const input = page.locator(`textarea[data-oid="${ids.childId}"]`)
  await input.fill('第一行\n第二行补充')
  await expect(input).toHaveValue('第一行\n第二行补充')
  const nested = page.locator('textarea[data-oid]').filter({ hasText: '嵌套节点' })
  await nested.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('textarea[data-oid]').filter({ hasText: '嵌套节点' })).toBeFocused()
  await input.focus()
  await page.getByRole('button', { name: '修改节点标题', exact: true }).click()
  const editor = page.locator('textarea.node-editor')
  await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  await expect(editor).toBeFocused()
  await editor.press('Escape')
  const before = await page.locator('textarea[data-oid]').count()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI 学习分析' })).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await page.locator('textarea[data-oid]').count()).toBe(before)
})

test('导入前可确认独立名称，取消不落盘，保存含课程归属原子提交', async ({ page }) => {
  await page.getByRole('button', { name: '学习首页', exact: true }).click()
  const upload = page.getByLabel('导入课程资料', { exact: true })
  const payload = { name: '高级密码学.txt', mimeType: 'text/plain', buffer: Buffer.from('授课教师：张老师\n\n第一章 群\n\n这是正文。') }
  await upload.setInputFiles(payload)
  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await dialog.getByLabel('讲义名称', { exact: true }).fill('第一讲讲义')
  await dialog.getByLabel('导图根标题', { exact: true }).fill('第一讲结构')
  await dialog.getByLabel('新课程名称', { exact: true }).fill('高级密码学')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return db.learningRecords.where('kind').equals('course').count() })).toBe(0)
  await upload.setInputFiles(payload)
  await dialog.getByLabel('讲义名称', { exact: true }).fill('第一讲讲义')
  await dialog.getByLabel('导图根标题', { exact: true }).fill('第一讲结构')
  await dialog.getByLabel('新课程名称', { exact: true }).fill('高级密码学')
  await dialog.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(async () => {
    const { db, loadDoc } = await import('/src/store/db.ts')
    const course = await db.learningRecords.where('kind').equals('course').first()
    const record = await db.learningRecords.where('kind').equals('document').first()
    const doc = record?.kind === 'document' ? await loadDoc(record.docId) : null
    return { name: course?.kind === 'course' ? course.name : '', title: doc?.title, root: doc?.nodes[doc.rootId].text, linked: course?.id === record?.courseId }
  })).toEqual({ name: '高级密码学', title: '第一讲讲义', root: '第一讲结构', linked: true })
})

test('课程挂接失败回滚整次导入，已有课程名称保持不变', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts')
    const { createCourse } = await import('/src/learning/repository.ts')
    const { importCourseDocument } = await import('/src/learning/importDocument.ts')
    const { prepareDocumentImport } = await import('/src/lib/documentImport.ts')
    const before = { docs: await db.docs.count(), sources: await db.sources.count(), records: await db.learningRecords.count() }
    const draft = await prepareDocumentImport(new File(['# 内容\n\n正文。'], '故障.md'))
    const failure = (_key: unknown, row: { kind?: string }) => { if (row.kind === 'document') throw new Error('Synthetic link failure') }
    db.learningRecords.hook('creating', failure)
    let failed = false
    try { await importCourseDocument(draft, { courseName: '不应残留' }) } catch { failed = true }
    finally { db.learningRecords.hook('creating').unsubscribe(failure) }
    const after = { docs: await db.docs.count(), sources: await db.sources.count(), records: await db.learningRecords.count() }
    const course = await createCourse({ name: '原课程' })
    await importCourseDocument(draft, { courseId: course.id, courseName: '不能覆盖' })
    return { failed, before, after, name: (await db.learningRecords.get(course.id) as { name?: string })?.name }
  })
  expect(result.failed).toBe(true)
  expect(result.after).toEqual(result.before)
  expect(result.name).toBe('原课程')
})

function pdfFixture() {
  const pages = [
    [['COURSE NOTES', 20, 760], ['Instructor: Dr Smith', 10, 735], ['1 Mechanism', 12, 700], ['The operation is closed in the finite group.', 12, 680], ['CAT THINKING', 10, 30]],
    [['COURSE NOTES', 20, 760], ['1.1 Initialization', 12, 700], ['Select a generator and check its order.', 12, 680], ['CAT THINKING', 10, 30]],
    [['COURSE NOTES', 20, 760], ['1.1.1 Preconditions', 12, 700], ['Check the group parameters before setup.', 12, 680], ['CAT THINKING', 10, 30]],
  ] as const
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const pageIds: number[] = []
  for (const lines of pages) {
    const pageId = objects.length + 1
    pageIds.push(pageId)
    const stream = lines.map(([text, size, y]) => `BT /F1 ${size} Tf 40 ${y} Td (${text}) Tj ET`).join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'ascii').toString('base64')
}

test('实际PDF文件恢复跨页编号，重复页眉不切断章节，全部引用指向原文', async ({ page }) => {
  const result = await page.evaluate(async (base64) => {
    const { prepareDocumentImport } = await import('/src/lib/documentImport.ts')
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
    const draft = await prepareDocumentImport(new File([bytes], '课程.pdf', { type: 'application/pdf' }))
    const nodes = Object.values(draft.doc.nodes)
    const find = (text: string) => nodes.find((node) => node.text === text)!
    return { title: draft.doc.title, hierarchy: find('1.1 Initialization').parent === find('1 Mechanism').id && find('1.1.1 Preconditions').parent === find('1.1 Initialization').id,
      headers: nodes.filter((node) => node.text === 'COURSE NOTES').length, teacher: nodes.some((node) => node.text.includes('Dr Smith')),
      retained: draft.source.text.includes('CAT THINKING'), warnings: draft.warnings,
      anchors: draft.source.anchors.every((anchor) => anchor.end <= draft.source.text.length && draft.source.text.slice(anchor.start, anchor.end).includes(draft.doc.nodes[anchor.nodeId].text)) }
  }, pdfFixture())
  expect(result).toMatchObject({ title: 'COURSE NOTES', hierarchy: true, headers: 1, teacher: false, retained: true, anchors: true })
  expect(result.warnings.join('')).toContain('重复页眉')
})

test('实际PPTX和DOCX保留项目级别，两个方案保持并列', async ({ page }) => {
  const body = '<p:sp><p:txBody><a:p><a:pPr lvl="0"/><a:r><a:t>BF</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Pairing</a:t></a:r></a:p><a:p><a:pPr lvl="0"/><a:r><a:t>BB</a:t></a:r></a:p></p:txBody></p:sp>'
  const pptx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p"/>'), 'ppt/slides/slide1.xml': strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>IBE</a:t></a:r></a:p></p:txBody></p:sp>${body}</p:spTree></p:cSld></p:sld>`) })
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body>' + ['BF', 'Pairing', 'BB'].map((text, index) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${index === 1 ? 1 : 0}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>') })
  for (const [name, bytes] of [['IBE.pptx', pptx], ['IBE.docx', docx]] as const) {
    const result = await page.evaluate(async ({ name, base64 }) => {
      const { prepareDocumentImport } = await import('/src/lib/documentImport.ts')
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
      const draft = await prepareDocumentImport(new File([bytes], name))
      const nodes = Object.values(draft.doc.nodes)
      const find = (text: string) => nodes.find((node) => node.text === text)!
      return { nested: find('Pairing').parent === find('BF').id, siblings: find('BF').parent === find('BB').parent }
    }, { name, base64: Buffer.from(bytes).toString('base64') })
    expect(result, name).toEqual({ nested: true, siblings: true })
  }
})

test('概念图需主动启动；旧图重整副本保留原图与个人备注', async ({ page }) => {
  const posts: string[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/')) posts.push(request.url()) })
  const ids = await seed(page, '正文。')
  await page.evaluate(async ({ rootId, docId }) => {
    const { useDoc } = await import('/src/store/docStore.ts')
    const { saveDoc } = await import('/src/store/db.ts')
    useDoc.getState().setNode(rootId, { note: '我的独立推导' })
    await saveDoc(useDoc.getState().doc)
    if (useDoc.getState().doc.id !== docId) throw new Error('wrong fixture')
  }, ids)
  await page.locator(`[data-node-id="${ids.rootId}"]`).click()
  await page.getByRole('button', { name: '整理概念关系图', exact: true }).click()
  const analysis = page.getByRole('dialog', { name: '概念关系图整理' })
  await expect(analysis).toBeVisible()
  await expect(analysis).toContainText('不覆盖原图')
  expect(posts).toEqual([])
  await analysis.getByRole('button', { name: '关闭 AI 分析', exact: true }).click()
  await page.getByRole('button', { name: '预览讲义结构副本', exact: true }).click()
  const preview = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await preview.getByLabel('讲义名称', { exact: true }).fill('重整副本')
  await preview.getByRole('button', { name: '创建可编辑导图', exact: true }).click()
  await expect(preview).toBeHidden()
  expect(await page.evaluate(async ({ docId, rootId }) => {
    const { loadDoc } = await import('/src/store/db.ts')
    const { useDoc } = await import('/src/store/docStore.ts')
    return { independent: useDoc.getState().doc.id !== docId, original: (await loadDoc(docId))?.nodes[rootId].note }
  }, ids)).toEqual({ independent: true, original: '我的独立推导' })
  expect(posts).toEqual([])
})

test('多行标题在SVG、PNG、PDF导出中保留，五布局文字测量有界', async ({ page }, testInfo) => {
  await seed(page, '正文。')
  const text = '完整概念标题需要自动换行并保留全部内容'.repeat(5)
  await page.evaluate(async (text) => {
    const { useDoc } = await import('/src/store/docStore.ts')
    const s = useDoc.getState()
    s.setText(s.doc.rootId, text)
  }, text)
  for (const kind of ['logic', 'tree', 'org', 'fishbone', 'timeline']) {
    await page.evaluate(async (kind) => { const { useDoc } = await import('/src/store/docStore.ts'); useDoc.getState().setLayout(kind as 'logic') }, kind)
    expect(await page.locator('[data-node-id]').first().locator('tspan').count()).toBeGreaterThan(1)
  }
  for (const format of ['SVG', 'PNG', 'PDF']) {
    const download = page.waitForEvent('download')
    await clickExportMenu(page, new RegExp(`^${format}`))
    const path = testInfo.outputPath(`multiline.${format.toLowerCase()}`)
    await (await download).saveAs(path)
    const bytes = await readFile(path)
    if (format === 'SVG') { expect(bytes.toString()).toContain('<tspan'); expect(bytes.toString()).toContain('</svg>') }
    if (format === 'PNG') expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    if (format === 'PDF') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  }
})

test('记录50、200、400节点的布局耗时与完整节点数量', async ({ page }, testInfo) => {
  const measurements = await page.evaluate(async () => {
    const { buildFixture } = await import('/src/test/fixture.ts')
    const { computeLayout } = await import('/src/lib/layout.ts')
    const results = []
    for (const count of [50, 200, 400]) {
      const doc = buildFixture({ text: '知识框架', children: Array.from({ length: count - 1 }, (_, i) => ({ text: `${i} 条件与推导${String(i * 13579).padStart(8, '0')} ${'需要核对前提并保留完整概念标题'.repeat(4)}` })) })
      for (const kind of ['logic', 'tree', 'org', 'fishbone', 'timeline'] as const) {
        doc.layout = kind
        const start = performance.now()
        const result = computeLayout(doc)
        results.push({ count, kind, milliseconds: Number((performance.now() - start).toFixed(2)), nodes: result.nodes.size })
      }
    }
    return results
  })
  for (const result of measurements) expect(result.nodes).toBe(result.count)
  const path = testInfo.outputPath('layout-performance.json')
  await writeFile(path, JSON.stringify(measurements, null, 2))
  await testInfo.attach('mindmap-layout-performance.json', { path, contentType: 'application/json' })
})
