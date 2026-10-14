import { describe, expect, it } from 'vitest'
import { convertMindMapArtifact } from './mindMapApplication'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { cloneFromTemplate } from '../lib/templateClone'
import { parseImported } from '../lib/exporters'
import { useDoc } from '../store/docStore'

describe('independent mind map conversion', () => {
  it('remaps every identity, rebuilds node anchors, preserves UTF-16 references and native/clone/Undo metadata', async () => {
    const fixture = await localArtifactFixtures()
    const before = JSON.stringify(fixture)
    const converted = convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))
    expect(JSON.stringify(fixture)).toBe(before)
    expect(converted.doc.id).not.toBe(fixture.doc.id)
    expect(converted.sources[0]!.id).not.toBe(fixture.source.id)
    expect(converted.sources[0]!.docId).toBe(converted.doc.id)
    expect(converted.sources[0]!.text).toBe(fixture.source.text)
    expect(converted.sources[0]!.locators).toEqual(fixture.source.locators)
    expect(converted.sources[0]!.anchors).toHaveLength(2)
    expect(converted.nodeMappings).toEqual(fixture.mindmap.payload.nodes.map((node) => ({ generatedNodeId: node.id,
      localNodeId: expect.any(String), originalText: node.text })))
    expect(new Set(converted.nodeMappings.map((mapping) => mapping.localNodeId)).size).toBe(2)
    for (const mapping of converted.nodeMappings) expect(converted.doc.nodes[mapping.localNodeId].text).toBe(mapping.originalText)
    expect(converted.sourceMappings).toEqual([{ originSourceId: fixture.source.id, copiedSourceId: converted.sources[0].id }])
    for (const anchor of converted.sources[0]!.anchors) {
      expect(converted.doc.nodes[anchor.nodeId]).toBeDefined()
      expect(fixture.doc.nodes[anchor.nodeId]).toBeUndefined()
      expect(converted.sources[0]!.text.slice(anchor.start, anchor.end)).toBe('😀')
    }
    const relation = converted.doc.relations![0]!
    expect(relation.id).not.toBe('relation')
    expect(relation.sourceRefs![0]!).toMatchObject({ version: 1, sourceId: converted.sources[0]!.id, contentHash: fixture.snapshot.contentHash, start: 6, end: 8 })
    const restored = parseImported(JSON.stringify({ ...converted.doc, _sources: converted.sources }))
    expect(restored.doc.relations).toEqual(converted.doc.relations)
    const clone = cloneFromTemplate(restored.doc, restored.sources)
    expect(clone.doc.relations![0]!.sourceRefs![0]!.sourceId).toBe(clone.sources[0]!.id)
    expect(clone.sources[0]!.anchors.every((anchor) => !!clone.doc.nodes[anchor.nodeId])).toBe(true)
    useDoc.getState().loadDoc(converted.doc)
    useDoc.getState().updateRelation(relation.id, { label: '手工修改' })
    useDoc.getState().undo()
    expect(useDoc.getState().doc.relations).toEqual(converted.doc.relations)
    useDoc.getState().redo()
    expect(useDoc.getState().doc.relations![0]!.sourceRefs).toEqual(relation.sourceRefs)
  })

  it('rejects cycles, missing parents, multiple roots, endpoints, citations and allocation collisions', async () => {
    const fixture = await localArtifactFixtures()
    for (const change of [
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[0]!.parentId = 'child' },
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[1]!.parentId = 'missing' },
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[1]!.parentId = null },
      (artifact: typeof fixture.mindmap) => { artifact.payload.relations[0]!.to = 'missing' },
      (artifact: typeof fixture.mindmap) => { artifact.payload.relations[0]!.to = 'root' },
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[0]!.citations[0] = { version: 1, provenance: 'inference' } },
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[0]!.citations[0] = { version: 1, provenance: 'source', sourceId: 'missing', start: 0, end: 1 } },
      (artifact: typeof fixture.mindmap) => { artifact.payload.nodes[0]!.citations[0] = { version: 1, provenance: 'source', sourceId: fixture.source.id, start: 0, end: 100 } },
    ]) {
      const artifact = structuredClone(fixture.mindmap); change(artifact)
      expect(() => convertMindMapArtifact(artifact, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))).toThrow()
    }
    expect(() => convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map(), { createId: () => 'collision' })).toThrow()
    for (const source of [{ ...fixture.source, docId: 'other-doc' }, { ...fixture.source, charCount: 100 }]) {
      expect(() => convertMindMapArtifact(fixture.mindmap, [source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))).toThrow('来源')
    }
    expect(() => convertMindMapArtifact(fixture.mindmap, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]), { title: 'x'.repeat(1_001) })).toThrow()
  })

  it('supports 1,000 nodes and depth 32; rejects contract count and depth overflow', async () => {
    const fixture = await localArtifactFixtures()
    const artifact = structuredClone(fixture.mindmap)
    artifact.payload.nodes = Array.from({ length: 1_000 }, (_, index) => ({ id: `node-${index}`, parentId: index === 0 ? null : `node-${index <= 32 ? index - 1 : 0}`, text: String(index), evidenceIds: [], citations: [] }))
    artifact.payload.relations = []
    expect(Object.keys(convertMindMapArtifact(artifact, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]])).doc.nodes)).toHaveLength(1_000)
    artifact.payload.nodes[33]!.parentId = 'node-32'
    expect(() => convertMindMapArtifact(artifact, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))).toThrow('32')
    artifact.payload.nodes.push({ id: 'node-overflow', parentId: 'node-0', text: 'overflow', evidenceIds: [], citations: [] })
    expect(() => convertMindMapArtifact(artifact, [fixture.source], new Map([[fixture.source.id, fixture.snapshot.contentHash]]))).toThrow()
  })
})
