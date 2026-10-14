import { useState } from 'react'
import type { SourceCitationV1 } from '@cat-thinking/analysis-contracts'
import type { LearningArchive } from '../../learning/model'
import GroundedArtifactResults from '../analysis/GroundedArtifactResults'
import ArtifactCitations from '../analysis/ArtifactCitations'
import { sourceExcerpt } from '../../learning/workspaceView'

const NAMES = { summary: '摘要', outline: '大纲', mindmap: '导图', quiz: '测验', knowledge: '知识整理' }
export default function ArchiveDetails({ archive }: { archive: LearningArchive }) {
  const [citation, setCitation] = useState<SourceCitationV1>()
  const quote = citation && sourceExcerpt(archive, citation.sourceId, citation.start, citation.end)
  return <details className="learning-section"><summary>查看已保存内容与分析范围</summary>
    <p>以下内容来自保存时的分析，不受原任务删除或到期影响。不同分析各自保留，内容仍需核对。</p>
    {archive.manifest.sources.map((snapshot) => {
      const source = archive.sources.find((s) => s.id === snapshot.sourceId)
      const start = snapshot.selectedRange?.start ?? 0; const end = snapshot.selectedRange?.end ?? snapshot.charCount
      const covered = (snapshot.locators ?? []).filter((locator) => locator.end > start && locator.start < end)
      return <section key={snapshot.sourceId}><h5>{source?.name ?? '已保存来源'}</h5><p>本次范围：字符 {start}–{end} / 总计 {snapshot.charCount} 字符。尚未选入 {Math.max(0, snapshot.charCount - (end - start))} 字符。</p>
        {covered.length > 0 && <p>选入的标题范围：{[...new Set(covered.map((l) => l.titlePath.join(' / ') || (l.page ? `第 ${l.page} 页` : '正文')))].join('、')}</p>}
        <p>范围只表示输入处理范围，不表示其中每个概念都已有练习或得到充分验证。</p>
      </section>
    })}
    {quote && <section className="learning-feedback" aria-label="归档原文引用"><strong>{quote.name}</strong><small>{quote.location}</small><blockquote>{quote.quote}</blockquote>{quote.truncated && <p>仅展示前 4,000 字符。</p>}<button className="tbtn" onClick={() => setCitation(undefined)}>收起引用</button></section>}
    {archive.artifacts.map((artifact) => <details key={artifact.id}><summary>{NAMES[artifact.kind]}</summary>
      {artifact.kind === 'mindmap' ? <ul>{artifact.payload.nodes.map((node) => <li key={node.id}><strong>{node.text}</strong><p>{node.note}</p><ArtifactCitations citations={node.citations} onOpen={setCitation} /></li>)}</ul>
        : artifact.kind === 'quiz' ? <p>已保存 {artifact.payload.questions.length} 道题。请到练习页先回答再查看参考答案。</p>
          : <GroundedArtifactResults artifact={artifact} onOpen={setCitation} />}
    </details>)}
  </details>
}
