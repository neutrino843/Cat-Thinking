import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ExtractedDocument, SourcePageSpan } from '../documentExtractors'
import { normalizeSourceText } from '../documentExtractors'

const MAX_PDF_PAGES = 200

interface PdfTextItemLike {
  str: string
  hasEOL?: boolean
  transform?: number[]
}

function isTextItem(value: unknown): value is PdfTextItemLike {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).str === 'string'
}

/** 按 PDF 文本项的 y 坐标和 hasEOL 标记恢复行，避免所有词粘成一个段落。 */
export function pdfItemsToText(items: unknown[]): string {
  const lines: string[] = []
  let line = ''
  let lastY: number | null = null
  const flush = () => {
    const value = line.replace(/\s+/g, ' ').trim()
    if (value) lines.push(value)
    line = ''
  }
  for (const raw of items) {
    if (!isTextItem(raw)) continue
    const y = Array.isArray(raw.transform) && typeof raw.transform[5] === 'number' ? raw.transform[5] : null
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) flush()
    const value = raw.str.trim()
    if (value) line += (line ? ' ' : '') + value
    if (raw.hasEOL) flush()
    if (y !== null) lastY = y
  }
  flush()
  return lines.join('\n')
}

/** 仅移除页首/页尾的纯页码或 Page/第N页标记，正文中的数字保持不变。 */
export function cleanPdfPageText(input: string): string {
  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean)
  const isPageNumber = (value: string) => /^(?:page\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?$/i.test(value) || /^第\s*\d{1,4}\s*页$/.test(value)
  if (lines[0] && isPageNumber(lines[0])) lines.shift()
  if (lines.at(-1) && isPageNumber(lines.at(-1) ?? '')) lines.pop()
  return normalizeSourceText(lines.join('\n'))
}

export async function extractPdf(file: File): Promise<ExtractedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('PDF 文件签名无效')
  }

  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: bytes })
  const warnings: string[] = []
  try {
    const pdf = await task.promise
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES)
    if (pdf.numPages > MAX_PDF_PAGES) warnings.push(`PDF 共 ${pdf.numPages} 页，当前只提取前 ${MAX_PDF_PAGES} 页`)
    const pageTexts: string[] = []
    let emptyPages = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = cleanPdfPageText(pdfItemsToText(content.items))
        if (!text) emptyPages++
        pageTexts.push(text)
      } finally {
        page.cleanup()
      }
    }

    const pageSpans: SourcePageSpan[] = []
    let text = ''
    pageTexts.forEach((pageText, index) => {
      if (!pageText) return
      if (text) text += '\n\n'
      const start = text.length
      text += pageText
      pageSpans.push({ page: index + 1, start, end: text.length })
    })
    text = normalizeSourceText(text)
    if (!text) throw new Error('PDF 未提取到文本，可能是扫描件；当前版本尚未内建 OCR')
    if (emptyPages > 0) warnings.push(`${emptyPages} 页未提取到文本，可能包含扫描页或纯图片`)
    return {
      kind: 'pdf',
      structure: 'text',
      text,
      extractor: `cat-pdfjs-${pdfjs.version ?? '4'}-v1`,
      titleHint: text.split('\n').find((line) => line.trim() && line.trim().length <= 120)?.trim(),
      pageSpans,
      warnings,
    }
  } catch (reason) {
    if (reason instanceof Error && /PDF 未提取到文本|PDF 文件签名/.test(reason.message)) throw reason
    const message = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`PDF 解析失败：${message}`, { cause: reason })
  } finally {
    await task.destroy().catch(() => {})
  }
}
