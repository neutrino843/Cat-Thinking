import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentImportDraft } from '../lib/documentImport'
import { useT } from '../i18n'
import { canMoveImportNode, moveImportNode } from '../lib/importTree'
import type { DocData } from '../types'

interface Props {
  draft: DocumentImportDraft
  onClose: () => void
  onConfirm: (draft: DocumentImportDraft, courseName?: string) => Promise<void>
  course?: { name: string; existing: boolean }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DocumentImportDialog({ draft, onClose, onConfirm, course }: Props) {
  const t = useT()
  const [saving, setSaving] = useState(false)
  const savingLock = useRef(false)
  const modal = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState(draft.doc.title)
  const [rootTitle, setRootTitle] = useState(draft.doc.nodes[draft.doc.rootId]?.text ?? draft.doc.title)
  const [courseName, setCourseName] = useState((course?.name || draft.doc.title).slice(0, 120))
  const [tree, setTree] = useState(draft.doc)
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const selectedNode = tree.nodes[selectedNodeId]
  useEffect(() => {
    const previous = document.activeElement
    modal.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]') && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const confirm = async () => {
    if (savingLock.current) return
    if (!title.trim() || !rootTitle.trim() || course && !courseName.trim()) { setError('请填写名称后再导入。'); return }
    savingLock.current = true
    setSaving(true)
    setError('')
    try {
      await onConfirm({ ...draft, doc: { ...tree, title: title.trim(), nodes: { ...tree.nodes,
        [tree.rootId]: { ...tree.nodes[tree.rootId], text: rootTitle.trim() } } } }, courseName.trim())
    } catch (reason) {
      setError((reason as Error).message || t('import.failed'))
      setSaving(false)
      savingLock.current = false
    }
  }

  const stats = [
    [t('import.chars'), draft.stats.charCount.toLocaleString()],
    [t('import.sections'), draft.stats.sectionCount.toLocaleString()],
    [t('import.paragraphs'), draft.stats.paragraphCount.toLocaleString()],
    [t('import.nodes'), draft.stats.nodeCount.toLocaleString()],
  ]
  const kindLabel = {
    text: 'TXT',
    markdown: 'Markdown',
    pdf: 'PDF',
    docx: 'DOCX',
    pptx: 'PPTX',
  }[draft.source.kind]

  return createPortal(
    <div className="modal-mask" onPointerDown={() => !saving && onClose()}>
      <div
        ref={modal}
        className="modal document-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-import-title"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || event.defaultPrevented) return
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input,textarea,select,summary,[tabindex="0"]')].filter((el) => !el.matches(':disabled') && el.getClientRects().length)
          const first = items[0]; const last = items.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}
      >
        <div className="modal-head">
          <span id="document-import-title">{t('import.documentTitle')}</span>
          <button className="tbtn" onClick={onClose} disabled={saving} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body document-import-body">
          <p className="document-import-lead">{t('import.documentHint')}</p>

          <div className="document-import-file">
            <div>
              <strong>{draft.source.name}</strong>
              <span>{kindLabel} · {formatBytes(draft.source.size)}</span>
            </div>
            <span className="document-import-ready">{t('import.ready')}</span>
          </div>

          <label className="document-import-field">讲义名称<input value={title} maxLength={1000} disabled={saving} onChange={(e) => { setTitle(e.target.value); if (rootTitle === title) setRootTitle(e.target.value) }} /></label>
          <label className="document-import-field">导图根标题<input value={rootTitle} maxLength={1000} disabled={saving} onChange={(e) => setRootTitle(e.target.value)} /></label>
          {course && <label className="document-import-field">{course.existing ? '加入已有课程' : '新课程名称'}<input value={course.existing ? course.name : courseName} maxLength={120} disabled={saving || course.existing} onChange={(e) => setCourseName(e.target.value)} /></label>}
          <p>名称由材料结构推测，请核对课程、讲义和教师信息。这里只生成讲义结构，不会自动调用 AI。</p>

          <dl className="document-import-stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <section className="document-import-preview" aria-label={t('import.preview')}>
            <h3>{t('import.preview')}</h3>
            {draft.doc.nodes[draft.doc.rootId]?.children.length ? (
              <ImportTree doc={tree} parentId={tree.rootId} onSelect={setSelectedNodeId} />
            ) : (
              <p>{t('import.noPreview')}</p>
            )}
          </section>

          {selectedNode && <fieldset disabled={saving}><legend>调整选中节点</legend>
            <label className="document-import-field">节点标题<input maxLength={1000} value={selectedNode.text} onChange={(e) => { const text = e.target.value; setTree((doc) => ({ ...doc, nodes: { ...doc.nodes, [selectedNodeId]: { ...doc.nodes[selectedNodeId], text } } })) }} /></label>
            <label className="document-import-field">所属节点<select value={selectedNode.parent ?? tree.rootId} onChange={(e) => { const parentId = e.target.value; setTree((doc) => moveImportNode(doc, selectedNodeId, parentId)) }}>{Object.values(tree.nodes).filter((node) => canMoveImportNode(tree, selectedNodeId, node.id)).map((node) => <option value={node.id} key={node.id}>{node.id === tree.rootId ? rootTitle : node.text || '未命名节点'}</option>)}</select></label>
            <button className="tbtn" onClick={() => setSelectedNodeId('')}>结束调整</button>
          </fieldset>}

          {draft.warnings.length > 0 && (
            <ul className="document-import-warnings">
              {draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <p className="document-import-support">{t('import.currentSupport')}</p>
          {error && <div className="document-import-error" role="alert">{t('import.failed')}{error}</div>}
        </div>
        <div className="focus-perch" data-isis-perch/>
        <div className="document-import-actions">
          <button className="tbtn" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button className="tbtn primary" data-guide="confirm-import" onClick={() => void confirm()} disabled={saving}>
            {saving ? t('import.saving') : t('import.create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ImportTree({ doc, parentId, onSelect, depth = 0 }: { doc: DocData; parentId: string; onSelect: (id: string) => void; depth?: number }) {
  if (depth > 32) return <p>更深层级可在导入后查看。</p>
  return <ul>{doc.nodes[parentId]?.children.map((id) => {
    const node = doc.nodes[id]
    if (!node) return null
    return <li key={id}>{node.children.length ? <details open={depth < 1}><summary>{node.text}</summary><ImportTree doc={doc} parentId={id} onSelect={onSelect} depth={depth + 1} /></details> : <span>{node.text}</span>} <button className="tbtn" onClick={() => onSelect(id)} aria-label={`调整节点：${node.text}`}>调整</button></li>
  })}</ul>
}
