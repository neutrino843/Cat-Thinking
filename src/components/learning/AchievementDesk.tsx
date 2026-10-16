import { useState } from 'react'
import { learningAchievements } from '../../learning/achievements'
import type { CourseSnapshot } from '../../learning/model'
import StudyDialog from './StudyDialog'

export default function AchievementDesk({ snapshots, onClose, onRecords }: { snapshots: CourseSnapshot[]; onClose: () => void; onRecords: (courseId: string) => void }) {
  const [page, setPage] = useState(0)
  const items = learningAchievements(snapshots)
  const item = items[page]
  return <StudyDialog title="我的学习纪念" onClose={onClose}>
    <p className="focus-muted">每一件纪念都有真实记录。错过几天，也不会失去它。</p>
    <article className={`achievement-item ${item.evidence ? 'is-earned' : ''}`}>
      <span className="achievement-bookmark" aria-hidden="true">{item.evidence ? '✦' : '·'}</span>
      <h3>{item.title}</h3><p>{item.detail}</p>
      <p>{item.evidence ? `${item.evidence.date} · 已获得${item.reward}` : `等待留下这份记录 · ${item.reward}`}</p>
      {item.evidence && <button className="study-button" onClick={() => { onRecords(item.evidence?.courseId ?? ''); onClose() }}>查看学习记录</button>}
    </article>
    <div className="focus-actions"><button className="study-button" disabled={!page} onClick={() => setPage(page - 1)}>上一件</button><span>{page + 1} / {items.length}</span><button className="study-button" disabled={page === items.length - 1} onClick={() => setPage(page + 1)}>下一件</button></div>
    <p className="focus-muted">完成行为不代表已掌握。旧记录缺少来源标记时不推测补发；删除学习证据后，对应纪念会重新计算。</p>
  </StudyDialog>
}
