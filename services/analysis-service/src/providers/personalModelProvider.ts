import { getProviderPreset, PROVIDER_CATALOG, type PersonalProviderModelsInput } from '@cat-thinking/analysis-contracts'
import type { ModelProvider } from './modelProvider.js'
import { normalizeProviderBaseUrl, ProviderConnectionError } from './providerConnection.js'
import { OpenAICompatibleProvider, type FetchImplementation } from './openAICompatibleProvider.js'

export const PERSONAL_PROVIDER_LIMITS = Object.freeze({
  maxInputCharacters: 100_000,
  maxOutputTokens: 4_096,
  maxRunTokens: 200_000,
  maxInvocations: 24,
})

export const createPersonalModelProvider = (
  settings: PersonalProviderModelsInput,
  profileVersion: string,
  fetchImplementation?: FetchImplementation,
): ModelProvider => {
  const baseUrl = normalizeProviderBaseUrl(settings.baseUrl, { networkMode: settings.networkMode })
  if (!settings.modelId) throw new ProviderConnectionError('model_required')
  if (settings.networkMode === 'public' && !settings.apiKey) throw new ProviderConnectionError('credentials_required')
  const preset = getProviderPreset(settings.providerId)
  const endpointPreset = preset?.id === 'custom' ? PROVIDER_CATALOG.find((entry) => (
    entry.baseUrl && new URL(entry.baseUrl).origin === new URL(baseUrl).origin
  )) : undefined
  const effectivePreset = endpointPreset ?? preset
  const chatThinkingMode = effectivePreset?.id === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.modelId)
    ? 'disabled' as const
    : effectivePreset?.id === 'moonshot' && settings.modelId === 'kimi-k2.6' ? 'disabled' as const
      : effectivePreset?.id === 'qwen' && ['qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max'].includes(settings.modelId)
        ? 'disable-qwen' as const : undefined
  return new OpenAICompatibleProvider({
    id: `personal-${settings.providerId}`,
    profileVersion,
    modelId: settings.modelId,
    baseUrl,
    allowedHosts: [new URL(baseUrl).host],
    apiKey: settings.apiKey ?? '',
    apiStyle: settings.protocol,
    structuredOutput: settings.structuredOutput,
    networkMode: settings.networkMode,
    tokenParameter: endpointPreset?.tokenParameter ?? preset?.tokenParameter ?? 'max_tokens',
    // Several modern reasoning families reject temperature=0. Vendor defaults
    // provide broader compatibility without a paid trial-and-fallback call.
    temperaturePolicy: 'omit',
    chatThinkingMode,
    requestTimeoutMs: 300_000,
    maxInputCharacters: PERSONAL_PROVIDER_LIMITS.maxInputCharacters,
    maxOutputTokens: PERSONAL_PROVIDER_LIMITS.maxOutputTokens,
    maxResponseBytes: 2_000_000,
    fetchImplementation,
  })
}
