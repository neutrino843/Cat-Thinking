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
    acceptsRuns?: boolean
  }> = {},
): EngineCapabilitiesV1 => engineCapabilitiesSchema.parse({
  service: 'cat-analysis-engine',
  serviceVersion: config.serviceVersion,
  acceptsRuns: availability.acceptsRuns ?? false,
  degradedReasons: [
    ...(availability.providerReady ? [] : ['provider.not-configured']),
    ...(availability.jobStoreReady ? [] : ['job-store.not-configured']),
  ],
  contractVersions: [ANALYSIS_CONTRACT_VERSION],
  qualityProfiles: [...QUALITY_PROFILES],
  artifactKinds: [...ARTIFACT_KINDS],
  maxSourcesPerRun: ANALYSIS_LIMITS.maxSourcesPerRun,
  maxSourceCharacters: ANALYSIS_LIMITS.maxSourceCharacters,
  maxUploadPartBytes: ANALYSIS_LIMITS.maxUploadPartBytes,
  supportsSse: availability.jobStoreReady ?? false,
  supportsCancellation: availability.jobStoreReady ?? false,
  supportsExternalKnowledge: false,
  retentionSeconds: config.retentionSeconds,
})
