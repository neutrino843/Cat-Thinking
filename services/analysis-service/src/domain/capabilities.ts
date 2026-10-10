import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_LIMITS,
  ARTIFACT_KINDS,
  QUALITY_PROFILES,
  engineCapabilitiesSchema,
  type EngineCapabilitiesV1,
} from '@cat-thinking/analysis-contracts'
import type { AnalysisServiceConfig } from '../config.js'

export const createEngineCapabilities = (
  config: AnalysisServiceConfig,
  availability: Readonly<{
    jobStoreReady?: boolean
    providerReady?: boolean
    dispatcherReady?: boolean
  }> = {},
): EngineCapabilitiesV1 => {
  const jobStoreReady = availability.jobStoreReady ?? false
  const providerReady = availability.providerReady ?? false
  const dispatcherReady = availability.dispatcherReady ?? false
  return engineCapabilitiesSchema.parse({
    service: 'cat-analysis-engine',
    serviceVersion: config.serviceVersion,
    acceptsRuns: jobStoreReady && providerReady && dispatcherReady,
    degradedReasons: [
      ...(providerReady ? [] : ['provider.not-configured']),
      ...(jobStoreReady ? [] : ['job-store.not-configured']),
      ...(dispatcherReady ? [] : ['dispatcher.not-ready']),
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
