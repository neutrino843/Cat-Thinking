import { expect, it } from 'vitest'
import { resolveCitationView } from './citationView'
import { createSourceSnapshot } from './fingerprint'
import type { SourceDocument } from '../types'

const source = (text = '合成原文🌱'): SourceDocument => ({ version: 1, id: 's', docId: 'd', name: 'synthetic.pdf', kind: 'pdf', mime: 'application/pdf', size: 1, lastModified: 1, importedAt: 1, extractor: 'synthetic', text, charCount: text.length, anchors: [], locators: [{ start: 0, end: text.length, page: 1, titlePath: ['合成章节'] }] })
it('resolves UTF-16 source spans and locator/page with bounded context', async () => {
  const s = source(); const snapshot = await createSourceSnapshot(s)
  const view = await resolveCitationView('d', s, snapshot, { version: 1, provenance: 'source', sourceId: 's', start: 4, end: 6 })
  expect(view.quote).toBe('🌱'); expect(view.location).toContain('第 1 页'); expect(view.location).toContain('合成章节')
  const long = source('a'.repeat(10_000))
  const longView = await resolveCitationView('d', long, await createSourceSnapshot(long), { version: 1, provenance: 'source', sourceId: 's', start: 500, end: 6000, page: 1, locator: 'fixed' })
  expect(longView.quote).toHaveLength(4000); expect(longView.before).toHaveLength(240); expect(longView.after).toHaveLength(240); expect(longView.truncated).toBe(true)
})
it('rejects changed text, wrong documents/sources and citations outside selected range', async () => {
  const s = source(); const snapshot = await createSourceSnapshot(s, { start: 1, end: 4 })
  const citation = { version: 1 as const, provenance: 'source' as const, sourceId: 's', start: 1, end: 4 }
  for (const [docId, candidate, manifest, span] of [
    ['wrong', s, snapshot, citation], ['d', undefined, snapshot, citation], ['d', s, undefined, citation],
    ['d', { ...s, text: '不同原文🌱' }, snapshot, citation], ['d', s, snapshot, { ...citation, start: 0 }],
    ['d', s, snapshot, { ...citation, end: 5 }], ['d', s, snapshot, { ...citation, end: 1 }],
    ['d', s, { ...snapshot, sourceId: 'wrong' }, citation],
  ] as const) await expect(resolveCitationView(docId, candidate, manifest, span)).rejects.toThrow('原文')
  const noLocator = { ...s, locators: undefined }
  expect((await resolveCitationView('d', noLocator, await createSourceSnapshot(noLocator), citation)).location).toContain('字符 1–4')
})
