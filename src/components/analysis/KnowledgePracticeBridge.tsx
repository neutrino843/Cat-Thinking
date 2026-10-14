import { useId, useState } from 'react'
import type { MindMapEnvelope } from '../../analysis/mindMapApplication'
import type { QuizEnvelope } from '../../analysis/quizPractice'
import type { KnowledgePracticeNavigation } from './useKnowledgePracticeNavigation'

const PAGE_SIZE = 20
/** Navigation is shared with node, question and review entries; answers remain in QuizResult. */
export default function KnowledgePracticeBridge({ mindmap, quiz, navigation }: {
  mindmap: MindMapEnvelope; quiz: QuizEnvelope; navigation: KnowledgePracticeNavigation
}) {
  const [selection, setSelection] = useState('')
  const [page, setPage] = useState(0)
  const selectorId = useId()
  const { view, jumping, jump } = navigation
  const ready = view.status === 'ready'
  const nodes = ready ? mindmap.payload.nodes.filter((node) => node.evidenceIds.length > 0) : []
  const selectedNodeId = selection || nodes[0]?.id || ''
  const related = ready ? view.result.links.filter((link) => link.nodeId === selectedNodeId) : []
  const pages = Math.max(1, Math.ceil(related.length / PAGE_SIZE))
  const visible = related.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const questionIndices = new Map(quiz.payload.questions.map((question, index) => [question.id, index]))
  return <section className="analysis-knowledge-practice" aria-label="知识与练习联动">
    <h3>知识与练习联动</h3>
    <p>选择知识节点，查看本次分析中有共同原文依据的题目。共同依据表示相关，不能用来认定已经掌握。</p>
    {view.status === 'loading' ? <p role="status">正在核对本次知识与练习…</p>
      : view.status !== 'ready' ? <><p role="status">当前无法确认知识与练习的有效关联，请恢复查看并核对来源。</p><button className="tbtn" onClick={navigation.reload}>重新核对关联</button></>
        : <>
          {nodes.length > 0 ? <div className="analysis-knowledge-practice-controls">
            <label htmlFor={selectorId}>选择知识节点</label>
            <select id={selectorId} value={selectedNodeId} onChange={(event) => { setSelection(event.target.value); setPage(0) }}>
              {nodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {node.text}</option>)}
            </select>
            <button className="tbtn" disabled={jumping || !related.length} onClick={() => void jump('node', selectedNodeId)}>查看知识节点</button>
          </div> : <p role="status">本次没有可供联动的知识节点。</p>}
          {selectedNodeId && (related.length > 0 ? <>
            <p role="status">这个节点有 {related.length} 道相关练习。跳转保留已有作答，不会生成新任务。</p>
            <ul className="analysis-knowledge-practice-questions">{visible.map((link) => {
              const index = questionIndices.get(link.questionId)
              if (index === undefined) return null
              return <li key={link.questionId}><span>第 {index + 1} 题：{quiz.payload.questions[index].prompt}</span>
                <button className="tbtn" disabled={jumping} onClick={() => void jump('question', link.questionId)}>查看第 {index + 1} 题</button></li>
            })}</ul>
            {pages > 1 && <div className="analysis-knowledge-practice-controls" aria-label="相关练习分页">
              <button className="tbtn" disabled={page === 0 || jumping} onClick={() => setPage((value) => value - 1)}>上一页</button>
              <span>第 {page + 1} / {pages} 页</span>
              <button className="tbtn" disabled={page + 1 >= pages || jumping} onClick={() => setPage((value) => value + 1)}>下一页</button>
            </div>}
          </> : <p role="status">这个节点暂无可准确对应的相关练习。</p>)}
          {jumping && <p role="status">正在核对并定位…</p>}
        </>}
  </section>
}
