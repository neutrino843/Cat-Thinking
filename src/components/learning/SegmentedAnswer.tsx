/** Continuous editing: the complete answer remains in one field. */
export default function StudyAnswer({ value, onChange, label, disabled = false, maxLength = 10000 }: { value: string; onChange: (value: string) => void; label: string; disabled?: boolean; maxLength?: number }) {
  return <textarea aria-label={label} rows={6} maxLength={maxLength} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
}
