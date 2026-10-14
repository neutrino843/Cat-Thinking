import type { SourceCitationV1, SourceSnapshotV1 } from '@cat-thinking/analysis-contracts'
import type { SourceDocument } from '../types'
import { sha256Hex } from './fingerprint'

export interface CitationView { name: string; location: string; before: string; quote: string; after: string; truncated: boolean }

export async function resolveCitationView(docId: string, source: SourceDocument | undefined, snapshot: SourceSnapshotV1 | undefined, citation: SourceCitationV1): Promise<CitationView> {
  if (!source || !snapshot || source.docId !== docId || source.id !== citation.sourceId || snapshot.sourceId !== source.id
    || source.text.length !== snapshot.charCount || citation.start < (snapshot.selectedRange?.start ?? 0)
    || citation.end > (snapshot.selectedRange?.end ?? source.text.length) || citation.end <= citation.start
    || await sha256Hex(source.text) !== snapshot.contentHash) throw new Error('原文已改变或引用范围无效，请恢复任务检查来源。')
  const visibleEnd = Math.min(citation.end, citation.start + 4_000)
  const locator = source.locators?.find((item) => item.start <= citation.start && item.end >= citation.end)
  return { name: source.name,
    location: `${citation.page ?? locator?.page ? `第 ${citation.page ?? locator?.page} 页 · ` : ''}${citation.locator ?? locator?.titlePath.join(' / ') ?? ''} 字符 ${citation.start}–${citation.end}`,
    before: source.text.slice(Math.max(0, citation.start - 240), citation.start),
    quote: source.text.slice(citation.start, visibleEnd), after: source.text.slice(citation.end, citation.end + 240),
    truncated: visibleEnd < citation.end }
}
