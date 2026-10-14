import { strFromU8 } from 'fflate'
import type { ExtractedDocument } from '../documentExtractors'
import { normalizeSourceText } from '../documentExtractors'
import type { ImportProgressListener } from '../documentExtractors'
import { attribute, elements, localName, parseOoxmlXml, unzipOoxml } from './ooxmlShared'

function inferHeadingLevel(value: string): number | null {
  const matched = value.match(/(?:heading|标题)\s*([1-6])/i)
  return matched ? Number(matched[1]) : null
}

function styleHeadingLevels(stylesXml?: string): Map<string, number> {
  const result = new Map<string, number>()
  if (!stylesXml) return result
  const document = parseOoxmlXml(stylesXml, 'DOCX styles.xml')
  const basedOn = new Map<string, string>()
  for (const style of elements(document, 'style')) {
    if (attribute(style, 'type') && attribute(style, 'type') !== 'paragraph') continue
    const id = attribute(style, 'styleId')
    if (!id) continue
    const name = attribute(elements(style, 'name')[0], 'val')
    const outlineValue = attribute(elements(style, 'outlineLvl')[0], 'val')
    const outline = Number(outlineValue)
    const level = /^[0-5]$/.test(outlineValue)
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
  const document = parseOoxmlXml(documentXml, 'DOCX document.xml')
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

export async function extractDocx(file: File, onProgress?: ImportProgressListener): Promise<ExtractedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress?.({ phase: 'parsing', ratio: 0.3, detail: '正在解压 DOCX' })
  const archive = await unzipOoxml(bytes, 'DOCX', ['word/document.xml'])
  const documentBytes = archive['word/document.xml']
  if (!documentBytes) throw new Error('DOCX 正文缺失')
  const stylesBytes = archive['word/styles.xml']
  onProgress?.({ phase: 'parsing', ratio: 0.6, detail: '正在解析 DOCX 结构' })
  const text = docxXmlToStructuredText(
    strFromU8(documentBytes),
    stylesBytes ? strFromU8(stylesBytes) : undefined,
  )
  if (!text) throw new Error('DOCX 中没有可提取的文本内容')
  onProgress?.({ phase: 'parsing', ratio: 0.85 })
  return {
    kind: 'docx',
    structure: 'markdown',
    text,
    extractor: 'cat-docx-ooxml-v2',
    pageSpans: [],
    warnings: stylesBytes ? [] : ['DOCX 未包含样式表，标题层级可能不完整'],
  }
}
