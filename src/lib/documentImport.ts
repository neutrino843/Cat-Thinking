import { ANALYSIS_LIMITS } from '@cat-thinking/analysis-contracts'
import type { DocData, MindNodeData, SourceDocument } from '../types'
import { documentTitleFallback, isDocumentMetadata } from './importTitles'
import { explicitPlainHeading, numberedHeadingContext, type PlainHeading } from './importHeadings'
import {
  extractDocument,
  type ImportProgressListener,
  type SourcePageSpan,
  type SourceStructureBlock,
} from './documentExtractors'

export {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_CHARS,
  normalizeSourceText,
} from './documentExtractors'
export type { ImportProgress, ImportProgressListener } from './documentExtractors'
export const MAX_DRAFT_NODES = 400
export const MAX_SOURCE_LOCATORS = ANALYSIS_LIMITS.maxSourceLocators

interface SourceEntry {
  kind: 'heading' | 'paragraph' | 'list'
  level: number
  text: string
  start: number
  end: number
  headingKey?: string
  parentHeadingKey?: string
}

export interface DocumentImportStats {
  charCount: number
  sectionCount: number
  paragraphCount: number
  nodeCount: number
}

export interface DocumentImportDraft {
  doc: DocData
  source: SourceDocument
  stats: DocumentImportStats
  warnings: string[]
  preview: string[]
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

interface LineInfo {
  text: string
  start: number
  end: number
}

function indexedLines(text: string): LineInfo[] {
  const raw = text.split('\n')
  const lines: LineInfo[] = []
  let offset = 0
  for (const line of raw) {
    lines.push({ text: line, start: offset, end: offset + line.length })
    offset += line.length + 1
  }
  return lines
}

function looksLikePlainHeading(text: string): boolean {
  const value = text.trim()
  if (isDocumentMetadata(value)) return false
  if (!value || value.length > 60 || value.includes('\n') || /[。！？.!?；;：:]$/.test(value)) return false
  // Explicit numeric headings are handled with their document context before this fallback.
  if (/^\d/.test(value)) return false
  if (/^第[0-9一二三四五六七八九十百千]+[章节篇部卷]/.test(value)) return true
  if (/^(?:\d+(?:[.．]\d+)*|[一二三四五六七八九十]+)[、.．)）\s]+\S+/.test(value)) return true
  if (/^[A-Z][A-Z\d _-]{2,}$/.test(value)) return true
  return value.length <= 32 && !/[。！？.!?；;：:]$/.test(value)
}

function parseEntries(text: string, structure: 'text' | 'markdown', inferPlainHeadings: boolean): SourceEntry[] {
  const lines = indexedLines(text)
  const numberedCandidates = inferPlainHeadings ? lines.map(({ text: value }) =>
    explicitPlainHeading(value.replace(/^\s*#{1,6}\s+/, ''))).filter((heading): heading is PlainHeading => heading !== null) : []
  const hasNumberingContext = numberedHeadingContext(numberedCandidates)
  const entries: SourceEntry[] = []
  let paragraph: LineInfo[] = []
  let inFence = false

  const flush = () => {
    if (!paragraph.length) return
    const value = paragraph.map((line) => line.text).join('\n').trim()
    if (value) {
      const singleLine = paragraph.length === 1
      const heading = structure === 'text' && singleLine && looksLikePlainHeading(value)
      entries.push({
        kind: heading ? 'heading' : 'paragraph',
        level: heading ? 1 : 0,
        text: value,
        start: paragraph[0].start,
        end: paragraph[paragraph.length - 1].end,
      })
    }
    paragraph = []
  }

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (structure === 'markdown' && /^```|^~~~/.test(trimmed)) {
      inFence = !inFence
      paragraph.push(line)
      continue
    }
    if (structure === 'markdown' && !inFence) {
      const heading = line.text.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (heading) {
        flush()
        const numbered = inferPlainHeadings ? explicitPlainHeading(heading[2]) : null
        entries.push({
          kind: 'heading',
          level: heading[1].length,
          text: heading[2].trim(),
          start: line.start,
          end: line.end,
          ...(numbered?.headingKey ? { headingKey: numbered.headingKey } : {}),
        })
        continue
      }
    }
    const list = !inFence ? line.text.match(/^(\s*)(?:[-+*•◦▪]|\d+[.)、])\s+(.+)$/) : null
    if (list && !(inferPlainHeadings && /^\s*\d/.test(line.text) && explicitPlainHeading(line.text))) {
      flush()
      entries.push({ kind: 'list', level: Math.min(12, Math.floor(list[1].replace(/\t/g, '    ').length / 2)),
        text: list[2], start: line.start, end: line.end })
      continue
    }
    const explicitHeading = inferPlainHeadings && !inFence ? explicitPlainHeading(line.text) : null
    if (explicitHeading && hasNumberingContext(explicitHeading)) {
      flush()
      entries.push({ kind: 'heading', text: trimmed, start: line.start, end: line.end, ...explicitHeading })
      continue
    }
    if (!trimmed && !inFence) flush()
    else paragraph.push(line)
  }
  flush()
  return entries
}

function plainLabel(value: string): string {
  return value
    .replace(/^```[^\n]*|```$/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)、]\s+)/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function labelForParagraph(value: string, index: number): string {
  const clean = plainLabel(value) || '未命名段落'
  if (clean.length <= 80) return clean
  const firstSentence = clean.match(/^(.{4,80}?[。！？.!?])/)?.[1]
  return firstSentence || `原文段落 ${index + 1}`
}

function deriveTitle(entries: SourceEntry[], fallback: string, structure: 'text' | 'markdown'): string {
  if (structure === 'markdown') {
    const h1 = entries.find((entry) => entry.kind === 'heading' && entry.level === 1 && !isDocumentMetadata(entry.text))
    if (h1?.text.trim()) return plainLabel(h1.text)
  }
  const first = entries.find((entry) => !isDocumentMetadata(entry.text))
  if (first?.kind === 'heading' && first.text.trim()) return plainLabel(first.text)
  return fallback
}

function buildDraft(
  text: string,
  structure: 'text' | 'markdown',
  file: File,
  pageSpans: SourcePageSpan[],
  titleHint?: string,
  inferPlainHeadings = structure === 'text',
  blocks?: SourceStructureBlock[],
): Omit<DocumentImportDraft, 'source'> & {
  sourceId: string
  anchors: SourceDocument['anchors']
  locators: NonNullable<SourceDocument['locators']>
} {
  const entries: SourceEntry[] = blocks?.length ? blocks.map((block) => {
    if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 0 || block.end > text.length || block.end <= block.start) throw new Error('文档结构的原文定位无效')
    const value = block.label ?? text.slice(block.start, block.end)
    const numbered = block.kind === 'heading' ? explicitPlainHeading(value) : null
    return { ...block, text: value, ...(numbered?.headingKey ? { headingKey: numbered.headingKey, parentHeadingKey: numbered.parentHeadingKey } : {}) }
  }) : parseEntries(text, structure, inferPlainHeadings)
  if (blocks?.length) {
    const candidates = entries.map((entry) => explicitPlainHeading(entry.text)).filter((heading): heading is PlainHeading => !!heading)
    const context = numberedHeadingContext(candidates)
    for (const entry of entries) {
      const heading = explicitPlainHeading(entry.text)
      if (entry.kind !== 'list' && heading && context(heading)) Object.assign(entry, heading, { kind: 'heading' })
    }
  }
  if (!entries.length) throw new Error('文档中没有可提取的文本内容')

  const now = Date.now()
  const docId = uid()
  const rootId = uid()
  const sourceId = uid()
  const hint = titleHint?.trim()
  const title = hint && !isDocumentMetadata(hint) ? plainLabel(hint) : deriveTitle(entries, documentTitleFallback(file.name), structure)
  const root: MindNodeData = { id: rootId, parent: null, children: [], text: title }
  const nodes: Record<string, MindNodeData> = { [rootId]: root }
  const anchors: SourceDocument['anchors'] = []
  const stack: { level: number; id: string; path: string; headingKey?: string }[] = []
  const warnings: string[] = []
  let sectionCount = 0
  let paragraphCount = 0
  let truncated = false
  const listStack: { level: number; id: string; path?: string }[] = []

  const pageForOffset = (offset: number): number | undefined => {
    if (!pageSpans.length) return undefined
    const span = pageSpans.find((item) => offset >= item.start && offset < item.end)
    return span?.page
  }

  const locatorStack: { level: number; title: string; headingKey?: string }[] = []
  const entryLocators: NonNullable<SourceDocument['locators']> = entries.map((entry) => {
    if (entry.kind === 'heading') {
      while ((locatorStack.at(-1)?.level ?? -1) >= entry.level) {
        locatorStack.pop()
      }
      if (entry.parentHeadingKey) {
        while (locatorStack.length && locatorStack.at(-1)?.headingKey !== entry.parentHeadingKey) locatorStack.pop()
      }
      locatorStack.push({ level: entry.level, title: plainLabel(entry.text), headingKey: entry.headingKey })
    }
    const page = pageForOffset(entry.start)
    return {
      start: entry.start,
      end: entry.end,
      titlePath: locatorStack.map(({ title: pathPart }) => pathPart).filter(Boolean),
      ...(page === undefined ? {} : { page }),
    }
  })
  const pageLocators: NonNullable<SourceDocument['locators']> = pageSpans
    .filter((span) => span.end > span.start)
    .map((span) => ({ start: span.start, end: span.end, titlePath: [], page: span.page }))
  const allLocators = [...pageLocators, ...entryLocators]
    .sort((left, right) => left.start - right.start || left.end - right.end || (left.page ?? 0) - (right.page ?? 0))
  const locators = allLocators.slice(0, MAX_SOURCE_LOCATORS)
  if (allLocators.length > MAX_SOURCE_LOCATORS) {
    warnings.push(`来源定位元数据最多保留 ${MAX_SOURCE_LOCATORS} 条；完整原文仍可用于后续分析`)
  }

  const addNode = (entry: SourceEntry, parentId: string, label: string, locator?: string): string | null => {
    if (Object.keys(nodes).length >= MAX_DRAFT_NODES) {
      truncated = true
      return null
    }
    const id = uid()
    nodes[id] = {
      id,
      parent: parentId,
      children: [],
      text: label,
    }
    nodes[parentId].children.push(id)
    const page = pageForOffset(entry.start)
    anchors.push({
      nodeId: id,
      start: entry.start,
      end: entry.end,
      ...(locator ? { locator } : {}),
      ...(page ? { page } : {}),
    })
    return id
  }

  for (const entry of entries) {
    if (truncated) break
    if (isDocumentMetadata(entry.text)) continue
    if (entry.kind === 'heading') {
      listStack.length = 0
      const headingText = plainLabel(entry.text) || '未命名章节'
      // Markdown 的首个 H1 通常就是文档标题，由根节点承载，避免重复一层。
      if (!stack.length && entry.level === 1 && headingText === title) {
        stack.push({ level: 1, id: rootId, path: title, headingKey: entry.headingKey })
        const page = pageForOffset(entry.start)
        anchors.push({
          nodeId: rootId,
          start: entry.start,
          end: entry.end,
          locator: title,
          ...(page ? { page } : {}),
        })
        continue
      }
      while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop()
      if (entry.parentHeadingKey) {
        while (stack.length && stack.at(-1)?.headingKey !== entry.parentHeadingKey) stack.pop()
      }
      const parent = stack[stack.length - 1]
      const parentId = parent?.id ?? rootId
      const path = parent ? `${parent.path} / ${headingText}` : headingText
      const id = addNode(entry, parentId, headingText, path)
      if (!id) break
      stack.push({ level: entry.level, id, path, headingKey: entry.headingKey })
      sectionCount++
      continue
    }

    if (entry.kind === 'list') {
      while (listStack.length && (listStack.at(-1)?.level ?? -1) >= entry.level) listStack.pop()
      const parent = listStack.at(-1) ?? stack.at(-1)
      const id = addNode(entry, parent?.id ?? rootId, labelForParagraph(entry.text, paragraphCount), parent?.path)
      if (!id) break
      listStack.push({ id, level: entry.level, path: parent?.path })
      paragraphCount++
      continue
    }
    listStack.length = 0
    const parent = stack[stack.length - 1]
    const label = labelForParagraph(entry.text, paragraphCount)
    const id = addNode(entry, parent?.id ?? rootId, label, parent?.path)
    if (!id) break
    paragraphCount++
  }

  root.children.forEach((id, index) => {
    nodes[id] = { ...nodes[id], color: `b${index % 6}` }
  })

  if (truncated) {
    warnings.push(`导图草稿最多生成 ${MAX_DRAFT_NODES} 个节点；完整原文仍已保存，可供后续分析使用`)
  }
  if (!sectionCount) warnings.push('材料的标题层级线索较少，当前为本地结构草稿；请核对层级，必要时主动整理概念图。')

  const doc: DocData = {
    version: 3,
    id: docId,
    title,
    rootId,
    layout: 'logic',
    nodes,
    createdAt: now,
    updatedAt: now,
  }

  return {
    doc,
    sourceId,
    anchors,
    locators,
    stats: {
      charCount: text.length,
      sectionCount,
      paragraphCount,
      nodeCount: Object.keys(nodes).length,
    },
    warnings,
    preview: root.children.slice(0, 8).map((id) => nodes[id].text),
  }
}

/** Cat-Thinking 内建文档导入入口。所有解析均在浏览器内完成，重型格式按需加载。 */
export async function prepareDocumentImport(
  file: File,
  onProgress?: ImportProgressListener,
): Promise<DocumentImportDraft> {
  const extracted = await extractDocument(file, onProgress)
  onProgress?.({ phase: 'structuring', ratio: 0.92 })
  const built = buildDraft(
    extracted.text,
    extracted.structure,
    file,
    extracted.pageSpans,
    extracted.titleHint,
    extracted.structure === 'text' || extracted.kind === 'docx' || extracted.kind === 'pptx',
    extracted.blocks,
  )
  onProgress?.({ phase: 'structuring', ratio: 1 })
  const source: SourceDocument = {
    version: 1,
    id: built.sourceId,
    docId: built.doc.id,
    name: file.name.replace(/^.*[\\/]/, ''),
    kind: extracted.kind,
    mime: file.type || (extracted.kind === 'markdown' ? 'text/markdown' : 'text/plain'),
    size: file.size,
    lastModified: file.lastModified,
    importedAt: Date.now(),
    extractor: extracted.extractor,
    text: extracted.text,
    charCount: extracted.text.length,
    anchors: built.anchors,
    locators: built.locators,
  }
  return {
    doc: built.doc,
    source,
    stats: built.stats,
    warnings: [...extracted.warnings, ...built.warnings],
    preview: built.preview,
  }
}

/** Rebuild from the saved immutable text; never claim to recover missing file layout. */
export function prepareSavedSourceImport(source: SourceDocument): DocumentImportDraft {
  if (!source.text.trim() || source.charCount !== source.text.length) throw new Error('保存的原文不完整，无法重新整理。')
  const pages = new Map<number, SourcePageSpan>()
  for (const locator of source.locators ?? source.anchors.map((anchor) => ({ ...anchor, titlePath: [] }))) {
    if (!locator.page) continue
    const previous = pages.get(locator.page)
    pages.set(locator.page, { page: locator.page, start: Math.min(previous?.start ?? locator.start, locator.start), end: Math.max(previous?.end ?? locator.end, locator.end) })
  }
  const built = buildDraft(source.text, ['markdown', 'docx', 'pptx'].includes(source.kind) ? 'markdown' : 'text',
    new File([], source.name), [...pages.values()].sort((a, b) => a.start - b.start), undefined, true)
  return { ...built, source: { ...source, id: built.sourceId, docId: built.doc.id, anchors: built.anchors, locators: built.locators,
    importedAt: Date.now(), extractor: `${source.extractor}:saved-text-v1` },
    warnings: [...built.warnings, '仅整理已保存的文字；图示和版式请对照原课件。原图、个人笔记和学习记录保留，不自动迁移到新图。'] }
}
