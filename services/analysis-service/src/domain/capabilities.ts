import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_LIMITS,
  ARTIFACT_KINDS,
  QUALITY_PROFILES,
  engineCapabilitiesSchema,
  type EngineCapabilitiesV1,
} from '@cat-thinking/analysis-contracts'
import type { AnalysisServiceConfig } from '../config.js'

export interface EngineAvailability {
  readonly jobStoreReady?: boolean
  readonly providerReady?: boolean
  readonly dispatcherReady?: boolean
  readonly usageReady?: boolean
  readonly recoveryReady?: boolean
  readonly liveSmokeReady?: boolean
  readonly personalAuthorized?: boolean
  readonly activeProfileId?: string
  readonly modelId?: string
  readonly maxSelectedCharacters?: number
}

export const createEngineCapabilities = (
  config: AnalysisServiceConfig,
  availability: EngineAvailability = {},
): EngineCapabilitiesV1 => {
  const jobStoreReady = availability.jobStoreReady ?? false
  const providerReady = availability.providerReady ?? false
  const dispatcherReady = availability.dispatcherReady ?? false
  const usageReady = availability.usageReady ?? false
  const recoveryReady = availability.recoveryReady ?? false
  const liveSmokeReady = availability.liveSmokeReady ?? false
  const personal = config.operatingMode === 'personal'
  const authorizationReady = personal ? availability.personalAuthorized === true : liveSmokeReady
  return engineCapabilitiesSchema.parse({
    service: 'cat-analysis-engine',
    serviceVersion: config.serviceVersion,
    operatingMode: config.operatingMode,
    activeProfileId: personal ? availability.activeProfileId : undefined,
    modelId: personal ? availability.modelId : undefined,
    maxSelectedCharacters: personal ? availability.maxSelectedCharacters : undefined,
    pricingKnown: !personal && config.provider.mode === 'openai-compatible'
      && (config.provider.inputMicrosPerMillionTokens > 0 || config.provider.outputMicrosPerMillionTokens > 0),
    acceptsRuns: jobStoreReady && providerReady && dispatcherReady && usageReady && recoveryReady && authorizationReady,
    degradedReasons: [
      ...(providerReady ? [] : ['provider.not-configured']),
      ...(jobStoreReady ? [] : ['job-store.not-configured']),
      ...(dispatcherReady ? [] : ['dispatcher.not-ready']),
      ...(usageReady ? [] : ['usage.not-ready']),
      ...(recoveryReady ? [] : ['recovery.not-ready']),
      ...(authorizationReady ? [] : [personal ? 'personal.not-enabled' : 'provider.smoke-not-verified']),
    ],
    contractVersions: [ANALYSIS_CONTRACT_VERSION],
    qualityProfiles: [...QUALITY_PROFILES],
    artifactKinds: [...ARTIFACT_KINDS],
    maxSourcesPerRun: ANALYSIS_LIMITS.maxSourcesPerRun,
    maxSourceCharacters: ANALYSIS_LIMITS.maxSourceCharacters,
    maxUploadPartBytes: ANALYSIS_LIMITS.maxUploadPartBytes,
    supportsSse: jobStoreReady,
    supportsCancellation: jobStoreReady,
    supportsExternalKnowledge: false,
    retentionSeconds: config.retentionSeconds,
  })
}
