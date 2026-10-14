import { describe, expect, it } from 'vitest'
import { parseRelationSourceReferences, requireRelationSources, verifyRelationSourceHashes } from './relationSources'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { convertMindMapArtifact } from '../analysis/mindMapApplication'
import { parseImported } from './exporters'
import { cloneFromTemplate } from './templateClone'

describe('native relation source metadata', () => {
  it('accepts bounded v1 references and rejects unknown fields, coercions and unsupported versions', () => {
    const reference = { version: 1, sourceId: 'source-1', contentHash: 'a'.repeat(64), start: 0, end: 2, page: 1, locator: '合成段落' }
    expect(parseRelationSourceReferences(undefined)).toBeUndefined()
    expect(parseRelationSourceReferences([reference])).toEqual([reference])
    for (const patch of [{ version: 2 }, { sourceId: '../bad' }, { contentHash: 'bad' }, { start: -1 }, { start: 0.5 }, { end: 0 }, { page: 0 }, { page: 1.5 }, { locator: 'x'.repeat(501) }, { token: 'synthetic-disallowed' }]) {
      expect(() => parseRelationSourceReferences([{ ...reference, ...patch }])).toThrow()
    }
    for (const value of [{}, [null], [false], Array.from({ length: 201 }, () => reference)]) expect(() => parseRelationSourceReferences(value)).toThrow()
  })

  it('preserves valid references in native JSON/templates and rejects missing or modified source copies', async () => {
    const fixture = await localArtifactFixtures()
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    requireRelationSources(converted.doc, converted.sources)
    await verifyRelationSourceHashes(converted.doc, converted.sources)
    const legacySource = { ...converted.sources[0]! }
    delete legacySource.contentHash
    await verifyRelationSourceHashes(converted.doc, [legacySource])
    await expect(verifyRelationSourceHashes(converted.doc, [{ ...legacySource, text: legacySource.text + '变更' }])).rejects.toThrow('改变')
    expect(() => parseImported(JSON.stringify(converted.doc))).toThrow('来源')
    const corrupt = structuredClone(converted.doc)
    corrupt.relations![0]!.sourceRefs![0]!.end = 100
    expect(() => requireRelationSources(corrupt, converted.sources)).toThrow('越界')
    await expect(verifyRelationSourceHashes(converted.doc, [{ ...converted.sources[0]!, text: converted.sources[0]!.text + '变更' }])).rejects.toThrow('改变')
    expect(() => cloneFromTemplate(converted.doc)).toThrow('缺少原文')
    const clone = cloneFromTemplate(converted.doc, converted.sources)
    await verifyRelationSourceHashes(clone.doc, clone.sources)
    expect(clone.doc.relations![0]!.sourceRefs![0]!.sourceId).not.toBe(converted.sources[0]!.id)
  })
})
