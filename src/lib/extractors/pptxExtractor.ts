import { strFromU8 } from 'fflate'
import type { ExtractedDocument, SourcePageSpan } from '../documentExtractors'
import { normalizeSourceText } from '../documentExtractors'
import type { ImportProgressListener } from '../documentExtractors'
import { attribute, elements, localName, parseOoxmlXml, relationshipId, unzipOoxml } from './ooxmlShared'

const MAX_SLIDES = 400
const PRESENTATION_ENTRY = 'ppt/presentation.xml'
const PRESENTATION_RELS_ENTRY = 'ppt/_rels/presentation.xml.rels'
const SLIDE_PATH_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/

export interface PptxSlideContent {
  title: string | null
  lines: string[]
  items: { text: string; level: number; list: boolean }[]
}

/** 解析 presentation rels，得到 rId → 幻灯片 ZIP 路径映射（Relationship 属性不带命名空间前缀）。 */
export function parsePresentationRels(relsXml?: string): Map<string, string> {
  const targets = new Map<string, string>()
  if (!relsXml) return targets
  const rels = parseOoxmlXml(relsXml, 'PPTX presentation rels')
  for (const relationship of elements(rels, 'Relationship')) {
    const id = attribute(relationship, 'Id')
    const target = attribute(relationship, 'Target')
    if (id && target) targets.set(id, target)
  }
  return targets
}

/**
 * 解析 presentation.xml 的 sldIdLst + rels，返回幻灯片 ZIP 路径的真实播放顺序。
 * 注意：happy-dom 等测试环境会丢弃带命名空间前缀的 r:id 属性，该路径只能在真实浏览器中生效；
 * 单测覆盖 rels 目标映射与文件名回退，sldIdLst 顺序由 e2e（真实 Chromium）验证。
 */
export function slideOrderFromPresentation(presentationXml: string, relsXml?: string): string[] | null {
  try {
    const presentation = parseOoxmlXml(presentationXml, 'PPTX presentation.xml')
    const targets = parsePresentationRels(relsXml)
    const order: string[] = []
    for (const sldId of elements(presentation, 'sldId')) {
      const rid = relationshipId(sldId)
      const target = targets.get(rid)
      if (!target) return null
      const normalized = target.startsWith('/') ? target.slice(1) : `ppt/${target.replaceAll('\\', '/')}`
      order.push(normalized)
    }
    return order.length ? order : null
  } catch {
    return null
  }
}

function textBodyLines(textBody: Element): PptxSlideContent['items'] {
  const lines: PptxSlideContent['items'] = []
  for (const paragraph of elements(textBody, 'p')) {
    const parts: string[] = []
    const walk = (element: Element) => {
      const name = localName(element)
      if (name === 't') parts.push(element.textContent ?? '')
      else if (name === 'br') parts.push('\n')
      for (const child of Array.from(element.children)) walk(child)
    }
    walk(paragraph)
    for (const line of parts.join('').split('\n')) {
      const value = line.replace(/[ \t]+/g, ' ').trim()
      const properties = elements(paragraph, 'pPr')[0]
      const rawLevel = attribute(properties, 'lvl')
      const level = /^\d$/.test(rawLevel) ? Math.min(8, Number(rawLevel)) : 0
      const list = !elements(paragraph, 'buNone').length && (rawLevel !== '' || !!elements(paragraph, 'buChar').length || !!elements(paragraph, 'buAutoNum').length)
      if (value) lines.push({ text: value, level, list })
    }
  }
  return lines
}

/** 提取单张幻灯片：标题占位符 → 一级标题，其余文本框逐行 → 段落。 */
export function pptxSlideTexts(slideXml: string): PptxSlideContent {
  const slide = parseOoxmlXml(slideXml, 'PPTX slide')
  let title: string | null = null
  const lines: string[] = []
  const items: PptxSlideContent['items'] = []
  for (const shape of elements(slide, 'sp')) {
    const textBody = elements(shape, 'txBody')[0]
    if (!textBody) continue
    const shapeLines = textBodyLines(textBody)
    if (!shapeLines.length) continue
    const placeholder = elements(shape, 'ph')[0]
    const placeholderType = attribute(placeholder, 'type')
    if ((placeholderType === 'title' || placeholderType === 'ctrTitle') && title === null) {
      title = shapeLines.map((line) => line.text).join(' ')
    } else {
      lines.push(...shapeLines.map((line) => line.text))
      items.push(...shapeLines.map((line) => ({ ...line, list: line.list || placeholderType === 'body' })))
    }
  }
  return { title, lines, items }
}

export async function extractPptx(file: File, onProgress?: ImportProgressListener): Promise<ExtractedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress?.({ phase: 'parsing', ratio: 0.2, detail: '正在解压 PPTX' })
  const archive = await unzipOoxml(bytes, 'PPTX', ['[Content_Types].xml', PRESENTATION_ENTRY])

  const presentationBytes = archive[PRESENTATION_ENTRY]
  const relsBytes = archive[PRESENTATION_RELS_ENTRY]
  const warnings: string[] = []
  let slidePaths = presentationBytes
    ? slideOrderFromPresentation(strFromU8(presentationBytes), relsBytes ? strFromU8(relsBytes) : undefined)
    : null
  if (!slidePaths) {
    slidePaths = Object.keys(archive)
      .filter((name) => SLIDE_PATH_PATTERN.test(name))
      .sort((left, right) => {
        const leftIndex = left.match(SLIDE_PATH_PATTERN)
        const rightIndex = right.match(SLIDE_PATH_PATTERN)
        return Number(leftIndex?.[1]) - Number(rightIndex?.[1])
      })
    if (slidePaths.length) warnings.push('未读取到幻灯片播放顺序，已按文件名顺序解析')
  }
  if (!slidePaths.length) throw new Error('PPTX 中没有幻灯片，无法生成导图')
  if (slidePaths.length > MAX_SLIDES) {
    warnings.push(`PPTX 共 ${slidePaths.length} 张幻灯片，当前只提取前 ${MAX_SLIDES} 张`)
    slidePaths = slidePaths.slice(0, MAX_SLIDES)
  }

  const pageSpans: SourcePageSpan[] = []
  let text = ''
  let emptySlides = 0
  let firstTitle: string | undefined
  for (const [index, path] of slidePaths.entries()) {
    onProgress?.({
      phase: 'parsing',
      ratio: 0.25 + 0.6 * ((index + 1) / slidePaths.length),
      detail: `第 ${index + 1}/${slidePaths.length} 页`,
    })
    const slideBytes = archive[path]
    if (!slideBytes) {
      emptySlides++
      continue
    }
    const { title, items } = pptxSlideTexts(strFromU8(slideBytes))
    if (!title && !items.length) { emptySlides++; continue }
    if (title && firstTitle === undefined) firstTitle = title
    const slideText = normalizeSourceText([...(title ? [`${index === 0 ? '#' : '##'} ${title}`] : [`## 第 ${index + 1} 页`]),
      ...items.map((item) => item.list ? `${'  '.repeat(item.level)}- ${item.text}` : item.text)].join('\n\n'))
    if (!slideText) {
      emptySlides++
      continue
    }
    if (text) text += '\n\n'
    const start = text.length
    text += slideText
    pageSpans.push({ page: index + 1, start, end: text.length })
  }

  text = normalizeSourceText(text)
  if (!text) throw new Error('PPTX 未提取到文本，幻灯片可能全部为图片或空白页')
  if (emptySlides > 0) warnings.push(`${emptySlides} 张幻灯片未提取到文本，可能包含纯图片或空白页`)
  return {
    kind: 'pptx',
    structure: 'markdown',
    text,
    extractor: 'cat-pptx-ooxml-v1',
    pageSpans,
    warnings,
    ...(firstTitle ? { titleHint: firstTitle } : {}),
  }
}
