import type { QualityProfile } from '@cat-thinking/analysis-contracts'

export const MODEL_TASK_ROLES = [
  'evidence-map',
  'evidence-merge',
  'artifact-summary',
  'artifact-outline',
  'artifact-mindmap',
  'artifact-quiz',
  'artifact-knowledge',
  'repair',
] as const

export type ModelTaskRole = (typeof MODEL_TASK_ROLES)[number]
export type ProviderApiStyle = 'responses' | 'chat-completions'

export interface StructuredOutputDefinition {
  readonly name: string
  readonly schema: Readonly<Record<string, unknown>>
}

export interface ModelRequest {
  readonly invocationId: string
  readonly role: ModelTaskRole
  readonly qualityProfile: QualityProfile
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly output: StructuredOutputDefinition
  readonly maxOutputTokens: number
  readonly temperature?: number
}

export interface ModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface ModelResponse {
  readonly outputText: string
  readonly usage: ModelUsage
  readonly providerRequestId?: string
}

export interface ModelProviderCapabilities {
  readonly apiStyle: ProviderApiStyle
  readonly structuredOutputs: true
  readonly reportsUsage: true
  readonly supportsAbort: true
  readonly maxInputCharacters: number
  readonly maxOutputTokens: number
}

export interface ModelProvider {
  readonly id: string
  readonly modelId: string
  readonly profileVersion: string
  readonly capabilities: ModelProviderCapabilities
  isReady(): boolean
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>
}
