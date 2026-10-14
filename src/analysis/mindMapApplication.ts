import { canonicalizeJson, identifierSchema, mindMapArtifactEnvelopeSchema, type ArtifactEnvelopeV1, type SourceCitationV1 } from '@cat-thinking/analysis-contracts'
import { db, type StoredDoc } from '../store/db'
import type { DocData, MindNodeData, RelationSourceReference, SourceDocument } from '../types'
import { sha256Hex } from './fingerprint'
import { LocalArtifactError, prepareArtifactIdentity, verifyPreparedArtifactIdentity } from './localArtifactIdentity'
import { loadLearningArchive, saveNodeBinding } from '../learning/repository'

export type MindMapEnvelope = Extract<ArtifactEnvelopeV1, { kind: 'mindmap' }>
export interface ApplicationReceipt {
  version: 1
  applicationIntentId: string
  originDocId: string
  runId: string
  artifactId: string
  artifactHash: string
  sourceFingerprint: string
  targetDocId: string
  committedAt: number
}
export interface MindMapApplicationResult { targetDocId: string; reused: boolean; status: 'active' | 'trashed' | 'deleted' }
export interface ApplyMindMapInput { originDocId: string; runId: string; artifact: MindMapEnvelope; applicationIntentId?: string; title?: string; archiveId?: string }
export interface GeneratedNodeMapping { generatedNodeId: string; localNodeId: string; originalText: string; originalNote?: string }

const uid = (): string => crypto.randomUUID()
const storedDoc = (doc: DocData): StoredDoc => ({ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, payload: JSON.stringify(doc) })
const requireMapped = <T>(map: ReadonlyMap<string, T>, id: string): T => {
  const value = map.get(id)
  if (value === undefined) throw new LocalArtifactError('invalid', '导图引用身份缺失。')
  return value
}

/** Pure, bounded conversion. Relations have their own references; source anchors only point at nodes. */
export function convertMindMapArtifact(artifactInput: MindMapEnvelope, sources: readonly SourceDocument[],
  hashes: ReadonlyMap<string, string>, options: { title?: string; createId?: () => string; now?: number } = {}): {
    doc: DocData; sources: SourceDocument[]; nodeMappings: GeneratedNodeMapping[]; sourceMappings: { originSourceId: string; copiedSourceId: string }[]
  } {
  const artifact = mindMapArtifactEnvelopeSchema.parse(artifactInput)
  if (sources.some((source) => source.docId !== artifact.docId || source.charCount !== source.text.length)) {
    throw new LocalArtifactError('invalid', '导图输入来源所属文档或字符数无效。')
  }
  const createId = options.createId ?? uid
  const targetDocId = createId()
  const nodeMap = new Map(artifact.payload.nodes.map((node) => [node.id, createId()]))
  const sourceMap = new Map(sources.map((source) => [source.id, createId()]))
  const allocatedIds = new Set([targetDocId, ...nodeMap.values(), ...sourceMap.values()])
  if (sourceMap.size !== sources.length || allocatedIds.size !== 1 + nodeMap.size + sourceMap.size) {
    throw new LocalArtifactError('invalid', '文档、节点和来源身份必须唯一。')
  }
  const originals = new Map(artifact.payload.nodes.map((node) => [node.id, node]))
  const roots = artifact.payload.nodes.filter((node) => node.parentId === null)
  const root = roots[0]
  if (roots.length !== 1 || !root) throw new LocalArtifactError('invalid', '导图必须有且仅有一个根节点。')
  for (const node of artifact.payload.nodes) {
    const visited = new Set<string>()
    let cursor: string | null = node.id
    let depth = 0
    while (cursor !== null) {
      if (visited.has(cursor) || !originals.has(cursor) || depth > 32) throw new LocalArtifactError('invalid', '导图层级无效、成环或超过 32 层。')
      visited.add(cursor)
      cursor = requireMapped(originals, cursor).parentId
      if (cursor !== null) depth++
    }
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const copiedByOldId = new Map<string, SourceDocument>(sources.map((source) => [source.id, { ...structuredClone(source), id: requireMapped(sourceMap, source.id), docId: targetDocId, contentHash: requireMapped(hashes, source.id), anchors: [] }]))
  const copiedSources = [...copiedByOldId.values()]
  const validateCitation = (citation: SourceCitationV1): void => {
    const source = sourceById.get(citation.sourceId)
    if (!source || source.docId !== artifact.docId || !hashes.has(source.id) || source.text.length !== source.charCount
      || citation.start < 0 || citation.end > source.text.length || citation.end <= citation.start
      || citation.quote !== undefined && citation.quote !== source.text.slice(citation.start, citation.end)) {
      throw new LocalArtifactError('invalid', '生成导图引用的来源或范围无效。')
    }
  }
  const nodes: Record<string, MindNodeData> = Object.create(null) as Record<string, MindNodeData>
  for (const node of artifact.payload.nodes) {
    const id = requireMapped(nodeMap, node.id)
    nodes[id] = { id, parent: node.parentId === null ? null : requireMapped(nodeMap, node.parentId), children: [], text: node.text,
      ...(node.note === undefined ? {} : { note: node.note }) }
    for (const citation of node.citations) {
      if (citation.provenance !== 'source') throw new LocalArtifactError('invalid', '本地导图只支持原文引用。')
      validateCitation(citation)
      const copy = requireMapped(copiedByOldId, citation.sourceId)
      const anchor = { nodeId: id, start: citation.start, end: citation.end,
        ...(citation.page === undefined ? {} : { page: citation.page }), ...(citation.locator === undefined ? {} : { locator: citation.locator }) }
      if (!copy.anchors.some((existing) => canonicalizeJson(existing) === canonicalizeJson(anchor))) copy.anchors.push(anchor)
    }
  }
  for (const node of Object.values(nodes)) if (node.parent !== null) {
    const parent = nodes[node.parent]
    if (!parent) throw new LocalArtifactError('invalid', '导图父节点缺失。')
    parent.children.push(node.id)
  }
  const relationIds = new Set<string>()
  const relations = artifact.payload.relations.map((relation) => {
    if (!nodeMap.has(relation.from) || !nodeMap.has(relation.to) || relation.from === relation.to) {
      throw new LocalArtifactError('invalid', '导图关系端点无效。')
    }
    const id = createId()
    if (relationIds.has(id) || allocatedIds.has(id)) throw new LocalArtifactError('invalid', '关系身份冲突。')
    relationIds.add(id)
    const sourceRefs: RelationSourceReference[] = relation.citations.map((citation) => {
      if (citation.provenance !== 'source') throw new LocalArtifactError('invalid', '导图关系只支持原文引用。')
      validateCitation(citation)
      return { version: 1, sourceId: requireMapped(sourceMap, citation.sourceId), contentHash: requireMapped(hashes, citation.sourceId), start: citation.start, end: citation.end,
        ...(citation.page === undefined ? {} : { page: citation.page }), ...(citation.locator === undefined ? {} : { locator: citation.locator }) }
    })
    return { id, from: requireMapped(nodeMap, relation.from), to: requireMapped(nodeMap, relation.to), ...(relation.label === undefined ? {} : { label: relation.label }), ...(sourceRefs.length ? { sourceRefs } : {}) }
  })
  const now = options.now ?? Date.now()
  const title = options.title?.trim() || artifact.payload.title
  if (title.length > 1_000) throw new LocalArtifactError('invalid', '导图标题超过限制。')
  return { doc: { version: 3, id: targetDocId, title, rootId: requireMapped(nodeMap, root.id), layout: 'logic', nodes, relations, createdAt: now, updatedAt: now }, sources: copiedSources,
    nodeMappings: artifact.payload.nodes.map((node) => ({ generatedNodeId: node.id, localNodeId: requireMapped(nodeMap, node.id), originalText: node.text,
      ...(node.note === undefined ? {} : { originalNote: node.note }) })),
    sourceMappings: sources.map((source) => ({ originSourceId: source.id, copiedSourceId: requireMapped(sourceMap, source.id) })) }
}

function parseReceipt(receipt: ApplicationReceipt): ApplicationReceipt {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).some((key) => !['version', 'applicationIntentId', 'originDocId', 'runId', 'artifactId', 'artifactHash', 'sourceFingerprint', 'targetDocId', 'committedAt'].includes(key))
    || receipt.version !== 1 || !identifierSchema.safeParse(receipt.applicationIntentId).success
    || [receipt.originDocId, receipt.runId, receipt.artifactId, receipt.targetDocId].some((id) => !identifierSchema.safeParse(id).success)
    || !/^[a-f0-9]{64}$/.test(receipt.artifactHash) || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint)
    || !Number.isInteger(receipt.committedAt) || receipt.committedAt < 0) {
    throw new LocalArtifactError('corrupt', '应用回执损坏，请检查本地数据。')
  }
  return { version: 1, applicationIntentId: receipt.applicationIntentId, originDocId: receipt.originDocId, runId: receipt.runId,
    artifactId: receipt.artifactId, artifactHash: receipt.artifactHash, sourceFingerprint: receipt.sourceFingerprint, targetDocId: receipt.targetDocId, committedAt: receipt.committedAt }
}

/** No overwrite: a committed intent always returns its original target, including a deleted target. */
export async function applyMindMapArtifact(input: ApplyMindMapInput): Promise<MindMapApplicationResult> {
  const artifact = mindMapArtifactEnvelopeSchema.parse(input.artifact)
  const prepared = await prepareArtifactIdentity({ docId: input.originDocId, runId: input.runId, artifact })
  const sourceFingerprint = await sha256Hex(canonicalizeJson(prepared.task.request.manifest.sources))
  const applicationIntentId = input.applicationIntentId ?? await sha256Hex(canonicalizeJson({ originDocId: input.originDocId, runId: input.runId, artifactId: artifact.id, sourceFingerprint }))
  if (!identifierSchema.safeParse(applicationIntentId).success) throw new LocalArtifactError('invalid', '应用意图身份无效。')
  const converted = convertMindMapArtifact(artifact, prepared.sources, new Map(prepared.task.request.manifest.sources.map((source) => [source.sourceId, source.contentHash])), { title: input.title })
  const archive = input.archiveId ? await loadLearningArchive(input.archiveId) : undefined
  if (input.archiveId && (!archive || archive.originDocId !== input.originDocId || archive.runId !== input.runId
    || !archive.artifacts.some((item) => item.kind === 'mindmap' && item.id === artifact.id && canonicalizeJson(item) === canonicalizeJson(artifact)))) {
    throw new LocalArtifactError('conflict', '学习归档与当前导图不一致，请重新读取。')
  }
  return db.transaction('rw', [db.docs, db.trash, db.sources, db.analysisTasks, db.applicationReceipts, db.learningRecords, db.learningCourseTombstones], async () => {
    await verifyPreparedArtifactIdentity(prepared)
    const existing = await db.applicationReceipts.get(applicationIntentId)
    if (existing) {
      const receipt = parseReceipt(existing)
      if (receipt.originDocId !== input.originDocId || receipt.runId !== input.runId || receipt.artifactId !== artifact.id
        || receipt.artifactHash !== prepared.artifactHash || receipt.sourceFingerprint !== sourceFingerprint) {
        throw new LocalArtifactError('conflict', '应用意图已经绑定其他产物。')
      }
      const status = await db.docs.get(receipt.targetDocId) ? 'active' : await db.trash.get(receipt.targetDocId) ? 'trashed' : 'deleted'
      return { targetDocId: receipt.targetDocId, reused: true, status }
    }
    await db.docs.add(storedDoc(converted.doc))
    if (converted.sources.length) await db.sources.bulkAdd(converted.sources)
    if (archive) await saveNodeBinding({ courseId: archive.courseId, docId: converted.doc.id, archiveId: archive.id, artifactId: artifact.id, mappings: converted.nodeMappings })
    await db.applicationReceipts.add({ version: 1, applicationIntentId, originDocId: input.originDocId, runId: input.runId,
      artifactId: artifact.id, artifactHash: prepared.artifactHash, sourceFingerprint, targetDocId: converted.doc.id, committedAt: Date.now() })
    return { targetDocId: converted.doc.id, reused: false, status: 'active' }
  })
}
