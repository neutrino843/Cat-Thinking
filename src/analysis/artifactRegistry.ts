import { ARTIFACT_KINDS, artifactKindSchema, type AnalysisOptionsV1, type ArtifactKind } from '@cat-thinking/analysis-contracts'

export const ARTIFACT_REGISTRY = {
  summary: { label: '摘要', resultLabel: '摘要结果', dependencies: [] },
  outline: { label: '大纲', resultLabel: '大纲结果', dependencies: [] },
  mindmap: { label: '导图', resultLabel: '导图结果', dependencies: ['outline'] },
  quiz: { label: '测验', resultLabel: '测验结果', dependencies: [] },
  knowledge: { label: '知识整理', resultLabel: '知识整理结果', dependencies: [] },
} as const satisfies Record<ArtifactKind, { label: string; resultLabel: string; dependencies: readonly ArtifactKind[] }>

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptionsV1 = {
  locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 5, externalKnowledge: false,
}
export const QUIZ_QUESTION_COUNTS = [5, 10, 20] as const

export function artifactDependencyClosure(selected: readonly ArtifactKind[]): ArtifactKind[] {
  const requested = new Set<ArtifactKind>()
  const include = (kind: ArtifactKind) => {
    artifactKindSchema.parse(kind)
    if (requested.has(kind)) return
    requested.add(kind)
    for (const dependency of ARTIFACT_REGISTRY[kind].dependencies) include(dependency)
  }
  selected.forEach(include)
  return ARTIFACT_KINDS.filter((kind) => requested.has(kind))
}
