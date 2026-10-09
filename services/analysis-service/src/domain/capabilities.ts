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
): EngineCapabilitiesV1 => engineCapabilitiesSchema.parse({
  service: 'cat-analysis-engine',
  serviceVersion: config.serviceVersion,
  acceptsRuns: false,
  degradedReasons: ['provider.not-configured', 'job-store.not-configured'],
  contractVersions: [ANALYSIS_CONTRACT_VERSION],
  qualityProfiles: [...QUALITY_PROFILES],
  artifactKinds: [...ARTIFACT_KINDS],
  maxSourcesPerRun: ANALYSIS_LIMITS.maxSourcesPerRun,
  maxSourceCharacters: ANALYSIS_LIMITS.maxSourceCharacters,
  maxUploadPartBytes: ANALYSIS_LIMITS.maxUploadPartBytes,
  supportsSse: false,
  supportsCancellation: false,
  supportsExternalKnowledge: false,
  retentionSeconds: config.retentionSeconds,
})
