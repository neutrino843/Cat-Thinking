import { describe, expect, it } from 'vitest'
import { ANALYSIS_LIMITS, ARTIFACT_KINDS, analysisOptionsSchema, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import { ARTIFACT_REGISTRY, DEFAULT_ANALYSIS_OPTIONS, QUIZ_QUESTION_COUNTS, artifactDependencyClosure } from './artifactRegistry'

describe('artifact product registry', () => {
  it('declares every contract kind with distinct usable labels', () => {
    expect(Object.keys(ARTIFACT_REGISTRY).sort()).toEqual([...ARTIFACT_KINDS].sort())
    expect(new Set(Object.values(ARTIFACT_REGISTRY).map((entry) => entry.resultLabel)).size).toBe(ARTIFACT_KINDS.length)
    for (const entry of Object.values(ARTIFACT_REGISTRY)) {
      expect(entry.label.trim()).not.toBe('')
      expect(entry.resultLabel.trim()).not.toBe('')
    }
  })
  it('includes Outline for MindMap in contract order without duplicating explicit dependencies', () => {
    expect(artifactDependencyClosure(['mindmap'])).toEqual(['outline', 'mindmap'])
    expect(artifactDependencyClosure(['quiz', 'mindmap', 'outline', 'mindmap', 'summary']))
      .toEqual(['summary', 'outline', 'mindmap', 'quiz'])
  })
  it('preserves independent selections and never mutates the caller input', () => {
    const selected = Object.freeze(['knowledge', 'summary'] as const)
    expect(artifactDependencyClosure(selected)).toEqual(['summary', 'knowledge'])
    expect(selected).toEqual(['knowledge', 'summary'])
    expect(artifactDependencyClosure([])).toEqual([])
    expect(artifactDependencyClosure([...ARTIFACT_KINDS].reverse())).toEqual(ARTIFACT_KINDS)
  })
  it('rejects unrecognized or path-shaped kinds before resolving dependencies', () => {
    for (const kind of ['unknown', '../outline', '', '__proto__', 'Summary']) {
      expect(() => artifactDependencyClosure([kind as ArtifactKind])).toThrow()
    }
  })
  it('uses valid grounded defaults and constrains each exposed quiz option to contract capacity', () => {
    expect(analysisOptionsSchema.parse(DEFAULT_ANALYSIS_OPTIONS)).toEqual(DEFAULT_ANALYSIS_OPTIONS)
    expect(DEFAULT_ANALYSIS_OPTIONS.externalKnowledge).toBe(false)
    expect(QUIZ_QUESTION_COUNTS).toEqual([5, 10, 20])
    for (const quizQuestionCount of QUIZ_QUESTION_COUNTS) {
      expect(quizQuestionCount).toBeLessThanOrEqual(ANALYSIS_LIMITS.maxQuizQuestions)
      expect(analysisOptionsSchema.parse({ ...DEFAULT_ANALYSIS_OPTIONS, quizQuestionCount }).quizQuestionCount).toBe(quizQuestionCount)
    }
  })
})
