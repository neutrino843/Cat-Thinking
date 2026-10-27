import { db } from '../store/db'
import { validateDoc } from '../lib/exporters'
import { LearningError, type CourseSnapshot } from './model'
import type { NodeLearningState, NodeSourceRef } from './nodeTypes'
import { getEntity, saveLearningBatch } from './repository'

export interface NodeCandidate {
  key: string
  parentKey?: string
  title: string
  refs: NodeSourceRef[]
}

export interface NodeCandidatePage {
  items: NodeCandidate[]
  offset: number
  limit: number
  hasMore: boolean
}

export async function getNodeCandidatePage(snapshot: CourseSnapshot, offset = 0, limit = 500): Promise<NodeCandidatePage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset + limit + 1)) {
    throw new LearningError('invalid', '候选分页范围无效。')
  }
  const candidates = await scanNodeCandidates(snapshot, offset + limit + 1)
  return { items: candidates.slice(offset, offset + limit), offset, limit, hasMore: candidates.length > offset + limit }
}

/** Accept only a previewed title change; notes, sources and relationships stay attached. */
export async function updateNodeFromCandidate(state: NodeLearningState, candidate: NodeCandidate, expectedPointRevision: number) {
  const binding = state.bindings.find((item) => item.originKey === candidate.key)
  const point = binding && await getEntity(binding.pointId, 'point')
  if (!point || point.revision !== expectedPointRevision) throw new LearningError('conflict', '节点已变化，请重新检查候选差异。')
  if (point.title === candidate.title) return
  await saveLearningBatch([
    { entity: { ...point, title: candidate.title, questionRefs: point.questionRefs.map((ref) => ({ ...ref, confirmed: false })) }, expectedRevision: expectedPointRevision },
    { entity: state, expectedRevision: state.revision },
  ])
}

/** Read only saved structures; candidate discovery never invokes a model. */
export async function listNodeCandidates(snapshot: CourseSnapshot): Promise<NodeCandidate[]> {
  return (await getNodeCandidatePage(snapshot)).items
}

async function scanNodeCandidates(snapshot: CourseSnapshot, maxResults: number): Promise<NodeCandidate[]> {
  const state = snapshot.nodeWorkspace
  if (!state) return []
  const result: NodeCandidate[] = []
  for (const membership of snapshot.documents) {
    if (result.length >= maxResults) return result
    const row = await db.docs.get(membership.docId)
    if (!row) continue
    let doc
    try { doc = validateDoc(JSON.parse(row.payload)) }
    catch { throw new LearningError('corrupt', `资料“${row.title}”结构无效，请先检查原导图。`) }
    const pending: { id: string; parentKey?: string }[] = [{ id: doc.rootId }]
    const visited = new Set<string>()
    while (pending.length && result.length < maxResults) {
      const entry = pending.pop()
      if (!entry || visited.has(entry.id)) continue
      visited.add(entry.id)
      const node = doc.nodes[entry.id]
      if (!node) continue
      const key = JSON.stringify(['doc', membership.docId, node.id])
      if (entry.id !== doc.rootId && node.text.trim()) {
        const refs = state.sources.filter((s) => s.originDocId === membership.docId && s.role === 'slides')
          .flatMap((s) => (s.anchors ?? []).filter((a) => a.nodeId === node.id)
            .map((a) => ({ snapshotId: s.id, start: a.start, end: a.end })))
        result.push({ key, parentKey: entry.parentKey, title: node.text.slice(0, 200), refs })
      }
      for (const child of [...node.children].reverse()) {
        pending.push({ id: child, parentKey: entry.id === doc.rootId ? undefined : key })
      }
    }
  }
  for (const archive of snapshot.archives) for (const artifact of archive.artifacts) {
    if (result.length >= maxResults) return result
    if (artifact.kind !== 'outline') continue
    const pending = [...artifact.payload.nodes].reverse().map((node) => ({ node, parentKey: undefined as string | undefined }))
    while (pending.length && result.length < maxResults) {
      const entry = pending.pop()
      if (!entry) continue
      const { node, parentKey } = entry
      const key = JSON.stringify(['archive', archive.id, node.id])
      const refs = node.citations.flatMap((cite) => cite.provenance === 'source'
        ? state.sources.filter((s) => (s.originSourceId === cite.sourceId || s.provenanceSourceId === cite.sourceId)
          && s.contentHash === archive.sources.find((s) => s.id === cite.sourceId)?.contentHash)
          .map((s) => ({ snapshotId: s.id, start: cite.start, end: cite.end })) : [])
      result.push({ key, parentKey, title: node.title.slice(0, 200), refs })
      for (const child of [...node.children].reverse()) pending.push({ node: child, parentKey: key })
    }
  }
  return result
}
