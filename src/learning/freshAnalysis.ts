import { db, loadDoc, listSourcesByDoc, saveDocumentBundle } from '../store/db'
import type { DocData } from '../types'
import { attachDocument } from './repository'
import { LearningError, newLearningId } from './model'
/** Creates an explicit new analysis context from already stored text; no import or model call. */
export async function prepareFreshAnalysis(courseId: string, docId: string, chapter = ''): Promise<DocData> {
  const original = await loadDoc(docId); const sources = await listSourcesByDoc(docId)
  if (!original || !sources.length) throw new LearningError('missing', '原文资料不可用，请选择已有来源。')
  const id = newLearningId(); const rootId = newLearningId(); const at = Date.now()
  const doc: DocData = { version: 3, id, title: `${original.title}（新分析）`.slice(0, 200), rootId, layout: 'logic', nodes: { [rootId]: { id: rootId, parent: null, children: [], text: original.title } }, createdAt: at, updatedAt: at }
  await saveDocumentBundle(doc, sources.map((source) => ({ ...source, id: newLearningId(), docId: id, anchors: [] })))
  try { await attachDocument(courseId, id, chapter); return doc }
  catch (error) { await db.transaction('rw', [db.docs, db.sources, db.docVersions], async () => { await db.docs.delete(id); await db.sources.where('docId').equals(id).delete(); await db.docVersions.where('docId').equals(id).delete() }); throw error }
}
