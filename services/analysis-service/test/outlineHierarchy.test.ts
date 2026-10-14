import { describe, expect, it } from 'vitest'
import { validateMindMapGraph, type MindMapArtifactV1, type OutlineArtifactV1, type OutlineNodeV1 } from '@cat-thinking/analysis-contracts'
import { collectOutlineHierarchy, inheritOutlineHierarchy, validateMindMapOutlineHierarchy } from '../src/domain/outlineHierarchy.js'

const support = { evidenceIds: ['claim-1'], citations: [] }
const node = (id: string, title: string, children: OutlineNodeV1[] = []): OutlineNodeV1 => ({ id, title, children, ...support })
const outline: OutlineArtifactV1 = { title: 'Algorithm', nodes: [
  node('mechanism', 'Mechanism', [node('initialization', 'Initialization', [node('state', 'State')])]),
  node('evaluation', 'Evaluation', [node('metric', 'Metric')]),
] }
const flatMap = (): MindMapArtifactV1 => ({ title: outline.title, nodes: [
  { id: 'document-root', parentId: null, text: outline.title, ...support },
  ...collectOutlineHierarchy(outline).map(({ node: entry }) => ({ id: entry.id, text: entry.title,
    parentId: 'document-root', note: `Note for ${entry.id}`, ...support })),
], relations: [{ id: 'grounded-relation', from: 'initialization', to: 'metric', label: 'evaluated by', ...support }] })

describe('completed Outline hierarchy', () => {
  it('collects all ancestors and branches in document order', () => {
    expect(collectOutlineHierarchy(outline).map(({ node: entry, parentId, depth }) => [entry.id, parentId, depth])).toEqual([
      ['mechanism', null, 1], ['initialization', 'mechanism', 2], ['state', 'initialization', 3],
      ['evaluation', null, 1], ['metric', 'evaluation', 2],
    ])
  })

  it('reparents exact IDs while retaining model notes, grounding, extra nodes and cross relations', () => {
    const original = flatMap()
    original.nodes.push({ id: 'extra', parentId: 'metric', text: 'Supported detail', ...support })
    const result = inheritOutlineHierarchy(original, outline)
    expect(result.nodes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['document-root', null], ['mechanism', 'document-root'], ['initialization', 'mechanism'],
      ['state', 'initialization'], ['evaluation', 'document-root'], ['metric', 'evaluation'], ['extra', 'metric'],
    ])
    expect(result.relations).toBe(original.relations)
    expect(result.nodes[2]).toMatchObject({ note: 'Note for initialization', ...support })
    expect(original.nodes[2]!.parentId).toBe('document-root')
    expect(validateMindMapGraph(result)).toEqual([])
    expect(validateMindMapOutlineHierarchy(result, outline)).toEqual([])
  })

  it('does not guess concept identity from an exact or similar title', () => {
    const original = flatMap()
    original.nodes[2] = { ...original.nodes[2]!, id: 'renamed-initialization' }
    original.relations = []
    expect(inheritOutlineHierarchy(original, outline)).toBe(original)
    expect(validateMindMapOutlineHierarchy(original, outline)).toContainEqual({
      path: 'payload.nodes', message: 'mind map is missing Outline node initialization; preserve its exact ID',
    })
  })

  it('distinguishes equally named knowledge under different parents by exact IDs', () => {
    const duplicateTitles = { title: 'Algorithm', nodes: [node('a', 'Process', [node('a-detail', 'Conditions')]),
      node('b', 'Evaluation', [node('b-detail', 'Conditions')])] }
    const original = { title: 'Algorithm', relations: [], nodes: [
      { id: 'document-root', parentId: null, text: 'Algorithm', ...support },
      ...collectOutlineHierarchy(duplicateTitles).map(({ node: entry }) => ({ id: entry.id, parentId: 'document-root', text: entry.title, ...support })),
    ] }
    const result = inheritOutlineHierarchy(original, duplicateTitles)
    expect(result.nodes.find(({ id }) => id === 'a-detail')!.parentId).toBe('a')
    expect(result.nodes.find(({ id }) => id === 'b-detail')!.parentId).toBe('b')
  })

  it.each(['unknown-parent', 'cycle', 'unknown-relation'] as const)('does not erase a %s contract failure during hierarchy repair', (failure) => {
    const original = flatMap()
    if (failure === 'unknown-parent') original.nodes[2]!.parentId = 'missing'
    if (failure === 'cycle') { original.nodes[1]!.parentId = 'initialization'; original.nodes[2]!.parentId = 'mechanism' }
    if (failure === 'unknown-relation') original.relations[0]!.to = 'missing'
    expect(inheritOutlineHierarchy(original, outline)).toBe(original)
    expect(validateMindMapGraph(original).length).toBeGreaterThan(0)
  })

  it('does not partially rewrite a map with missing Outline IDs', () => {
    const original = flatMap()
    original.nodes = original.nodes.filter(({ id }) => id !== 'state')
    expect(inheritOutlineHierarchy(original, outline)).toBe(original)
  })

  it('rejects a document root that takes an Outline concept ID', () => {
    const original = flatMap()
    original.nodes = original.nodes.filter(({ id }) => id !== 'mechanism')
    original.nodes = original.nodes.map((entry) => entry.parentId === null
      ? { ...entry, id: 'mechanism' } : { ...entry, parentId: 'mechanism' })
    expect(inheritOutlineHierarchy(original, outline)).toBe(original)
    expect(validateMindMapOutlineHierarchy(original, outline).some(({ message }) => message.includes('missing Outline node mechanism'))).toBe(true)
  })

  it('does not normalize against an Outline containing ambiguous duplicate IDs', () => {
    const original = flatMap()
    expect(inheritOutlineHierarchy(original, { ...outline, nodes: [node('a', 'First'), node('a', 'Second')] })).toBe(original)
  })

  it('rejects flattened descendants and changed titles without enforcing arbitrary depth', () => {
    const flatIssues = validateMindMapOutlineHierarchy(flatMap(), outline)
    expect(flatIssues.some(({ path }) => path === 'payload.nodes.state.parentId')).toBe(true)
    const result = inheritOutlineHierarchy(flatMap(), outline)
    result.nodes[2]!.text = 'A different concept'
    expect(validateMindMapOutlineHierarchy(result, outline)).toEqual([
      { path: 'payload.nodes.initialization.text', message: 'mind map must preserve the completed Outline title for initialization' },
    ])
    const shallow: OutlineArtifactV1 = { title: 'One fact', nodes: [node('one-fact', 'One fact')] }
    expect(validateMindMapOutlineHierarchy({ title: 'One fact', nodes: [
      { id: 'document-root', parentId: null, text: 'One fact', ...support },
      { id: 'one-fact', parentId: 'document-root', text: 'One fact', ...support },
    ], relations: [] }, shallow)).toEqual([])
  })

  it.each(['missing', 'renamed', 'root-collision'] as const)('does not lose a shallow Outline concept through %s mapping', (failure) => {
    const shallow: OutlineArtifactV1 = { title: 'Short lesson', nodes: [node('one-fact', 'A supported fact')] }
    const mapped: MindMapArtifactV1 = { title: shallow.title, nodes: [
      { id: 'document-root', parentId: null, text: shallow.title, ...support },
      { id: 'one-fact', parentId: 'document-root', text: 'A supported fact', ...support },
    ], relations: [] }
    if (failure === 'renamed') mapped.nodes[1]!.id = 'another-fact'
    else mapped.nodes.pop()
    if (failure === 'root-collision') mapped.nodes[0]!.id = 'one-fact'
    expect(validateMindMapOutlineHierarchy(mapped, shallow)).toContainEqual({
      path: 'payload.nodes', message: 'mind map is missing Outline node one-fact; preserve its exact ID',
    })
  })
})
