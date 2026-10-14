import { canonicalizeJson, validateArtifactAgainstManifest, type ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { db } from '../store/db'
import type { SourceDocument } from '../types'
import { createSourceSnapshot, sha256Hex } from './fingerprint'
import { parseStoredAnalysisTask, type StoredAnalysisTask } from './taskPersistence'

export class LocalArtifactError extends Error {
  constructor(public readonly code: 'conflict' | 'invalid' | 'corrupt', message: string) {
    super(message)
    this.name = 'LocalArtifactError'
  }
}

export interface LocalArtifactContext {
  docId: string
  runId: string
  artifact: ArtifactEnvelopeV1
}

export interface PreparedArtifactIdentity {
  context: LocalArtifactContext
  task: StoredAnalysisTask
  sources: SourceDocument[]
  artifactHash: string
}

export const artifactContentHash = (artifact: ArtifactEnvelopeV1): Promise<string> => sha256Hex(canonicalizeJson(artifact))

export function requireArtifactBinding(task: StoredAnalysisTask | undefined, context: LocalArtifactContext): StoredAnalysisTask {
  if (!task) throw new LocalArtifactError('conflict', '分析任务已经删除，请重新读取结果。')
  const valid = parseStoredAnalysisTask(task)
  const identity = valid.artifactIdentities?.[context.artifact.kind]
  if (valid.docId !== context.docId || valid.runId !== context.runId
    || context.artifact.runId !== context.runId || context.artifact.docId !== context.docId
    || !identity || identity.artifactId !== context.artifact.id || valid.revision < identity.runRevision) {
    throw new LocalArtifactError('conflict', '产物身份已经改变，请重新读取结果。')
  }
  return valid
}

/** Hashing happens before the Dexie transaction. The transaction compares exact source snapshots. */
export async function prepareArtifactIdentity(context: LocalArtifactContext): Promise<PreparedArtifactIdentity> {
  const task = requireArtifactBinding(await db.analysisTasks.get(context.docId), context)
  if (validateArtifactAgainstManifest(context.artifact, task.request.manifest).length) {
    throw new LocalArtifactError('invalid', '产物结构或引用不符合当前来源。')
  }
  if (!await db.docs.get(context.docId)) throw new LocalArtifactError('conflict', '原文档已经删除。')
  const sources: SourceDocument[] = []
  for (const snapshot of task.request.manifest.sources) {
    const source = await db.sources.get(snapshot.sourceId)
    if (!source || source.docId !== context.docId || source.text.length !== source.charCount) {
      throw new LocalArtifactError('conflict', '原文来源已经删除或损坏。')
    }
    const current = await createSourceSnapshot(source, snapshot.selectedRange)
    if (canonicalizeJson(current) !== canonicalizeJson(snapshot)) {
      throw new LocalArtifactError('conflict', '原文来源已经改变，请重新生成分析。')
    }
    sources.push(source)
  }
  const hashes = task.request.manifest.sources.map((source) => source.contentHash).sort()
  if (canonicalizeJson(hashes) !== canonicalizeJson([...context.artifact.sourceContentHashes].sort())) {
    throw new LocalArtifactError('invalid', '产物来源与分析任务不一致。')
  }
  const artifactHash = await artifactContentHash(context.artifact)
  const expectedHash = task.artifactIdentities?.[context.artifact.kind]?.contentHash
  if (expectedHash !== undefined && expectedHash !== artifactHash) {
    throw new LocalArtifactError('invalid', '产物内容与已验证身份不一致。')
  }
  return { context, task, sources, artifactHash }
}

/** Only IndexedDB operations are awaited here; callers must include docs/sources/analysisTasks. */
export async function verifyPreparedArtifactIdentity(prepared: PreparedArtifactIdentity): Promise<void> {
  const { context, task, sources } = prepared
  const current = requireArtifactBinding(await db.analysisTasks.get(context.docId), context)
  const identity = current.artifactIdentities?.[context.artifact.kind]
  const originalIdentity = task.artifactIdentities?.[context.artifact.kind]
  if (!await db.docs.get(context.docId) || current.request.requestKey !== task.request.requestKey
    || canonicalizeJson(identity) !== canonicalizeJson(originalIdentity)) {
    throw new LocalArtifactError('conflict', '分析绑定已经改变，请重新读取结果。')
  }
  for (const source of sources) {
    const latest = await db.sources.get(source.id)
    if (!latest || canonicalizeJson(latest) !== canonicalizeJson(source)) {
      throw new LocalArtifactError('conflict', '原文来源在保存期间发生变化。')
    }
  }
}
