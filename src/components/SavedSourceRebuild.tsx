import { useEffect, useState } from 'react'
import { db, saveDocumentBundle } from '../store/db'
import { useDoc } from '../store/docStore'
import type { SourceDocument } from '../types'
import { prepareSavedSourceImport, type DocumentImportDraft } from '../lib/documentImport'
import { emitDocsChanged } from '../lib/tabs'
import DocumentImportDialog from './DocumentImportDialog'

export default function SavedSourceRebuild({ docId }: { docId: string }) {
  const [sources, setSources] = useState<SourceDocument[]>([])
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<DocumentImportDraft>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    void db.sources.where('docId').equals(docId).toArray().then((rows) => { if (!disposed) setSources(rows) })
      .catch(() => { if (!disposed) setError('无法读取已有资料。') })
    return () => { disposed = true }
  }, [docId])
  const prepare = () => {
    try {
      const source = sources.find((item) => item.id === selected) ?? sources[0]
      if (!source) throw new Error('这张图没有保存原文，请重新导入课件。')
      setDraft(prepareSavedSourceImport(source)); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法准备副本。') }
  }
  const save = async (candidate: DocumentImportDraft) => {
    await saveDocumentBundle(candidate.doc, [candidate.source])
    setDraft(undefined); emitDocsChanged(); useDoc.getState().openDoc(candidate.doc)
  }
  return <section><h4>重新整理讲义结构</h4><p>选择一份已有原文，预览后另存新图。原图及其笔记、附件和学习关联保留，新图不自动继承学习记录。</p>
    {!!sources.length && <label>重整的资料<select value={selected || sources[0].id} onChange={(event) => setSelected(event.target.value)}>{sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></label>}
    {sources.length > 1 && <p>本次只整理所选资料，其他来源继续保留在原图。</p>}
    <button className="tbtn" onClick={prepare}>预览讲义结构副本</button>
    {error && <p role="alert">{error}</p>}
    {draft && <DocumentImportDialog draft={draft} onClose={() => setDraft(undefined)} onConfirm={save} />}
  </section>
}
