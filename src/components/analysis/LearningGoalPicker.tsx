import type { ArtifactKind } from '@cat-thinking/analysis-contracts'

const LEARNING_GOALS = [
  { label: '整理要点', kinds: ['summary', 'outline'], description: '先读摘要，再按大纲梳理重点。' },
  { label: '理解结构', kinds: ['outline', 'mindmap'], description: '用大纲与可编辑导图理清层级和联系。' },
  { label: '自测复习', kinds: ['quiz'], description: '先作答，再查看本次待复习内容与原文。' },
] as const satisfies readonly { label: string; kinds: readonly ArtifactKind[]; description: string }[]

/** Presets only change the selection. Generating always requires a separate click. */
export default function LearningGoalPicker({ kinds, availableKinds, disabled, onSelect }: {
  kinds: readonly ArtifactKind[]
  availableKinds?: readonly ArtifactKind[]
  disabled: boolean
  onSelect: (kinds: ArtifactKind[]) => void
}) {
  const current = LEARNING_GOALS.find((goal) => goal.kinds.length === kinds.length && goal.kinds.every((kind) => kinds.includes(kind)))
  return <fieldset disabled={disabled} className="analysis-learning-goals">
    <legend>这次想怎么学？</legend>
    <div className="analysis-actions">{LEARNING_GOALS.map((goal) => <button key={goal.label} type="button" className="tbtn"
      aria-pressed={current === goal} disabled={availableKinds !== undefined && goal.kinds.some((kind) => !availableKinds.includes(kind))}
      onClick={() => onSelect([...goal.kinds])}>{goal.label}</button>)}</div>
    <p className="analysis-source-caption">{current?.description ?? '已自定义内容，生成下方勾选的项目。'} 选择目标不会开始生成，可在下方继续调整。</p>
  </fieldset>
}
