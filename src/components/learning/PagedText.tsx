/** Full passage; no viewport slicing or artificial text pages. */
export default function SourcePassage({ text, label = '原文' }: { text: string; label?: string }) {
  return <blockquote aria-label={label}>{text}</blockquote>
}
