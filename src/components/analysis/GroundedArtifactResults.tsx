import type { ArtifactEnvelopeV1, OutlineNodeV1 } from '@cat-thinking/analysis-contracts'
import ArtifactCitations, { type OpenArtifactCitation } from './ArtifactCitations'

function OutlineNodes({ nodes, onOpen }: { nodes: OutlineNodeV1[]; onOpen: OpenArtifactCitation }) {
  return <ol>{nodes.map((node) => <li key={node.id}>
    <strong>{node.title}</strong>{node.summary && <p>{node.summary}</p>}
    <ArtifactCitations citations={node.citations} onOpen={onOpen} />
    {node.children.length > 0 && <OutlineNodes nodes={node.children} onOpen={onOpen} />}
  </li>)}</ol>
}

const RELATIONSHIPS = { prerequisite: '前置知识', analogy: '类比', application: '应用', contrast: '对比', extension: '拓展' }

export default function GroundedArtifactResults({ artifact, onOpen }: { artifact: ArtifactEnvelopeV1; onOpen: OpenArtifactCitation }) {
  switch (artifact.kind) {
    case 'summary': return <>
      <p>{artifact.payload.overview.text}</p><ArtifactCitations citations={artifact.payload.overview.citations} onOpen={onOpen} />
      <ul>{artifact.payload.keyPoints.map((point) => <li key={point.id}>{point.text}<ArtifactCitations citations={point.citations} onOpen={onOpen} /></li>)}</ul>
      {artifact.payload.confusions.map((point) => <p key={point.id}>需澄清：{point.text}<ArtifactCitations citations={point.citations} onOpen={onOpen} /></p>)}
      {artifact.payload.conclusion && <p>{artifact.payload.conclusion.text}<ArtifactCitations citations={artifact.payload.conclusion.citations} onOpen={onOpen} /></p>}
    </>
    case 'outline': return <><h4>{artifact.payload.title}</h4><OutlineNodes nodes={artifact.payload.nodes} onOpen={onOpen} /></>
    case 'knowledge': return <ul>{artifact.payload.items.map((item) => <li key={item.id}>
      <h4>{item.title} <small>{RELATIONSHIPS[item.relationship]} · {item.provenance === 'source' ? '原文依据' : item.provenance === 'inference' ? '推断' : '外部资料'}</small></h4>
      <p>{item.explanation}</p><ArtifactCitations citations={item.citations} onOpen={onOpen} />
    </li>)}</ul>
    default: return null
  }
}
