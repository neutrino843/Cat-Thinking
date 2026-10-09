import { test, expect, resetStore, waitForApp } from './helpers'
import { strToU8, zipSync } from 'fflate'

function minimalDocx(): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX 课程</w:t></w:r></w:p>
      <w:p><w:r><w:t>这是可编辑的正文节点。</w:t></w:r></w:p>
    </w:body></w:document>`
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
    </w:styles>`
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
  }))
}

function minimalPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 72 720 Td (PDF Heading) Tj 0 -30 Td (Editable PDF body.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

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
  await expect(page.locator('svg')).toContainText('第二章 协议')

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
  await expect(page.locator('svg')).toContainText('第二章 协议')
})

test('DOCX 在浏览器本地提取标题与正文并生成导图', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept*=".docx"]').setInputFiles({
    name: '课程.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: minimalDocx(),
  })

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('DOCX')
  await expect(dialog).toContainText('DOCX 课程')
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue('DOCX 课程')
  await expect(page.locator('svg')).toContainText('这是可编辑的正文节点。')
})

test('文本型 PDF 在浏览器本地提取并记录页码锚点', async ({ page }) => {
  await resetStore(page)
  await waitForApp(page)

  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
    name: 'lesson.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdf(),
  })

  const dialog = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await expect(dialog).toContainText('PDF')
  await expect(dialog).toContainText('PDF Heading')
  await dialog.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(page.locator('input.doc-title')).toHaveValue('PDF Heading')
  await expect(page.locator('svg')).toContainText('Editable PDF body.')

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
    return sources.flatMap((source) => source.anchors.map((anchor: { page?: number }) => anchor.page))
  })
  expect(pages).toContain(1)
})
