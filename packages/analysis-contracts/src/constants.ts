export const ANALYSIS_CONTRACT_VERSION = 1 as const

export const ARTIFACT_KINDS = [
  'summary',
  'outline',
  'mindmap',
  'quiz',
  'knowledge',
] as const

export const QUALITY_PROFILES = ['economy', 'standard', 'high-quality'] as const

export const RUN_STATUSES = [
  'accepted',
  'receiving',
  'queued',
  'planning',
  'mapping',
  'merging',
  'generating',
  'validating',
  'partial',
  'succeeded',
  'cancelled',
  'failed',
  'expired',
] as const

export const RUN_STAGES = [
  'receiving',
  'planning',
  'mapping',
  'merging',
  'summary',
  'outline',
  'mindmap',
  'quiz',
  'knowledge',
  'validating',
  'persisting',
] as const

export const ARTIFACT_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const

export const CANCEL_EFFECTS = [
  'upstream_aborted',
  'scheduling_stopped',
  'result_ignored',
] as const

export const ANALYSIS_LIMITS = {
  maxSourcesPerRun: 20,
  maxSourceCharacters: 2_000_000,
  maxSourceLocators: 20_000,
  maxUploadPartBytes: 512_000,
  maxEvidenceChunks: 2_000,
  maxEvidenceCards: 2_000,
  maxEvidenceClaims: 20_000,
  maxEvidenceTerms: 20_000,
  maxLearningObjectives: 10_000,
  maxArtifactBytes: 2_000_000,
  maxCitationCount: 500,
  maxOutlineNodes: 500,
  maxMindMapNodes: 1_000,
  maxQuizQuestions: 100,
  maxKnowledgeItems: 200,
  maxTextField: 20_000,
  maxIdentifierLength: 128,
} as const
