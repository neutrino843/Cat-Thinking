import { useEffect, useRef, type ReactNode } from 'react'

/** Native top layer keeps temporary help separate from the learning session. */
export default function StudyDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={dialog} className="focus-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}>
    <header><div className="focus-perch dialog-cat-place" data-isis-perch/><h2>{title}</h2><button type="button" className="study-text-button" aria-label={`关闭${title}`} onClick={onClose}>关闭</button></header>
    <div className="desk-dialog-content">{children}</div>
  </dialog>
}
