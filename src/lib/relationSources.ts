import { identifierSchema } from '@cat-thinking/analysis-contracts'
import type { DocData, RelationSourceReference, SourceDocument } from '../types'
import { sha256Hex } from '../analysis/fingerprint'

/** Optional v1 native metadata is a strict whitelist, bounded independently of a document tree. */
export function parseRelationSourceReferences(raw: unknown): RelationSourceReference[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('关系来源引用超过限制或格式无效')
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('关系来源引用格式无效')
    const reference = item as Record<string, unknown>
    if (Object.keys(reference).some((key) => !['version', 'sourceId', 'contentHash', 'start', 'end', 'page', 'locator'].includes(key))
      || reference.version !== 1 || !identifierSchema.safeParse(reference.sourceId).success
      || typeof reference.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.contentHash)
      || typeof reference.start !== 'number' || !Number.isInteger(reference.start) || reference.start < 0
      || typeof reference.end !== 'number' || !Number.isInteger(reference.end) || reference.end <= reference.start
      || reference.page !== undefined && (typeof reference.page !== 'number' || !Number.isInteger(reference.page) || reference.page < 1 || reference.page > 100_000)
      || reference.locator !== undefined && (typeof reference.locator !== 'string' || reference.locator.length > 500)) {
      throw new Error('关系来源引用身份、范围或版本无效')
    }
    return { version: 1, sourceId: reference.sourceId as string, contentHash: reference.contentHash, start: reference.start, end: reference.end,
      ...(reference.page === undefined ? {} : { page: reference.page as number }), ...(reference.locator === undefined ? {} : { locator: reference.locator as string }) }
  })
}

export function requireRelationSources(doc: DocData, sources: readonly SourceDocument[]): void {
  const sourceMap = new Map(sources.map((source) => [source.id, source]))
  for (const relation of doc.relations ?? []) for (const reference of parseRelationSourceReferences(relation.sourceRefs) ?? []) {
    const source = sourceMap.get(reference.sourceId)
    if (!source || source.docId !== doc.id || reference.end > source.text.length) throw new Error('关系来源引用指向缺失来源或越界区间')
  }
}

/** Native import saves verify content outside IndexedDB transactions. */
export async function verifyRelationSourceHashes(doc: DocData, sources: readonly SourceDocument[]): Promise<void> {
  requireRelationSources(doc, sources)
  const hashes = new Map<string, string>()
  for (const source of sources) if (source.contentHash !== undefined) {
    const hash = await sha256Hex(source.text)
    if (hash !== source.contentHash) throw new Error('来源副本原文已改变，无法保留有效引用')
    hashes.set(source.id, hash)
  }
  for (const relation of doc.relations ?? []) for (const reference of relation.sourceRefs ?? []) {
    let hash = hashes.get(reference.sourceId)
    if (!hash) {
      const source = sources.find((item) => item.id === reference.sourceId)
      if (!source) throw new Error('关系来源原文缺失')
      hash = await sha256Hex(source.text)
      hashes.set(reference.sourceId, hash)
    }
    if (hash !== reference.contentHash) throw new Error('关系来源原文已改变，无法保留有效引用')
  }
}
