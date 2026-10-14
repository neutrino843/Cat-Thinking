import { useRef, useState, type ReactNode } from 'react'
import type { ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { applyMindMapArtifact, type MindMapApplicationResult } from '../../analysis/mindMapApplication'
import { openDocById, emitDocsChanged } from '../../lib/tabs'
import ArtifactCitations, { type OpenArtifactCitation } from './ArtifactCitations'
import type { KnowledgePracticeNavigation } from './useKnowledgePracticeNavigation'
import { findArchiveForArtifact } from '../../learning/repository'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { sha256Hex } from '../../analysis/fingerprint'
import { artifactContentHash } from '../../analysis/localArtifactIdentity'

type MindMap = Extract<ArtifactEnvelopeV1, { kind: 'mindmap' }>

export default function MindMapResult({ artifact, disabled, onOpen, onClose, navigation }: {
  artifact: MindMap; disabled: boolean; onOpen: OpenArtifactCitation; onClose: () => void; navigation?: KnowledgePracticeNavigation
}) {
  const [result, setResult] = useState<MindMapApplicationResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const applying = useRef(false)
  const apply = async (learning = false) => {
    if (applying.current || disabled) return
    applying.current = true; setBusy(true); setError('')
    try {
      const archive = await findArchiveForArtifact(artifact.docId, artifact.runId, artifact.id, { artifactHash: await artifactContentHash(artifact) })
      if (learning && !archive) { setError('请先把本次结果保存到课程，再创建带有知识点关联的学习导图。'); return }
      const applicationIntentId = learning && archive ? await sha256Hex(canonicalizeJson({ originDocId: artifact.docId,
        runId: artifact.runId, artifactId: artifact.id, archiveId: archive.id, purpose: 'learning-map-v1' })) : undefined
      const saved = await applyMindMapArtifact({ originDocId: artifact.docId, runId: artifact.runId, artifact,
        ...(archive ? { archiveId: archive.id } : {}), ...(applicationIntentId ? { applicationIntentId } : {}) })
      setResult(saved); emitDocsChanged()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '创建导图失败，请重新读取任务后再试。') }
    finally { applying.current = false; setBusy(false) }
  }
  const nodes = new Map(artifact.payload.nodes.map((node) => [node.id, node]))
  const children = new Map<string | null, MindMap['payload']['nodes']>()
  for (const node of artifact.payload.nodes) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const renderNodes = (parentId: string | null, depth = 0): ReactNode => {
    if (depth > 32) return null
    return <ul>{(children.get(parentId) ?? []).map((node) => <li key={node.id} data-mindmap-node-id={node.id} tabIndex={-1}>
      <strong>{node.text}</strong>{node.note && <p>{node.note}</p>}
      {navigation?.view.status === 'ready' && (() => {
        const links = navigation.view.result.links.filter((link) => link.nodeId === node.id)
        return links.length > 0 ? <div className="analysis-actions" aria-label={`${node.text}的相关练习`}>
          <span>相关练习 {links.length} 题</span>{links.map((link, index) => <button className="tbtn" key={link.questionId} disabled={disabled || navigation.jumping}
            onClick={() => void navigation.jump('question', link.questionId)}>练习 {index + 1}</button>)}
        </div> : <p className="analysis-source-caption">本次没有可准确对应的题目。</p>
      })()}
      <ArtifactCitations citations={node.citations} onOpen={onOpen} />
      {children.has(node.id) && renderNodes(node.id, depth + 1)}
    </li>)}</ul>
  }
  return <>
    <h4>{artifact.payload.title}</h4>
    <p>创建一份独立导图，并复制引用原文。重复操作会找回同一份导图，保留手动修改。</p>
    <button className="tbtn primary" disabled={disabled || busy} onClick={() => void apply()}>创建独立导图</button>
    <button className="tbtn" disabled={disabled || busy} onClick={() => void apply(true)}>创建学习导图</button>
    <p className="analysis-source-caption">保存到课程后，「创建学习导图」会建立明确的节点关联。旧导图的手动编辑保留，旧节点不会按同名补绑。</p>
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{result.status === 'active'
      ? <>{result.reused ? '已找回之前创建的导图。' : '导图已保存。'} <button className="tbtn" onClick={() => void openDocById(result.targetDocId).then(onClose)}>打开生成导图</button></>
      : result.status === 'trashed' ? '之前创建的导图已在回收站，请先恢复。' : '之前创建的导图已永久删除，创建记录仍保留。'}</p>}
    <div className="analysis-mindmap-tree" aria-label="知识层级" data-mindmap-artifact-id={artifact.id}>{renderNodes(null)}</div>
    {artifact.payload.relations.length > 0 && <div role="region" aria-label="导图关系"><h4>关系与依据</h4><ul>{artifact.payload.relations.map((relation) => <li key={relation.id}>
      {nodes.get(relation.from)?.text} → {nodes.get(relation.to)?.text}{relation.label && `：${relation.label}`}
      <ArtifactCitations citations={relation.citations} onOpen={onOpen} />
    </li>)}</ul></div>}
  </>
}
