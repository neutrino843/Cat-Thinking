import { db } from '../store/db'
import type { DocData, SourceDocument } from '../types'
import type { CitationView } from './citationView'
import { sha256Hex } from './fingerprint'

export interface LocalSourceReference {
  key: string
  label: string
  sourceId: string
  start: number
  end: number
  contentHash?: string
  locator?: string
  page?: number
}
export const LOCAL_REFERENCE_LIMIT = 20

export function collectLocalSourceReferences(doc: Pick<DocData, 'relations'>, nodeId: string, sources: readonly SourceDocument[]): LocalSourceReference[] {
  const references: LocalSourceReference[] = []
  for (const source of sources.slice(0, 32)) {
    let examined = 0
    for (const anchor of source.anchors) {
      if (++examined > 200_000 || references.length >= LOCAL_REFERENCE_LIMIT) break
      if (anchor.nodeId !== nodeId) continue
      references.push({ key: `node:${source.id}:${anchor.start}:${anchor.end}`, label: '节点原文', sourceId: source.id, start: anchor.start, end: anchor.end,
        ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }), ...(anchor.locator === undefined ? {} : { locator: anchor.locator }), ...(anchor.page === undefined ? {} : { page: anchor.page }) })
    }
  }
  for (const relation of (doc.relations ?? []).slice(0, 1_000)) {
    if (relation.from !== nodeId && relation.to !== nodeId) continue
    for (const reference of (relation.sourceRefs ?? []).slice(0, LOCAL_REFERENCE_LIMIT)) {
      if (references.length >= LOCAL_REFERENCE_LIMIT) break
      references.push({ key: `relation:${relation.id}:${reference.sourceId}:${reference.start}:${reference.end}`, label: `关系原文${relation.label ? `：${relation.label.slice(0, 200)}` : ''}`,
        sourceId: reference.sourceId, start: reference.start, end: reference.end, contentHash: reference.contentHash,
        ...(reference.locator === undefined ? {} : { locator: reference.locator }), ...(reference.page === undefined ? {} : { page: reference.page }) })
    }
  }
  return [...new Map(references.map((reference) => [reference.key, reference])).values()]
}

/** Local copy inspection has no dependency on the origin document or a remote run. */
export async function resolveLocalSourceReference(docId: string, reference: LocalSourceReference, options: { offset?: number; full?: boolean } = {}): Promise<CitationView> {
  const source = await db.sources.get(reference.sourceId)
  if (!source || !await db.docs.get(docId) || source.docId !== docId || source.text.length !== source.charCount
    || !Number.isInteger(reference.start) || !Number.isInteger(reference.end) || reference.start < 0
    || reference.end <= reference.start || reference.end > source.text.length
    || reference.contentHash !== undefined && await sha256Hex(source.text) !== reference.contentHash) {
    throw new Error('本地原文副本已删除、改变或引用区间无效。')
  }
  const current = await db.sources.get(reference.sourceId)
  if (!current || current.text !== source.text || current.docId !== docId || !await db.docs.get(docId)) {
    throw new Error('本地原文在读取期间发生变化。')
  }
  const offset = options.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset >= reference.end - reference.start) throw new Error('原文阅读位置无效。')
  const visibleStart = reference.start + offset
  const visibleEnd = options.full ? reference.end : Math.min(reference.end, visibleStart + 4_000)
  return { name: source.name, location: `${reference.page ? `第 ${reference.page} 页 · ` : ''}${reference.locator ?? ''} 字符 ${reference.start}–${reference.end}`,
    before: offset ? '' : source.text.slice(Math.max(0, reference.start - 240), reference.start), quote: source.text.slice(visibleStart, visibleEnd),
    after: visibleEnd === reference.end ? source.text.slice(reference.end, reference.end + 240) : '', truncated: visibleEnd < reference.end }
}
