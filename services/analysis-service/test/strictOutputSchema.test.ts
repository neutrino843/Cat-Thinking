import { describe, expect, it } from 'vitest'
import { ARTIFACT_KINDS } from '@cat-thinking/analysis-contracts'
import { artifactOutputSchema } from '../src/providers/artifactPrompts.js'
import { normalizeOptionalNulls, strictOutputSchema } from '../src/providers/strictOutputSchema.js'
import { configuredCostEstimator } from '../src/providers/configuredCostEstimator.js'
import { loadAnalysisServiceConfig } from '../src/config.js'

describe('strict provider schemas and configured costs', () => {
  it('requires all object fields in all five schemas including recursive definitions', () => {
    for (const kind of ARTIFACT_KINDS) {
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(visit); return }
        const object = node as Record<string, unknown>
        if (object.type === 'object') {
          expect(object.additionalProperties).toBe(false)
          expect(object.required).toEqual(Object.keys(object.properties as object))
        }
        Object.values(object).forEach(visit)
      }
      visit(strictOutputSchema(artifactOutputSchema(kind)))
    }
  })
  it('omits optional nulls while preserving required nullable parentId and recursive grounding', () => {
    const citation = { version: 1, provenance: 'source', sourceId: 'source', start: 0, end: 1, quote: null, page: null, locator: null }
    const normalized = normalizeOptionalNulls({ title: 'map', nodes: [{ id: 'root', parentId: null, text: 'root', note: null,
      evidenceIds: ['claim'], citations: [citation] }], relations: [] }, artifactOutputSchema('mindmap'))
    expect(normalized).toEqual({ title: 'map', nodes: [{ id: 'root', parentId: null, text: 'root',
      evidenceIds: ['claim'], citations: [{ version: 1, provenance: 'source', sourceId: 'source', start: 0, end: 1 }] }], relations: [] })
    const outline = normalizeOptionalNulls({ title: 'outline', nodes: [{ id: 'a', title: 'A', summary: null, evidenceIds: [], citations: [],
      children: [{ id: 'b', title: 'B', summary: null, evidenceIds: [], citations: [], children: [] }] }] }, artifactOutputSchema('outline'))
    expect(JSON.stringify(outline)).not.toContain('summary')
    expect(normalizeOptionalNulls({ unknown: null }, { type: 'object', properties: {} })).toEqual({ unknown: null })
    expect(normalizeOptionalNulls(null, {})).toBeNull()
    expect(normalizeOptionalNulls([], {})).toEqual([])
    expect(normalizeOptionalNulls({ a: 'x' }, { anyOf: [{ type: 'string' }] })).toEqual({ a: 'x' })
    expect(normalizeOptionalNulls({ x: null }, { $defs: { 'slash/key': { type: 'object', properties: { x: { type: 'string' } } } }, $ref: '#/$defs/slash~1key' })).toEqual({})
  })
  it('fails closed without explicit price bounds and computes a rounded conservative reservation', () => {
    expect(configuredCostEstimator({ mode: 'disabled' })).toBeUndefined()
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_PROVIDER_MODE: 'openai-compatible',
      ANALYSIS_PROVIDER_ID: 'synthetic', ANALYSIS_PROVIDER_BASE_URL: 'https://synthetic.example.test/v1',
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'synthetic.example.test', ANALYSIS_PROVIDER_API_KEY: 'synthetic-placeholder-key',
      ANALYSIS_PROVIDER_MODEL_ID: 'synthetic', ANALYSIS_PROVIDER_PROFILE_VERSION: 'synthetic-v1',
    }).provider
    expect(configuredCostEstimator(config)).toBeUndefined()
    if (config.mode === 'disabled') throw new Error('fixture configuration failed')
    const estimate = configuredCostEstimator({ ...config, inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 })!
    const input = { providerId: 'synthetic', modelId: 'synthetic', profile: { id: 'route', providerId: 'synthetic', modelId: 'synthetic',
      profileVersion: 'synthetic-v1', promptId: 'artifact.summary', promptVersion: 'artifact-v1', roles: ['artifact-summary' as const], qualityProfiles: ['standard' as const], priority: 0 }, estimatedInputTokens: 3, reservedOutputTokens: 4 }
    expect(estimate(input)).toBe(11)
    expect(() => estimate({ ...input, estimatedInputTokens: Number.MAX_SAFE_INTEGER })).toThrow('safe integer')
  })
})
