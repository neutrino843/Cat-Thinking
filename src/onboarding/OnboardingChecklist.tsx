import { useOnboarding, onboardingSetExpanded, ONBOARDING_ITEMS, type OnboardingItemId } from './onboarding'

const ITEM_DESCRIPTIONS: Record<OnboardingItemId, string> = {
  import: '带一份自己的讲义或笔记，支持 TXT、Word、PDF、PPTX',
  'first-question': '用原文完成一道填空题，检验理解',
  'ai-analysis': '生成知识结构与测验，需要连接 AI',
  'save-practice': '把分析结果保存到课程，开始练习',
  'return-tomorrow': '今天完成，明天回来复习巩固',
}

const ITEM_ACTIONS: Record<OnboardingItemId, { label: string; target: string }> = {
  import: { label: '导入资料', target: 'import' },
  'first-question': { label: '开始第一题', target: 'guide' },
  'ai-analysis': { label: '去 AI 分析', target: 'analysis' },
  'save-practice': { label: '去保存', target: 'analysis' },
  'return-tomorrow': { label: '查看复习', target: 'practice' },
}

interface OnboardingChecklistProps {
  onAction: (target: string) => void
}

/** 新手任务清单：B顶步骤条 + C中当前任务聚焦 + A清单折叠展开 */
export default function OnboardingChecklist({ onAction }: OnboardingChecklistProps) {
  const { progress } = useOnboarding()
  const doneCount = ONBOARDING_ITEMS.filter((item) => progress.items[item.id].done).length
  const currentIndex = ONBOARDING_ITEMS.findIndex((item) => item.id === progress.currentItem)
  const current = ONBOARDING_ITEMS[currentIndex] ?? ONBOARDING_ITEMS[0]
  const allDone = doneCount === ONBOARDING_ITEMS.length

  if (allDone) return null

  return (
    <section className="onboarding-checklist" aria-label="新手任务清单">
      {/* B 顶：五格步骤条 */}
      <div className="onboarding-steps" role="list" aria-label="新手任务进度">
        {ONBOARDING_ITEMS.map((item, index) => {
          const done = progress.items[item.id].done
          const isCurrent = item.id === progress.currentItem
          return (
            <div
              key={item.id}
              role="listitem"
              className={`onboarding-step ${done ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="onboarding-step-number">{done ? '✓' : index + 1}</span>
              <span className="onboarding-step-name">{item.name}</span>
            </div>
          )
        })}
      </div>

      {/* C 中：当前任务聚焦 */}
      <div className="onboarding-current">
        <p className="onboarding-current-label">当前这件 · 第 {currentIndex + 1} 件，共 {ONBOARDING_ITEMS.length} 件</p>
        <h2>{current.name}</h2>
        <p>{ITEM_DESCRIPTIONS[current.id]}</p>
        <div className="focus-actions">
          <button className="study-button study-button-primary" onClick={() => onAction(ITEM_ACTIONS[current.id].target)}>
            {ITEM_ACTIONS[current.id].label}
          </button>
          {current.id !== 'import' && (
            <button className="study-text-button" onClick={() => onAction('import')}>先导入资料</button>
          )}
        </div>
      </div>

      {/* A 底：完整清单折叠 */}
      <div className="onboarding-toggle">
        <button
          className="study-text-button"
          aria-expanded={progress.expanded}
          onClick={() => onboardingSetExpanded(!progress.expanded)}
        >
          {progress.expanded ? '收起全部任务' : `查看全部 ${ONBOARDING_ITEMS.length} 件新手任务`}
        </button>
      </div>

      {progress.expanded && (
        <div className="onboarding-full-list">
          {ONBOARDING_ITEMS.map((item, index) => {
            const done = progress.items[item.id].done
            const isCurrent = item.id === progress.currentItem
            const locked = index > currentIndex && !done
            return (
              <div key={item.id} className={`onboarding-task-item ${done ? 'done' : ''} ${isCurrent ? 'current' : ''} ${locked ? 'locked' : ''}`}>
                <span className="onboarding-task-status">{done ? '✓' : index + 1}</span>
                <div className="onboarding-task-info">
                  <strong>{item.name}</strong>
                  <p>{ITEM_DESCRIPTIONS[item.id]}</p>
                </div>
                {isCurrent && !done && (
                  <button className="study-button study-button-primary" onClick={() => onAction(ITEM_ACTIONS[item.id].target)}>
                    {ITEM_ACTIONS[item.id].label}
                  </button>
                )}
                {locked && <span className="onboarding-task-hint">先完成上一件</span>}
                {done && <span className="onboarding-task-done-label">已完成</span>}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
