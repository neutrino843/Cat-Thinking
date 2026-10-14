import { describe, expect, it } from 'vitest'
import { engineCapabilitiesSchema } from '../src/api.js'

const legacyCapabilities = {
  service: 'cat-analysis-engine', serviceVersion: 'synthetic-v1', acceptsRuns: false, degradedReasons: [],
  contractVersions: [1], qualityProfiles: ['standard'], artifactKinds: ['summary'],
  maxSourcesPerRun: 20, maxSourceCharacters: 2000000, maxUploadPartBytes: 512000,
  supportsSse: true, supportsCancellation: true, supportsExternalKnowledge: false, retentionSeconds: 3600,
}

describe('selected character capability contract', () => {
  it('preserves compatibility with capabilities that omit the selection limit', () => {
    expect(engineCapabilitiesSchema.parse(legacyCapabilities).maxSelectedCharacters).toBeUndefined()
  })
  it.each([1, 100000, Number.MAX_SAFE_INTEGER])('accepts a positive safe integer selection limit %i', (maximum) => {
    const capabilities = engineCapabilitiesSchema.parse({ ...legacyCapabilities, maxSelectedCharacters: maximum })
    expect(capabilities.maxSelectedCharacters).toBe(maximum)
    expect(capabilities.maxSourceCharacters).toBe(2000000)
  })
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100000', null])(
    'rejects invalid selection limit %s', (maximum) => {
      expect(engineCapabilitiesSchema.safeParse({ ...legacyCapabilities, maxSelectedCharacters: maximum }).success).toBe(false)
    },
  )
})
