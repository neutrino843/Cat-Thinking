import { db, saveDocumentBundle } from '../store/db'
import type { DocumentImportDraft } from '../lib/documentImport'
import { attachDocument, createCourse, getCourse } from './repository'

/** Import is a single commit: a failed course link must not leave an orphan map. */
export async function importCourseDocument(draft: DocumentImportDraft, options: { courseId?: string; courseName?: string }) {
  return db.transaction('rw', [db.docs, db.sources, db.blobs, db.trash, db.documentTombstones,
    db.applicationReceipts, db.docVersions, db.learningRecords, db.learningCourseTombstones, db.learningEntityTombstones], async () => {
    // Local import drafts have no generated relations or external asynchronous work.
    if (draft.doc.relations?.length) throw new Error('请通过分析结果入口创建带生成关系的导图。')
    const course = options.courseId ? await getCourse(options.courseId) : undefined
    if (options.courseId && !course) throw new Error('选择的课程已经不存在，请重新选择。')
    if (await db.docs.get(draft.doc.id)) throw new Error('这份资料已保存，请返回资料库查看。')
    await saveDocumentBundle(draft.doc, [draft.source])
    const selected = course ?? await createCourse({ name: options.courseName?.trim() || draft.doc.title.slice(0, 120), learningMode: 'nodes' })
    await attachDocument(selected.id, draft.doc.id)
    return selected
  })
}
