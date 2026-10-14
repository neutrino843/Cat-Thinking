import { test, expect, resetStore, waitForApp } from './helpers'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface ExpectedFixtures {
  structuredPdf: { file: string; title: string; requiredText: string[]; anchorPages: number[] }
  scannedPdf: { file: string; errorContains: string }
  structuredDocx: { file: string; title: string; requiredText: string[] }
  structuredPptx: { file: string; title: string; requiredText: string[]; anchorPages: number[] }
  corruptPptx: { file: string; errorContains: string }
}

interface FixtureManifest {
  files: Record<string, { bytes: number; sha256: string }>
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'documents')
const expected = JSON.parse(readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8')) as ExpectedFixtures
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8')) as FixtureManifest

test('真实文档 fixture 与 manifest 的大小和 SHA-256 一致', () => {
  for (const [name, metadata] of Object.entries(manifest.files)) {
    const payload = readFileSync(path.join(fixtureDir, name))
    expect(payload.byteLength, name).toBe(metadata.bytes)
    expect(createHash('sha256').update(payload).digest('hex'), name).toBe(metadata.sha256)
  }
})

test('TXT 文档预检后生成可编辑导图并持久化来源', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({
    name: '计算机网络.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('第一章 网络基础\n\n网络连接设备并交换数据。\n\n第二章 协议\n\n协议约定通信规则。'),
  })

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('计算机网络.txt')
  await expect(dialog).toContainText('第一章 网络基础')
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 网络基础')
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 协议')

  const payload = await page.evaluate(async () => {
    const request = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sources'], 'readonly')
    const getAll = transaction.objectStore('sources').getAll()
    const sources = await new Promise<any[]>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result)
      getAll.onerror = () => reject(getAll.error)
    })
    database.close()
    return sources
  })
  expect(payload).toHaveLength(1)
  expect(payload[0].text).toContain('协议约定通信规则')

  await page.reload()
  await waitForApp(page)
  await expect(page.locator('input.doc-title')).toHaveValue('第一章 网络基础')
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 协议')
})

test('DOCX 在浏览器本地提取标题与正文并生成导图', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept*=".docx"]').setInputFiles(
    path.join(fixtureDir, expected.structuredDocx.file),
  )

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('DOCX')
  await expect(dialog).toContainText(expected.structuredDocx.title)
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue(expected.structuredDocx.title)
  await expect(page.locator('svg.canvas-svg')).toContainText('第一章 来源与引用')
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 可编辑导图')

  const sourceText = await page.evaluate(async () => {
    const request = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sources'], 'readonly')
    const getAll = transaction.objectStore('sources').getAll()
    const sources = await new Promise<any[]>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result)
      getAll.onerror = () => reject(getAll.error)
    })
    database.close()
    return sources[0]?.text ?? ''
  })
  for (const value of expected.structuredDocx.requiredText) expect(sourceText).toContain(value)
})

test('文本型 PDF 在浏览器本地提取并记录页码锚点', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(
    path.join(fixtureDir, expected.structuredPdf.file),
  )

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('PDF')
  await expect(dialog).toContainText(expected.structuredPdf.title)
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue(expected.structuredPdf.title)

  const pages = await page.evaluate(async () => {
    const request = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sources'], 'readonly')
    const getAll = transaction.objectStore('sources').getAll()
    const sources = await new Promise<any[]>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result)
      getAll.onerror = () => reject(getAll.error)
    })
    database.close()
    return {
      text: sources[0]?.text ?? '',
      pages: sources.flatMap((source) => source.anchors.map((anchor: { page?: number }) => anchor.page)),
    }
  })
  for (const value of expected.structuredPdf.requiredText) expect(pages.text).toContain(value)
  for (const pageNumber of expected.structuredPdf.anchorPages) expect(pages.pages).toContain(pageNumber)
})

test('扫描型 PDF 无文本层时给出 OCR 提示且不创建草稿', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const alertMessage = new Promise<string>((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message())
      await dialog.accept()
    })
  })
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(
    path.join(fixtureDir, expected.scannedPdf.file),
  )

  expect(await alertMessage).toContain(expected.scannedPdf.errorContains)
  await expect(page.getByRole('dialog', { name: '从文档生成可编辑导图' })).toHaveCount(0)
})

test('PPTX 在浏览器本地提取幻灯片标题、正文与页锚点', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(
    path.join(fixtureDir, expected.structuredPptx.file),
  )

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('PPTX')
  await expect(dialog).toContainText(expected.structuredPptx.title)
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue(expected.structuredPptx.title)
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 可编辑导图')

  const payload = await page.evaluate(async () => {
    const request = indexedDB.open('maosizhi')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sources'], 'readonly')
    const getAll = transaction.objectStore('sources').getAll()
    const sources = await new Promise<any[]>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result)
      getAll.onerror = () => reject(getAll.error)
    })
    database.close()
    return {
      text: sources[0]?.text ?? '',
      extractor: sources[0]?.extractor ?? '',
      pages: sources.flatMap((source) => source.anchors.map((anchor: { page?: number }) => anchor.page)),
    }
  })
  for (const value of expected.structuredPptx.requiredText) expect(payload.text).toContain(value)
  expect(payload.extractor).toBe('cat-pptx-ooxml-v1')
  expect(payload.text).not.toContain('演讲者备注')
  // fixture 的 sldIdLst 顺序被故意打乱（slide2 在前）；顺序断言证明解析走 rels 而非文件名回退
  expect(payload.text.indexOf('# 第二章 可编辑导图')).toBeLessThan(payload.text.indexOf('# 第一章 来源锚点'))
  for (const pageNumber of expected.structuredPptx.anchorPages) expect(payload.pages).toContain(pageNumber)

  await page.reload()
  await waitForApp(page)
  await expect(page.locator('input.doc-title')).toHaveValue(expected.structuredPptx.title)
})

test('损坏的 PPTX 给出友好提示且不创建草稿', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const alertMessage = new Promise<string>((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message())
      await dialog.accept()
    })
  })
  await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(
    path.join(fixtureDir, expected.corruptPptx.file),
  )

  expect(await alertMessage).toContain(expected.corruptPptx.errorContains)
  await expect(page.getByRole('dialog', { name: '从文档生成可编辑导图' })).toHaveCount(0)
})

test('多文件导入按队列逐个确认，失败不阻塞后续文件', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  const alertMessage = new Promise<string>((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message())
      await dialog.accept()
    })
  })
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles([
    { name: '第一章 排队验证.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 排队验证\n\n第一个文件正文。') },
    { name: 'broken.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from('PK\x03\x04not-a-zip') },
    { name: '第二章 排队验证.txt', mimeType: 'text/plain', buffer: Buffer.from('第二章 排队验证\n\n第二个文件正文。') },
  ])

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('第一章 排队验证.txt')
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()

  expect(await alertMessage).toContain('broken.pptx')

  await expect(dialog).toContainText('第二章 排队验证.txt')
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('svg.canvas-svg')).toContainText('第二章 排队验证')
})
