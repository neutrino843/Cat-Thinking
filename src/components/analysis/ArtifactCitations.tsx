import type { CitationV1, SourceCitationV1 } from '@cat-thinking/analysis-contracts'

export type OpenArtifactCitation = (citation: SourceCitationV1) => void

export default function ArtifactCitations({ citations, onOpen }: { citations: CitationV1[]; onOpen: OpenArtifactCitation }) {
  return <span className="analysis-citations">{citations.map((citation, index) => citation.provenance === 'source'
    ? <button className="tbtn" key={`${citation.sourceId}:${citation.start}:${citation.end}:${index}`} onClick={() => onOpen(citation)} aria-label={`查看原文引用 ${index + 1}`}>原文 {index + 1}{citation.page ? ` · p${citation.page}` : ''}</button>
    : <small key={index}>{citation.provenance === 'inference' ? `推断${citation.label ? `：${citation.label}` : ''}` : '外部资料'}</small>)}</span>
}
