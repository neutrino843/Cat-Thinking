import { ARTIFACT_KINDS, QUALITY_PROFILES, type AnalysisRunV1 } from '@cat-thinking/analysis-contracts'
import type { JobStore } from '../domain/jobStore.js'
import { ArtifactDagWorker } from '../domain/artifactDagWorker.js'
import { EvidencePipelineWorker } from '../domain/evidencePipelineWorker.js'
import type { RunEventBroker } from '../domain/eventBroker.js'
import { REPAIR_PROMPT_VERSION, artifactPrompt, artifactPromptVersion, repairPrompt,
  artifactSourceReferencePrompt, artifactSourceReferenceRepairPrompt } from './artifactPrompts.js'
import { ARTIFACT_SOURCE_REFERENCE_VERSIONS, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION } from './artifactReferenceDraft.js'
import { persistedArtifactProtocol, type ArtifactProtocol } from './artifactProtocolPolicy.js'
import {
  EVIDENCE_MAP_PROMPT_ID, EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION,
  evidenceMapPrompt, evidenceQuoteMapPrompt, evidenceSourceRefMapPrompt,
  EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, evidenceArtifactRefMapPrompt,
} from './evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_ID, EVIDENCE_REPAIR_PROMPT_VERSION, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION,
  evidenceRepairPrompt, evidenceSourceRefRepairPrompt } from './evidenceRepairPrompt.js'
import type { ModelProvider } from './modelProvider.js'
import { ProviderArtifactGenerator, type ArtifactAdapterRoute } from './providerArtifactGenerator.js'
import { ProviderEvidenceGenerator } from './providerEvidenceGenerator.js'
import { ProviderInvocationCoordinator, type ProviderInvocationCoordinatorOptions } from './providerInvocationCoordinator.js'
import { ProviderRouter, type ModelRouteProfile } from './providerRouter.js'
import { PromptRegistry } from './promptRegistry.js'

export const createAnalysisProviderRuntime = (options: {
  readonly store: JobStore; readonly provider: ModelProvider; readonly broker: RunEventBroker
  readonly leaseMs: number; readonly now?: () => number
  readonly estimateCostMicros: ProviderInvocationCoordinatorOptions['estimateCostMicros']
  readonly policy?: ProviderInvocationCoordinatorOptions['policy']
  readonly canInvoke?: ProviderInvocationCoordinatorOptions['canInvoke']
  readonly expectedPersonalProfileId?: string
  /** Explicit internal fixture choice. Production defaults to the reference family. */
  readonly artifactProtocol?: ArtifactProtocol
}) => {
  const { provider } = options
  const canProcessRun = (run: AnalysisRunV1): boolean => {
    const boundProfileId = run.request.providerProfileId
    if (options.expectedPersonalProfileId === undefined) {
      if (boundProfileId !== undefined) return false
    } else if (boundProfileId !== options.expectedPersonalProfileId || provider.profileVersion !== options.expectedPersonalProfileId) return false
    // A persisted route records prior work. A changed static deployment must not
    // combine that work with a different provider, model or immutable profile.
    return run.providerRoutes.every((existing) => existing.providerId === provider.id
      && existing.modelId === provider.modelId && existing.profileVersion === provider.profileVersion)
  }
  const route = (promptVersion: string) => ({ providerId: provider.id, modelId: provider.modelId, profileVersion: provider.profileVersion, promptVersion })
  const prompts = new PromptRegistry()
  for (const kind of ARTIFACT_KINDS) {
    prompts.register(artifactPrompt(kind))
    prompts.register(artifactSourceReferencePrompt(kind))
  }
  prompts.register(evidenceMapPrompt)
  prompts.register(evidenceQuoteMapPrompt)
  prompts.register(evidenceSourceRefMapPrompt)
  prompts.register(evidenceArtifactRefMapPrompt)
  prompts.register(evidenceRepairPrompt)
  prompts.register(evidenceSourceRefRepairPrompt)
  prompts.register(repairPrompt)
  prompts.register(artifactSourceReferenceRepairPrompt)
  const makeArtifacts = (protocol: ArtifactProtocol) => {
    const reference = protocol === 'source-reference'
    const repair = reference ? artifactSourceReferenceRepairPrompt : repairPrompt
    const definitions = [...ARTIFACT_KINDS.map(reference ? artifactSourceReferencePrompt : artifactPrompt), repair]
    const profiles: ModelRouteProfile[] = definitions.map((definition) => ({
      id: definition.id, ...route(definition.version), promptId: definition.id,
      roles: [definition.role], qualityProfiles: QUALITY_PROFILES, priority: 0,
    }))
    const coordinator = new ProviderInvocationCoordinator({
      router: new ProviderRouter([provider], profiles), ledger: options.store,
      estimateCostMicros: options.estimateCostMicros, now: options.now, policy: options.policy, canInvoke: options.canInvoke,
    })
    const routes = Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, {
      promptId: `artifact.${kind}`, route: route(reference ? ARTIFACT_SOURCE_REFERENCE_VERSIONS[kind] : artifactPromptVersion(kind)),
    }])) as Record<(typeof ARTIFACT_KINDS)[number], ArtifactAdapterRoute>
    const generator = new ProviderArtifactGenerator({ coordinator, prompts, routes,
      repair: { promptId: repair.id, route: route(reference ? ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION : REPAIR_PROMPT_VERSION) },
      now: options.now, maxOutputTokens: provider.capabilities.maxOutputTokens })
    const worker = new ArtifactDagWorker({ ...options, generator,
      concurrency: options.expectedPersonalProfileId === undefined ? undefined : 2,
      canProcessRun: (run) => canProcessRun(run) && persistedArtifactProtocol(run, options.artifactProtocol) === protocol })
    return { coordinator, generator, worker }
  }
  const referenceArtifacts = makeArtifacts('source-reference')
  const legacyArtifacts = makeArtifacts('legacy')
  const selectedArtifacts = options.artifactProtocol === 'legacy' ? legacyArtifacts : referenceArtifacts
  const makeEvidenceGenerator = (promptVersion: string) => {
    const repairVersion = [EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION].includes(promptVersion)
      ? EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION : EVIDENCE_REPAIR_PROMPT_VERSION
    // Router selects by role. Separate profiles preserve the exact persisted
    // Evidence version and its independent repair prompt instead of falling
    // through to an Artifact repair or another Evidence version.
    const evidenceCoordinator = new ProviderInvocationCoordinator({
      router: new ProviderRouter([provider], [
        { id: `${EVIDENCE_MAP_PROMPT_ID}.${promptVersion}`, ...route(promptVersion), promptId: EVIDENCE_MAP_PROMPT_ID,
          roles: ['evidence-map'], qualityProfiles: QUALITY_PROFILES, priority: 0 },
        { id: EVIDENCE_REPAIR_PROMPT_ID, ...route(repairVersion), promptId: EVIDENCE_REPAIR_PROMPT_ID,
          roles: ['repair'], qualityProfiles: QUALITY_PROFILES, priority: 0 },
      ]),
      ledger: options.store, estimateCostMicros: options.estimateCostMicros, now: options.now,
      policy: options.policy, canInvoke: options.canInvoke,
    })
    return new ProviderEvidenceGenerator({ coordinator: evidenceCoordinator, prompts, promptId: EVIDENCE_MAP_PROMPT_ID,
      route: route(promptVersion), maxOutputTokens: Math.min(4_096, provider.capabilities.maxOutputTokens),
      repair: { promptId: EVIDENCE_REPAIR_PROMPT_ID, route: route(repairVersion) } })
  }
  const sourceRefEvidenceGenerator = makeEvidenceGenerator(EVIDENCE_SOURCE_REF_PROMPT_VERSION)
  const evidenceGenerator = makeEvidenceGenerator(options.artifactProtocol === 'legacy' ? EVIDENCE_SOURCE_REF_PROMPT_VERSION : EVIDENCE_ARTIFACT_REF_PROMPT_VERSION)
  const quoteEvidenceGenerator = makeEvidenceGenerator(EVIDENCE_QUOTE_PROMPT_VERSION)
  const legacyEvidenceGenerator = makeEvidenceGenerator(EVIDENCE_MAP_PROMPT_VERSION)
  const persistedEvidenceVersion = (run: AnalysisRunV1): string | undefined => {
    const versions = new Set(run.providerRoutes.filter((existing) => existing.promptVersion.startsWith('evidence-map-')
      || existing.promptVersion.startsWith('evidence-source-ref-'))
      .map((existing) => existing.promptVersion))
    const repairVersions = new Set(run.providerRoutes.filter((existing) => existing.promptVersion.startsWith('evidence-repair-'))
      .map((existing) => existing.promptVersion))
    if (versions.size === 0) return run.providerRoutes.length === 0 ? evidenceGenerator.route.promptVersion : undefined
    if (versions.size !== 1) return undefined
    const version = [...versions][0]
    if (version === undefined) return undefined
    const expectedRepair = [EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION].includes(version)
      ? EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION : EVIDENCE_REPAIR_PROMPT_VERSION
    if (repairVersions.size > 1 || [...repairVersions].some((repairVersion) => repairVersion !== expectedRepair)) return undefined
    return [EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION].includes(version) ? version : undefined
  }
  const evidenceWorkers = new Map([evidenceGenerator, sourceRefEvidenceGenerator, quoteEvidenceGenerator, legacyEvidenceGenerator].map((generator) => [
    generator.route.promptVersion,
    new EvidencePipelineWorker({ ...options, generator,
      maxConcurrency: options.expectedPersonalProfileId === undefined ? undefined : 2,
      canProcessRun: (run) => canProcessRun(run) && persistedArtifactProtocol(run, options.artifactProtocol) !== undefined
        && persistedEvidenceVersion(run) === generator.route.promptVersion }),
  ]))
  const evidence = {
    async runOnce(tenantId: string, runId: string, ownerId: string, signal: AbortSignal) {
      const run = await options.store.getRun(tenantId, runId)
      if (!run) throw new Error('analysis run not found')
      const version = persistedEvidenceVersion(run)
      const worker = version === undefined ? undefined : evidenceWorkers.get(version)
      if (!worker || persistedArtifactProtocol(run, options.artifactProtocol) === undefined) return { outcome: 'stopped' as const, reason: 'unsupported_execution_version' as const, run }
      if (!canProcessRun(run)) return { outcome: 'stopped' as const, reason: 'provider_profile_mismatch' as const, run }
      return worker.runOnce(tenantId, runId, ownerId, signal)
    },
  }
  return {
    coordinator: selectedArtifacts.coordinator, artifactGenerator: selectedArtifacts.generator,
    legacyArtifactGenerator: legacyArtifacts.generator, referenceArtifactGenerator: referenceArtifacts.generator,
    evidenceGenerator, sourceRefEvidenceGenerator, quoteEvidenceGenerator, legacyEvidenceGenerator,
    evidence,
    artifacts: {
      async runOnce(tenantId: string, runId: string, ownerId: string, signal: AbortSignal) {
        const run = await options.store.getRun(tenantId, runId)
        if (!run) throw new Error('analysis run not found')
        const protocol = persistedArtifactProtocol(run, options.artifactProtocol)
        if (protocol === undefined || persistedEvidenceVersion(run) === undefined) return { outcome: 'stopped' as const, reason: 'unsupported_execution_version' as const, run }
        if (!canProcessRun(run)) return { outcome: 'stopped' as const, reason: 'provider_profile_mismatch' as const, run }
        return (protocol === 'legacy' ? legacyArtifacts : referenceArtifacts).worker.runOnce(tenantId, runId, ownerId, signal)
      },
    },
  }
}
