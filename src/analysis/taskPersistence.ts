import { analysisRequestSchema, canonicalizeJson, identifierSchema, ANALYSIS_LIMITS, type AnalysisRequestV1, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import { db, listSourcesByDoc } from '../store/db'
import type { SourceDocument } from '../types'
import { AnalysisClientError } from './engineClient'
import { notifyAnalysisBinding, subscribeAnalysisBinding, type AnalysisBindingChange } from './taskNotifications'

export interface StoredArtifactIdentity {
  artifactId: string
  attempt: number
  runRevision: number
  contentHash?: string
}

/** Metadata only: results, source text and credentials are never duplicated in this table. */
export interface StoredAnalysisTask {
  docId: string
  version: 1
  request: AnalysisRequestV1
  runId?: string
  partBytes: number
  uploadedParts: Record<string, number>
  revision: number
  lastEventId?: string
  lastSequence: number
  updatedAt: number
  artifactIdentities?: Partial<Record<ArtifactKind, StoredArtifactIdentity>>
}

/** An authoritative removal must compare the identities observed before its read. */
export interface AnalysisArtifactIdentityUpdate {
  expected: StoredAnalysisTask['artifactIdentities']
}

export interface AnalysisTaskRepository {
  load(docId: string): Promise<StoredAnalysisTask | undefined>
  save(task: StoredAnalysisTask, origin?: string, identityUpdate?: AnalysisArtifactIdentityUpdate): Promise<StoredAnalysisTask | void>
  remove(docId: string, expectedRequestKey?: string, origin?: string): Promise<void>
  sources(docId: string): Promise<SourceDocument[]>
  subscribe?(docId: string, listener: (change: AnalysisBindingChange) => void): () => void
}

const mergeArtifactIdentities = (
  current: StoredAnalysisTask['artifactIdentities'], incoming: StoredAnalysisTask['artifactIdentities'],
  removeMissing = false,
): StoredAnalysisTask['artifactIdentities'] => {
  if (incoming === undefined && (current === undefined || removeMissing)) return undefined
  const merged: NonNullable<StoredAnalysisTask['artifactIdentities']> = removeMissing ? {} : { ...current }
  for (const [kind, identity] of Object.entries(incoming ?? {})) {
    const previous = current?.[kind as ArtifactKind]
    if (previous && (previous.artifactId !== identity.artifactId || previous.attempt !== identity.attempt
      || previous.contentHash !== undefined && identity.contentHash !== undefined && previous.contentHash !== identity.contentHash)) {
      throw new AnalysisClientError('conflict', 'Conflicting immutable artifact identity', false)
    }
    // Metadata at one run revision may arrive from several read-only tabs.
    // Preserve the first stable identity; only promote a previously absent hash.
    merged[kind as ArtifactKind] = previous
      ? { ...previous, ...(previous.contentHash === undefined && identity.contentHash !== undefined ? { contentHash: identity.contentHash } : {}) }
      : identity
  }
  return merged
}

export function parseStoredAnalysisTask(value: StoredAnalysisTask): StoredAnalysisTask {
  const request = analysisRequestSchema.parse(value.request)
  if (value.version !== 1 || value.docId !== request.docId
    || value.runId !== undefined && !identifierSchema.safeParse(value.runId).success
    || value.lastEventId !== undefined && !identifierSchema.safeParse(value.lastEventId).success
    || !Number.isInteger(value.partBytes) || value.partBytes < 4 || value.partBytes > ANALYSIS_LIMITS.maxUploadPartBytes
    || !Number.isInteger(value.revision) || value.revision < 0
    || !Number.isInteger(value.lastSequence) || value.lastSequence < -1
    || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 || !value.uploadedParts || typeof value.uploadedParts !== 'object' || Array.isArray(value.uploadedParts)
    || Object.entries(value.uploadedParts).some(([id, count]) => !request.manifest.sources.some((s) => s.sourceId === id) || !Number.isInteger(count) || count < 0 || count > 10_000)) {
    throw new Error('Analysis task metadata is invalid')
  }
  let artifactIdentities: StoredAnalysisTask['artifactIdentities']
  if (value.artifactIdentities !== undefined) {
    if (!value.artifactIdentities || typeof value.artifactIdentities !== 'object' || Array.isArray(value.artifactIdentities)) throw new Error('Analysis artifact metadata is invalid')
    artifactIdentities = {}
    for (const [kind, identity] of Object.entries(value.artifactIdentities)) {
      if (!request.artifacts.includes(kind as ArtifactKind) || !identity || !identifierSchema.safeParse(identity.artifactId).success
        || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
        || !Number.isSafeInteger(identity.runRevision) || identity.runRevision < 0 || identity.runRevision > value.revision
        || identity.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(identity.contentHash)) throw new Error('Analysis artifact metadata is invalid')
      artifactIdentities[kind as ArtifactKind] = { artifactId: identity.artifactId, attempt: identity.attempt, runRevision: identity.runRevision,
        ...(identity.contentHash === undefined ? {} : { contentHash: identity.contentHash }) }
    }
  }
  return { version: 1, docId: value.docId, request, runId: value.runId,
    partBytes: value.partBytes, uploadedParts: { ...value.uploadedParts }, revision: value.revision,
    lastEventId: value.lastEventId, lastSequence: value.lastSequence, updatedAt: value.updatedAt,
    ...(artifactIdentities === undefined ? {} : { artifactIdentities }) }
}

export const analysisTaskRepository: AnalysisTaskRepository = {
  async load(docId) {
    const task = await db.analysisTasks.get(docId)
    return task && parseStoredAnalysisTask(task)
  },
  async save(input, origin, identityUpdate) {
    const task = parseStoredAnalysisTask(input)
    let change: AnalysisBindingChange['type'] | undefined
    let saved = task
    await db.transaction('rw', db.analysisTasks, db.docs, db.quizPractices, async () => {
      const current = await db.analysisTasks.get(task.docId)
      if (!await db.docs.get(task.docId) || (!current && task.runId !== undefined)
        || current && (current.request.requestKey !== task.request.requestKey || current.runId !== undefined && current.runId !== task.runId)) {
        throw new AnalysisClientError('conflict', 'Analysis task binding changed', false)
      }
      // Read-only SSE consumers in multiple tabs may save different cursors.
      // Merge metadata monotonically; never resurrect a deleted/newer binding.
      let artifactIdentities = task.artifactIdentities
      if ((current?.revision ?? 0) > task.revision) artifactIdentities = current?.artifactIdentities
      else if (current && current.revision === task.revision) {
        const expectedMatches = identityUpdate !== undefined
          && canonicalizeJson(current.artifactIdentities ?? {}) === canonicalizeJson(identityUpdate.expected ?? {})
        artifactIdentities = mergeArtifactIdentities(current.artifactIdentities, task.artifactIdentities, expectedMatches)
      } else if (current) {
        // A new server revision can replace attempts, while the same attempt's
        // immutable artifact identity must still agree across sibling updates.
        for (const [kind, identity] of Object.entries(task.artifactIdentities ?? {})) {
          const previous = current.artifactIdentities?.[kind as ArtifactKind]
          if (previous?.attempt === identity.attempt) {
            const stable = mergeArtifactIdentities({ [kind]: previous }, { [kind]: identity }, true)
            artifactIdentities = { ...artifactIdentities, [kind]: stable?.[kind as ArtifactKind] }
          }
        }
      }
      saved = { ...task, revision: Math.max(task.revision, current?.revision ?? 0),
        lastSequence: Math.max(task.lastSequence, current?.lastSequence ?? -1),
        lastEventId: (current?.lastSequence ?? -1) > task.lastSequence ? current?.lastEventId : task.lastEventId,
        uploadedParts: Object.fromEntries(task.request.manifest.sources.map((source) => [source.sourceId,
          Math.max(task.uploadedParts[source.sourceId] ?? 0, current?.uploadedParts[source.sourceId] ?? 0)])),
        updatedAt: Math.max(task.updatedAt, current?.updatedAt ?? 0), artifactIdentities }
      if (saved.artifactIdentities === undefined) delete saved.artifactIdentities
      const oldQuiz = current?.artifactIdentities?.quiz
      const newQuiz = saved.artifactIdentities?.quiz
      if (oldQuiz && (oldQuiz.artifactId !== newQuiz?.artifactId || oldQuiz.contentHash !== newQuiz?.contentHash)) {
        await db.quizPractices.where('docId').equals(task.docId).delete()
      }
      await db.analysisTasks.put(saved)
      if (!current || current.runId !== saved.runId) change = 'binding'
      else if (canonicalizeJson(current.artifactIdentities ?? {}) !== canonicalizeJson(saved.artifactIdentities ?? {})) change = 'artifact'
    })
    if (change) notifyAnalysisBinding({ version: 1, docId: task.docId, type: change, origin })
    return saved
  },
  async remove(docId, expectedRequestKey, origin) {
    await db.transaction('rw', db.analysisTasks, db.quizPractices, async () => {
      const current = await db.analysisTasks.get(docId)
      if (expectedRequestKey !== undefined && current?.request.requestKey !== expectedRequestKey) throw new AnalysisClientError('conflict', 'Analysis task binding changed', false)
      await db.analysisTasks.delete(docId)
      await db.quizPractices.where('docId').equals(docId).delete()
    })
    notifyAnalysisBinding({ version: 1, docId, type: 'deleted', origin })
  },
  sources: listSourcesByDoc,
  subscribe: subscribeAnalysisBinding,
}
