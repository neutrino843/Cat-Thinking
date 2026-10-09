import { strFromU8, unzip } from 'fflate'
import type { ExtractedDocument } from '../documentExtractors'
import { normalizeSourceText } from '../documentExtractors'

const MAX_ZIP_ENTRIES = 5_000
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024
const MAX_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 200

interface ZipEntryMeta {
  name: string
  compressedSize: number
  uncompressedSize: number
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function safeArchivePath(name: string): boolean {
  const normalized = name.replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  return !normalized.split('/').some((part) => part === '..')
}

/**
 * 解压前读取 ZIP 中央目录，阻断路径穿越、加密包、异常条目数和 zip bomb。
 * DOCX 内容只在内存中读取，从不把归档路径写入文件系统。
 */
export function inspectDocxArchive(bytes: Uint8Array): ZipEntryMeta[] {
  if (bytes.length < 22) throw new Error('DOCX 文件结构不完整')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minOffset = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (u32(view, offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('DOCX 缺少 ZIP 中央目录')
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) throw new Error('不支持分卷 DOCX')

  const entryCount = u16(view, eocd + 10)
  const directorySize = u32(view, eocd + 12)
  const directoryOffset = u32(view, eocd + 16)
  if (entryCount === 0 || entryCount > MAX_ZIP_ENTRIES) throw new Error('DOCX 归档条目数量异常')
  if (directoryOffset + directorySize > eocd) throw new Error('DOCX 中央目录范围非法')

  const entries: ZipEntryMeta[] = []
  let offset = directoryOffset
  let expandedTotal = 0
  let compressedTotal = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || u32(view, offset) !== 0x02014b50) throw new Error('DOCX 中央目录条目损坏')
    const flags = u16(view, offset + 8)
    const method = u16(view, offset + 10)
    const compressedSize = u32(view, offset + 20)
    const uncompressedSize = u32(view, offset + 24)
    const nameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > eocd) throw new Error('DOCX 中央目录路径范围非法')
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (!safeArchivePath(name)) throw new Error(`DOCX 包含不安全路径：${name || '(empty)'}`)
    if ((flags & 1) !== 0) throw new Error('不支持加密 DOCX')
    if (method !== 0 && method !== 8) throw new Error(`DOCX 使用了不支持的压缩方式：${method}`)
    if (uncompressedSize > MAX_SINGLE_ENTRY_BYTES) throw new Error(`DOCX 条目过大：${name}`)
    expandedTotal += uncompressedSize
    compressedTotal += compressedSize
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new Error('DOCX 解压后内容超过 32MB 安全限制')
    entries.push({ name, compressedSize, uncompressedSize })
    offset = next
  }
  if (!entries.some((entry) => entry.name === 'word/document.xml')) throw new Error('不是有效的 DOCX：缺少 word/document.xml')
  if (compressedTotal > 0 && expandedTotal / compressedTotal > MAX_COMPRESSION_RATIO) {
    throw new Error('DOCX 压缩比异常，已阻止可能的 zip bomb')
  }
  return entries
}

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => {
      if (error) reject(new Error(`DOCX 解压失败：${error.message}`))
      else resolve(data)
    })
  })
}

function localName(value: Element): string {
  return (value.localName || value.tagName).replace(/^.*:/, '')
}

function elements(root: ParentNode, name: string): Element[] {
  const expected = name.toLowerCase()
  return Array.from(root.querySelectorAll('*')).filter((element) => localName(element).toLowerCase() === expected)
}

function attribute(element: Element | undefined, name: string): string {
  if (!element) return ''
  const expected = name.toLowerCase()
  const found = Array.from(element.attributes).find((item) => (
    item.localName || item.name
  ).replace(/^.*:/, '').toLowerCase() === expected)
  return found?.value ?? ''
}

function parseXml(xml: string, label: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`${label} 包含不允许的 XML 实体声明`)
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (elements(document, 'parsererror').length) throw new Error(`${label} XML 已损坏`)
  return document
}

function inferHeadingLevel(value: string): number | null {
  const matched = value.match(/(?:heading|标题)\s*([1-6])/i)
  return matched ? Number(matched[1]) : null
}

function styleHeadingLevels(stylesXml?: string): Map<string, number> {
  const result = new Map<string, number>()
  if (!stylesXml) return result
  const document = parseXml(stylesXml, 'DOCX styles.xml')
  const basedOn = new Map<string, string>()
  for (const style of elements(document, 'style')) {
    if (attribute(style, 'type') && attribute(style, 'type') !== 'paragraph') continue
    const id = attribute(style, 'styleId')
    if (!id) continue
    const name = attribute(elements(style, 'name')[0], 'val')
    const outline = Number(attribute(elements(style, 'outlineLvl')[0], 'val'))
    const level = Number.isInteger(outline) && outline >= 0 && outline < 6
      ? outline + 1
      : inferHeadingLevel(`${id} ${name}`)
    if (level) result.set(id, level)
    const parent = attribute(elements(style, 'basedOn')[0], 'val')
    if (parent) basedOn.set(id, parent)
  }
  for (const id of basedOn.keys()) {
    let current = id
    const visited = new Set<string>()
    while (!result.has(id) && basedOn.has(current) && !visited.has(current)) {
      visited.add(current)
      current = basedOn.get(current) ?? ''
      const inherited = result.get(current)
      if (inherited) result.set(id, inherited)
    }
  }
  return result
}

function paragraphText(paragraph: Element): string {
  const parts: string[] = []
  const walk = (element: Element) => {
    const name = localName(element)
    if (name === 't') parts.push(element.textContent ?? '')
    else if (name === 'tab') parts.push('\t')
    else if (name === 'br' || name === 'cr') parts.push('\n')
    for (const child of Array.from(element.children)) walk(child)
  }
  walk(paragraph)
  return parts.join('').replace(/[ \t]+/g, ' ').trim()
}

function paragraphHeadingLevel(paragraph: Element, styles: Map<string, number>): number | null {
  const styleId = attribute(elements(paragraph, 'pStyle')[0], 'val')
  return styles.get(styleId) ?? inferHeadingLevel(styleId)
}

function tableText(table: Element): string[] {
  const rows: string[] = []
  for (const row of elements(table, 'tr')) {
    const cells = elements(row, 'tc').map((cell) =>
      elements(cell, 'p').map(paragraphText).filter(Boolean).join(' / '),
    )
    if (cells.some(Boolean)) rows.push(cells.join(' | '))
  }
  return rows
}

export function docxXmlToStructuredText(documentXml: string, stylesXml?: string): string {
  const document = parseXml(documentXml, 'DOCX document.xml')
  const body = elements(document, 'body')[0]
  if (!body) throw new Error('DOCX 缺少正文 body')
  const styles = styleHeadingLevels(stylesXml)
  const blocks: string[] = []

  const visit = (element: Element) => {
    const name = localName(element)
    if (name === 'p') {
      const text = paragraphText(element)
      if (!text) return
      const level = paragraphHeadingLevel(element, styles)
      blocks.push(level ? `${'#'.repeat(level)} ${text}` : text)
      return
    }
    if (name === 'tbl') {
      const rows = tableText(element)
      if (rows.length) blocks.push(['表格', ...rows].join('\n'))
      return
    }
    for (const child of Array.from(element.children)) visit(child)
  }
  for (const child of Array.from(body.children)) visit(child)
  return normalizeSourceText(blocks.join('\n\n'))
}

export async function extractDocx(file: File): Promise<ExtractedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  inspectDocxArchive(bytes)
  const archive = await unzipAsync(bytes)
  const documentBytes = archive['word/document.xml']
  if (!documentBytes) throw new Error('DOCX 正文缺失')
  const stylesBytes = archive['word/styles.xml']
  const text = docxXmlToStructuredText(
    strFromU8(documentBytes),
    stylesBytes ? strFromU8(stylesBytes) : undefined,
  )
  if (!text) throw new Error('DOCX 中没有可提取的文本内容')
  return {
    kind: 'docx',
    structure: 'markdown',
    text,
    extractor: 'cat-docx-ooxml-v1',
    pageSpans: [],
    warnings: stylesBytes ? [] : ['DOCX 未包含样式表，标题层级可能不完整'],
  }
}
