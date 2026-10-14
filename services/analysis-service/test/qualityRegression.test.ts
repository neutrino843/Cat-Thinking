import { describe, expect, it } from 'vitest'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { verifyPersonalQualitySample } from '../src/operations/personalProviderVerification.js'
import { evaluatePublicQuality } from '../src/operations/qualityEvaluation.js'
import { QUALITY_SAMPLES, qualitySampleHash } from '../src/operations/qualityCorpus.js'
import { MemoryPersonalProfileStore, personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { FakeAnalysisProvider } from './fixtures/fakeAnalysisProvider.js'

async function fixture() {
  const store = new InMemoryJobStore(); const profiles = new MemoryPersonalProfileStore(store)
  await profiles.save(0, personalFixtureSettings()); await profiles.setCheck(1, 'ready'); await profiles.setEnabled(2, true)
  const fake = new FakeAnalysisProvider()
  const createProvider = (snapshot: { id: string }) => ({ id: fake.id, modelId: fake.modelId, profileVersion: snapshot.id,
    capabilities: fake.capabilities, isReady: () => true, generate: fake.generate.bind(fake) })
  return { store, profiles, fake, createProvider }
}
describe('bounded public quality corpus', () => {
  it.each(QUALITY_SAMPLES)('validates five outputs from $id, retains usage and never approves semantics automatically', async (sample) => {
    const f = await fixture(); const state = await f.profiles.readState()
    const result = await verifyPersonalQualitySample({ ...f, maxRunTokens: 50000 }, sample.id)
    expect(result.failures, JSON.stringify(await f.store.getRunLedgerUsage(result.tenantId!, result.runId!))).toEqual([])
    expect(result).toMatchObject({ outcome: 'passed', callsUsed: 6, cleanupComplete: true, profileStateUnchanged: true,
      sample: { hash: qualitySampleHash(sample) }, usage: { inputTokens: 120, outputTokens: 60 } })
    expect(await f.profiles.readState()).toEqual(state)
    const quality = evaluatePublicQuality(sample.id, result)
    expect(quality).toMatchObject({ pipelinePassed: true, exactReferencesPassed: true, modelQualityApproved: false, semanticReviewStatus: 'pending' })
    expect(quality.artifactChecks).toHaveLength(5)
    expect(quality.quiz.humanReview).toHaveLength(5)
    expect(await f.store.listArtifactDescriptors(result.tenantId!, result.runId!)).toEqual([])
  })
  it('rejects unknown samples and invalid token limits before any model request', async () => {
    const f = await fixture()
    await expect(verifyPersonalQualitySample(f, 'user-upload')).rejects.toThrow('unknown public')
    for (const maxRunTokens of [0, 200001, NaN]) await expect(verifyPersonalQualitySample({ ...f, maxRunTokens }, 'photosynthesis')).rejects.toThrow('token cap')
    expect(f.fake.calls).toHaveLength(0)
  })
  it('refuses a full workflow when the token reservation cap is insufficient', async () => {
    const f = await fixture()
    const result = await verifyPersonalQualitySample({ ...f, maxRunTokens: 1 }, 'photosynthesis')
    expect(result.callsUsed).toBe(0)
    expect(result.outcome).not.toBe('passed')
  })
  it('rejects sample mismatch and detects altered exact quotations without assigning semantic approval', async () => {
    const f = await fixture(); const result = await verifyPersonalQualitySample(f, 'photosynthesis')
    expect(() => evaluatePublicQuality('search-experiment', result)).toThrow('another sample')
    const changed = structuredClone(result)
    const citation = changed.artifacts.summary!.overview.citations[0]!
    if (citation.provenance !== 'source') throw new Error('expected source')
    citation.quote = 'invented quotation'
    expect(evaluatePublicQuality('photosynthesis', changed).exactReferencesPassed).toBe(false)
  })
})
