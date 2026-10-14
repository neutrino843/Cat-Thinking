import {
  ARTIFACT_KINDS, type AnalysisRunV1, type ProviderRouteV1,
} from '@cat-thinking/analysis-contracts'
import { describe, expect, it, vi } from 'vitest'
import { RunService } from '../src/domain/runService.js'
import { ARTIFACT_REFERENCE_DRAFT_VERSION, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION,
  ARTIFACT_SOURCE_REFERENCE_VERSIONS } from '../src/domain/artifactPolicyVersions.js'
import { InMemoryJobStore } from '../src/infrastructure/memoryJobStore.js'
import { createAnalysisProviderRuntime } from '../src/providers/analysisProviderRuntime.js'
import { persistedArtifactProtocol } from '../src/providers/artifactProtocolPolicy.js'
import { artifactPromptVersion, REPAIR_PROMPT_VERSION } from '../src/providers/artifactPrompts.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, EVIDENCE_MAP_PROMPT_VERSION,
  EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION } from '../src/providers/evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION } from '../src/providers/evidenceRepairPrompt.js'
import { FakeAnalysisProvider, FIXTURE_TENANT, FIXTURE_TEXT, fixtureHash, fixtureRequest } from './fixtures/fakeAnalysisProvider.js'

const signal = () => new AbortController().signal
const route = (promptVersion: string, changes: Partial<ProviderRouteV1> = {}): ProviderRouteV1 => ({
  providerId: 'synthetic-provider', modelId: 'synthetic-model', profileVersion: 'synthetic-v1', promptVersion, ...changes,
})
const prepare = async (key: string, providerProfileId?: string) => {
  const store = new InMemoryJobStore()
  const service = new RunService({ store, retentionSeconds: 3600,
    providerProfileMode: providerProfileId ? 'personal' : 'deployment' })
  const created = await service.createRun(FIXTURE_TENANT, { ...fixtureRequest(`protocol-${key}`),
    ...(providerProfileId ? { providerProfileId } : {}) })
  await service.uploadSource(FIXTURE_TENANT, created.run.id, {
    version: 1, sourceId: 'synthetic-source', contentHash: fixtureHash(FIXTURE_TEXT), partHash: fixtureHash(FIXTURE_TEXT),
    partIndex: 0, partCount: 1, start: 0, end: FIXTURE_TEXT.length, totalChars: FIXTURE_TEXT.length, text: FIXTURE_TEXT,
  })
  await service.startRun(FIXTURE_TENANT, created.run.id, created.run.revision)
  const runtime = (provider = new FakeAnalysisProvider(), expectedPersonalProfileId?: string) => createAnalysisProviderRuntime({
    store, provider, broker: service.broker, leaseMs: 1000, estimateCostMicros: () => 1, expectedPersonalProfileId,
  })
  return { store, service, runId: created.run.id, runtime }
}
type Fixture = Awaited<ReturnType<typeof prepare>>
const requireRun = async (f: Fixture): Promise<AnalysisRunV1> => {
  const run = await f.store.getRun(FIXTURE_TENANT, f.runId)
  if (!run) throw new Error('public fixture run missing')
  return run
}
const persistRoutes = async (f: Fixture, routes: readonly ProviderRouteV1[]): Promise<void> => {
  const current = await requireRun(f)
  const result = await f.store.transitionRun(FIXTURE_TENANT, f.runId, current.revision, (run, sequence) => ({
    run: { ...run, providerRoutes: [...routes], revision: run.revision + 1 },
    event: { version: 1, type: 'stage.started', eventId: `public-protocol-seed-${sequence}`, runId: run.id,
      runRevision: run.revision + 1, sequence, createdAt: Date.now(), stage: 'mapping' },
  }))
  expect(result.outcome).toBe('updated')
}
const snapshot = async (f: Fixture) => ({
  run: await requireRun(f), source: await f.store.getSourceContent(FIXTURE_TENANT, f.runId, 'synthetic-source'),
  graph: await f.store.getEvidenceGraph(FIXTURE_TENANT, f.runId), usage: await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId),
  events: await f.store.listEvents(FIXTURE_TENANT, f.runId), artifacts: await f.store.listArtifactDescriptors(FIXTURE_TENANT, f.runId),
})

describe('persisted Artifact protocol family', () => {
  it('selects the current family only for a run with no prior Provider routes', async () => {
    const f = await prepare('unstarted-policy')
    const run = await requireRun(f)
    expect(run.providerRoutes).toEqual([])
    expect(persistedArtifactProtocol(run)).toBe('source-reference')
    expect(persistedArtifactProtocol(run, 'legacy')).toBe('legacy')
  })
  it.each([EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION])(
    'keeps the legacy Artifact family when only %s was persisted', async (version) => {
      const f = await prepare(`legacy-policy-${version}`)
      const run = await requireRun(f)
      expect(persistedArtifactProtocol({ ...run, providerRoutes: [route(version)] })).toBe('legacy')
    })
  it('requires a supported Evidence main route rather than inferring family from an orphan Artifact', async () => {
    const f = await prepare('orphan-policy')
    const run = await requireRun(f)
    for (const version of [artifactPromptVersion('summary'), ARTIFACT_SOURCE_REFERENCE_VERSIONS.summary,
      REPAIR_PROMPT_VERSION, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION]) {
      expect(persistedArtifactProtocol({ ...run, providerRoutes: [route(version)] })).toBeUndefined()
    }
    expect(persistedArtifactProtocol({ ...run, providerRoutes: [route(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION),
      route(ARTIFACT_SOURCE_REFERENCE_VERSIONS.summary), route(ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION)] })).toBe('source-reference')
  })
})

describe('runtime recovery preserves the original execution protocol', () => {
  it.each([
    [EVIDENCE_MAP_PROMPT_VERSION, 'evidence_map_v1'],
    [EVIDENCE_QUOTE_PROMPT_VERSION, 'evidence_map_v2'],
    [EVIDENCE_SOURCE_REF_PROMPT_VERSION, 'evidence_map_v3'],
  ])('resumes five legacy Artifacts after a %s graph without adopting the current draft contract', async (version, outputName) => {
    const f = await prepare(`restart-${version}`)
    await persistRoutes(f, [route(version)])
    const firstProvider = new FakeAnalysisProvider()
    expect((await f.runtime(firstProvider).evidence.runOnce(FIXTURE_TENANT, f.runId, 'old-evidence-owner', signal())).outcome).toBe('completed')
    expect(firstProvider.calls).toHaveLength(1)
    expect(firstProvider.calls[0].output.name).toBe(outputName)
    const graphBefore = await f.store.getEvidenceGraph(FIXTURE_TENANT, f.runId)
    expect(graphBefore?.promptVersion).toBe(version)
    expect((await requireRun(f)).providerRoutes.map((entry) => entry.promptVersion)).toEqual([version])

    const resumedProvider = new FakeAnalysisProvider()
    const resumed = f.runtime(resumedProvider)
    expect((await resumed.evidence.runOnce(FIXTURE_TENANT, f.runId, 'restart-evidence', signal())).outcome).toBe('already_complete')
    const result = await resumed.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'restart-artifacts', signal())
    expect(result.run.status).toBe('succeeded')
    expect(resumedProvider.calls).toHaveLength(5)
    for (const kind of ARTIFACT_KINDS) {
      expect(resumedProvider.calls.find((call) => call.role === `artifact-${kind}`)?.output.name).toBe(`artifact_${kind}_v1`)
      expect(result.run.providerRoutes.some((entry) => entry.promptVersion === artifactPromptVersion(kind))).toBe(true)
      expect((await f.store.getArtifact(FIXTURE_TENANT, f.runId, kind))?.artifact.kind).toBe(kind)
    }
    expect(result.run.providerRoutes.some((entry) => Object.values(ARTIFACT_SOURCE_REFERENCE_VERSIONS)
      .some((newVersion) => newVersion === entry.promptVersion))).toBe(false)
    expect(await f.store.getEvidenceGraph(FIXTURE_TENANT, f.runId)).toEqual(graphBefore)
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 6, unresolvedCount: 0 })

    const complete = await snapshot(f)
    const replayProvider = new FakeAnalysisProvider()
    const replay = f.runtime(replayProvider)
    await replay.evidence.runOnce(FIXTURE_TENANT, f.runId, 'repeat-evidence', signal())
    expect((await replay.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'repeat-artifacts', signal())).outcome).toBe('already_complete')
    expect(replayProvider.calls).toHaveLength(0)
    expect(await snapshot(f)).toEqual(complete)
  })
  it('starts an untouched run with Evidence V4, persists new five-kind drafts and repeats recovery without new calls', async () => {
    const f = await prepare('new-v4-roundtrip')
    expect((await requireRun(f)).providerRoutes).toEqual([])
    const firstProvider = new FakeAnalysisProvider()
    const first = f.runtime(firstProvider)
    expect(first.evidenceGenerator.route.promptVersion).toBe(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)
    expect((await first.evidence.runOnce(FIXTURE_TENANT, f.runId, 'new-evidence', signal())).outcome).toBe('completed')
    expect(firstProvider.calls).toHaveLength(1)
    expect(firstProvider.calls[0].output.name).toBe('evidence_map_v3')
    expect((await f.store.getEvidenceGraph(FIXTURE_TENANT, f.runId))?.promptVersion).toBe(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)

    const resumedProvider = new FakeAnalysisProvider()
    const drafts: { kind: string; value: { draftVersion: string; payload: unknown } }[] = []
    resumedProvider.override = (request) => {
      const output = resumedProvider.output(request)
      drafts.push({ kind: request.role, value: JSON.parse(output) })
      return output
    }
    const result = await f.runtime(resumedProvider).artifacts.runOnce(FIXTURE_TENANT, f.runId, 'new-artifacts', signal())
    expect(result.run.status).toBe('succeeded')
    expect(resumedProvider.calls).toHaveLength(5)
    expect(drafts.every((draft) => draft.value.draftVersion === ARTIFACT_REFERENCE_DRAFT_VERSION)).toBe(true)
    for (const kind of ARTIFACT_KINDS) {
      expect(resumedProvider.calls.find((call) => call.role === `artifact-${kind}`)?.output.name).toBe(`artifact_${kind}_source_refs_v1`)
      expect(result.run.providerRoutes.some((entry) => entry.promptVersion === ARTIFACT_SOURCE_REFERENCE_VERSIONS[kind])).toBe(true)
      const stored = await f.store.getArtifact(FIXTURE_TENANT, f.runId, kind)
      expect(stored?.artifact.version).toBe(1)
      expect(JSON.stringify(stored?.artifact.payload)).not.toContain('"refId"')
      expect(JSON.stringify(stored?.artifact.payload)).toContain('"quote":"' + FIXTURE_TEXT + '"')
    }
    expect(await f.store.getRunLedgerUsage(FIXTURE_TENANT, f.runId)).toMatchObject({ invocationCount: 6, unresolvedCount: 0 })
    const complete = await snapshot(f)
    const replayProvider = new FakeAnalysisProvider()
    const replay = f.runtime(replayProvider)
    await replay.evidence.runOnce(FIXTURE_TENANT, f.runId, 'new-repeat-evidence', signal())
    await replay.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'new-repeat-artifacts', signal())
    expect(replayProvider.calls).toHaveLength(0)
    expect(await snapshot(f)).toEqual(complete)
  })
})

const unsupportedVersions = [
  { name: 'wrong Evidence repair for V4', versions: [EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, EVIDENCE_REPAIR_PROMPT_VERSION] },
  { name: 'wrong Evidence repair for V1', versions: [EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION] },
  { name: 'future Evidence', versions: ['evidence-source-ref-v99'] },
  { name: 'future Artifact', versions: [EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, 'summary-grounded-refs-v99'] },
  { name: 'mixed Evidence protocols', versions: [EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION] },
  { name: 'mixed legacy Evidence versions', versions: [EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION] },
  { name: 'legacy Artifact after V4', versions: [EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, artifactPromptVersion('summary')] },
  { name: 'new Artifact after V3', versions: [EVIDENCE_SOURCE_REF_PROMPT_VERSION, ARTIFACT_SOURCE_REFERENCE_VERSIONS.summary] },
  { name: 'old Artifact repair after V4', versions: [EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, REPAIR_PROMPT_VERSION] },
  { name: 'new Artifact repair after V3', versions: [EVIDENCE_SOURCE_REF_PROMPT_VERSION, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION] },
  { name: 'orphan Artifact repair', versions: [ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION] },
  { name: 'orphan legacy Artifact repair', versions: [REPAIR_PROMPT_VERSION] },
  { name: 'Artifact only without Evidence', versions: [ARTIFACT_SOURCE_REFERENCE_VERSIONS.outline] },
  { name: 'orphan Evidence repair', versions: [EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION] },
]

describe('invalid persisted execution stops before reading source or reserving work', () => {
  it.each(unsupportedVersions.flatMap((scenario) => [false, true].map((graphComplete) => ({ ...scenario, graphComplete }))))(
    '$name (graphComplete=$graphComplete)', async ({ versions, graphComplete, name }) => {
      const f = await prepare(`reject-${name}-${graphComplete}`)
      if (graphComplete) {
        const seeded = await f.runtime().evidence.runOnce(FIXTURE_TENANT, f.runId, 'seed-complete-graph', signal())
        expect(seeded.outcome).toBe('completed')
      }
      await persistRoutes(f, versions.map((version) => route(version)))
      const before = await snapshot(f)
      const provider = new FakeAnalysisProvider()
      const restarted = f.runtime(provider)
      const reserve = vi.spyOn(f.store, 'reserveProviderInvocation')
      const claim = vi.spyOn(f.store, 'acquireLease')
      const sourceRead = vi.spyOn(f.store, 'getSourceContent')
      const graphRead = vi.spyOn(f.store, 'getEvidenceGraph')
      expect(await restarted.evidence.runOnce(FIXTURE_TENANT, f.runId, 'unsupported-evidence', signal()))
        .toEqual({ outcome: 'stopped', reason: 'unsupported_execution_version', run: before.run })
      expect(await restarted.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'unsupported-artifacts', signal()))
        .toEqual({ outcome: 'stopped', reason: 'unsupported_execution_version', run: before.run })
      expect(provider.calls).toHaveLength(0)
      expect(reserve).not.toHaveBeenCalled()
      expect(claim).not.toHaveBeenCalled()
      expect(sourceRead).not.toHaveBeenCalled()
      expect(graphRead).not.toHaveBeenCalled()
      expect(await snapshot(f)).toEqual(before)
      expect(before.source?.text).toBe(FIXTURE_TEXT)
      expect(before.usage?.invocationCount).toBe(graphComplete ? 1 : 0)
    })
  it.each(['providerId', 'modelId', 'profileVersion'] as const)('rejects a changed persisted %s before any new reservation', async (field) => {
    const f = await prepare(`changed-route-${field}`)
    await persistRoutes(f, [route(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, { [field]: `changed-${field}` })])
    const before = await snapshot(f)
    const provider = new FakeAnalysisProvider()
    const restarted = f.runtime(provider)
    expect(await restarted.evidence.runOnce(FIXTURE_TENANT, f.runId, 'profile-evidence', signal()))
      .toEqual({ outcome: 'stopped', reason: 'provider_profile_mismatch', run: before.run })
    expect(await restarted.artifacts.runOnce(FIXTURE_TENANT, f.runId, 'profile-artifacts', signal()))
      .toEqual({ outcome: 'stopped', reason: 'provider_profile_mismatch', run: before.run })
    expect(provider.calls).toHaveLength(0)
    expect(await snapshot(f)).toEqual(before)
    expect(before.usage?.invocationCount).toBe(0)
  })
  it('never lets a different personal profile execute an otherwise valid persisted family', async () => {
    const f = await prepare('personal-other-profile', 'synthetic-v1')
    await persistRoutes(f, [route(EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)])
    const before = await snapshot(f)
    const provider = new FakeAnalysisProvider()
    const wrong = f.runtime(provider, 'different-personal-profile')
    for (const worker of [wrong.evidence, wrong.artifacts]) {
      expect(await worker.runOnce(FIXTURE_TENANT, f.runId, 'wrong-personal', signal()))
        .toEqual({ outcome: 'stopped', reason: 'provider_profile_mismatch', run: before.run })
    }
    expect(provider.calls).toHaveLength(0)
    expect(await snapshot(f)).toEqual(before)
  })
  it('does not bypass an unknown version even when a personal profile matches', async () => {
    const f = await prepare('personal-future-version', 'synthetic-v1')
    await persistRoutes(f, [route('evidence-source-ref-v99')])
    const before = await snapshot(f)
    const provider = new FakeAnalysisProvider()
    const matching = f.runtime(provider, provider.profileVersion)
    for (const worker of [matching.evidence, matching.artifacts]) {
      expect(await worker.runOnce(FIXTURE_TENANT, f.runId, 'matching-profile-future', signal()))
        .toEqual({ outcome: 'stopped', reason: 'unsupported_execution_version', run: before.run })
    }
    expect(provider.calls).toHaveLength(0)
    expect(await snapshot(f)).toEqual(before)
  })
})
