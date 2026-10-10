import type { AnalysisServiceConfig } from '../config.js'
import type { ModelProvider } from './modelProvider.js'
import {
  OpenAICompatibleProvider,
  type FetchImplementation,
} from './openAICompatibleProvider.js'

export const createConfiguredModelProvider = (
  config: AnalysisServiceConfig['provider'],
  fetchImplementation?: FetchImplementation,
): ModelProvider | undefined => config.mode === 'disabled'
  ? undefined
  : new OpenAICompatibleProvider({
      id: config.id,
      modelId: config.modelId,
      profileVersion: config.profileVersion,
      apiStyle: config.apiStyle,
      baseUrl: config.baseUrl,
      allowedHosts: config.allowedHosts,
      apiKey: config.apiKey,
      requestTimeoutMs: config.timeoutMs,
      maxInputCharacters: config.maxInputCharacters,
      maxOutputTokens: config.maxOutputTokens,
      maxResponseBytes: config.maxResponseBytes,
      fetchImplementation,
    })
