import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentImportDraft } from '../lib/documentImport'
import { useT } from '../i18n'

interface Props {
  draft: DocumentImportDraft
  onClose: () => void
  onConfirm: () => Promise<void>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DocumentImportDialog({ draft, onClose, onConfirm }: Props) {
  const t = useT()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const confirm = async () => {
    setSaving(true)
    setError('')
    try {
      await onConfirm()
    } catch (reason) {
      setError((reason as Error).message || t('import.failed'))
      setSaving(false)
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
  }[draft.source.kind]

  return createPortal(
    <div className="modal-mask" onPointerDown={() => !saving && onClose()}>
      <div
        className="modal document-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-import-title"
        onPointerDown={(event) => event.stopPropagation()}
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

          <div className="document-import-target">
            <span>{t('import.mapTitle')}</span>
            <strong>{draft.doc.title}</strong>
          </div>

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
            {draft.preview.length ? (
              <ol>
                {draft.preview.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
              </ol>
            ) : (
              <p>{t('import.noPreview')}</p>
            )}
          </section>

          {draft.warnings.length > 0 && (
            <ul className="document-import-warnings">
              {draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <p className="document-import-support">{t('import.currentSupport')}</p>
          {error && <div className="document-import-error" role="alert">{t('import.failed')}{error}</div>}
        </div>
        <div className="document-import-actions">
          <button className="tbtn" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button className="tbtn primary" onClick={() => void confirm()} disabled={saving}>
            {saving ? t('import.saving') : t('import.create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
