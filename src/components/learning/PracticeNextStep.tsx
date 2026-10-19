import { useState } from 'react'
import type { CourseSnapshot } from '../../learning/model'
import { learningDate } from '../../learning/reviewScheduler'
import { useLearningClock } from './useLearningClock'

/**
 * A4 练习完成下一步卡（界面2 定稿：B 双选项 + C 进度小结 + 勾选联动）。
 * 勾选联动：勾选「顺带复习」复选框后，主按钮文案实时联动为「复习 N 项，回到今日学习」；
 * 不勾选时主按钮保持「回到今日学习」。「练下一题」为常驻次选项（有下一题时显示）。
 * 边界态：journey（补学流程）与 simulated（模拟考）不渲染，由调用方条件保证。
 */
export default function PracticeNextStep({ snapshot, busy, hasNext, onGoToday, onNextQuestion }: { snapshot: CourseSnapshot; busy: boolean; hasNext: boolean; onGoToday: () => void; onNextQuestion: () => void }) {
  const [withReview, setWithReview] = useState(false)
  const now = useLearningClock()
  const today = learningDate(now, snapshot.course.timeZone)
  const todayCount = snapshot.attempts.filter((attempt) => attempt.learningDate === today && attempt.origin === 'practice').length
  const dueCount = snapshot.schedules.filter((schedule) => schedule.status === 'active' && schedule.dueDate <= today).length
  const reviewChecked = dueCount > 0 && withReview
  return <section className="practice-next-step" role="status" aria-label="练习完成，选择下一步">
    <h4>这题练完了。</h4>
    <p>今天已练 {todayCount} 题{dueCount > 0 ? `，另有 ${dueCount} 项复习已到期` : ''}。反馈和原文依据保留在本题下方，可随时回看。</p>
    {dueCount > 0 && <label className="practice-next-check">
      <input type="checkbox" checked={withReview} disabled={busy} onChange={(event) => setWithReview(event.target.checked)} />
      <span>回到今日学习时，顺带复习到期的 {dueCount} 项</span>
    </label>}
    <div className="practice-next-actions">
      <button className="tbtn primary" disabled={busy} onClick={onGoToday}>{reviewChecked ? `复习 ${dueCount} 项，回到今日学习` : '回到今日学习'}</button>
      {hasNext && <button className="tbtn" disabled={busy} onClick={onNextQuestion}>练下一题</button>}
    </div>
  </section>
}
