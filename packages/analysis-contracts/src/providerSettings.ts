import { z } from 'zod'

export const providerProtocolSchema = z.enum(['responses', 'chat-completions'])
export const providerStructuredOutputSchema = z.enum(['json_schema', 'json_object'])
export const providerNetworkModeSchema = z.enum(['public', 'local-loopback'])
export const providerModelIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u)
export const providerIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u)

const settingsFields = {
  version: z.literal(1),
  providerId: providerIdSchema,
  baseUrl: z.string().trim().url().max(2_048),
  modelId: providerModelIdSchema,
  apiKey: z.string().trim().min(1).max(4_096).regex(/^[\x21-\x7e]+$/u).optional(),
  protocol: providerProtocolSchema,
  structuredOutput: providerStructuredOutputSchema,
  networkMode: providerNetworkModeSchema,
}

export const personalProviderSettingsInputSchema = z.object({
  ...settingsFields,
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict()

export const personalProviderModelsInputSchema = z.object({ ...settingsFields, modelId: providerModelIdSchema.optional() }).strict()
export const personalProviderActionSchema = z.object({
  version: z.literal(1),
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict()

export const personalProviderLimitsSchema = z.object({
  maxInputCharacters: z.number().int().positive().safe(),
  maxOutputTokens: z.number().int().positive().safe(),
  maxRunTokens: z.number().int().positive().safe(),
  maxInvocations: z.number().int().positive().safe(),
}).strict()

// This public response has no secret-shaped field, including masked credentials.
export const personalProviderStatusSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  available: z.boolean(),
  enabled: z.boolean(),
  configured: z.boolean(),
  hasApiKey: z.boolean(),
  providerId: providerIdSchema.optional(),
  baseUrl: z.string().url().max(2_048).optional(),
  modelId: providerModelIdSchema.optional(),
  protocol: providerProtocolSchema.optional(),
  structuredOutput: providerStructuredOutputSchema.optional(),
  networkMode: providerNetworkModeSchema.optional(),
  checkState: z.enum(['unchecked', 'checking', 'ready', 'failed']),
  messageKey: z.string().max(100).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
  acceptsRuns: z.boolean(),
  pricingKnown: z.literal(false),
  limits: personalProviderLimitsSchema,
}).strict()

export const personalProviderModelSchema = z.object({
  id: providerModelIdSchema,
  label: z.string().trim().min(1).max(200).optional(),
}).strict()

export const personalProviderModelsResultSchema = z.object({
  version: z.literal(1),
  models: z.array(personalProviderModelSchema).max(500),
  source: z.enum(['provider', 'catalog']),
}).strict()

export type ProviderProtocol = z.infer<typeof providerProtocolSchema>
export type ProviderStructuredOutput = z.infer<typeof providerStructuredOutputSchema>
export type ProviderNetworkMode = z.infer<typeof providerNetworkModeSchema>
export type PersonalProviderSettingsInput = z.infer<typeof personalProviderSettingsInputSchema>
export type PersonalProviderModelsInput = z.infer<typeof personalProviderModelsInputSchema>
export type PersonalProviderAction = z.infer<typeof personalProviderActionSchema>
export type PersonalProviderStatus = z.infer<typeof personalProviderStatusSchema>
export type PersonalProviderModel = z.infer<typeof personalProviderModelSchema>
export type PersonalProviderModelsResult = z.infer<typeof personalProviderModelsResultSchema>

/** An explicit endpoint path expresses a protocol choice before any request. */
export const inferProviderProtocolFromUrl = (value: string): ProviderProtocol | undefined => {
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if (!['https:', 'http:'].includes(url.protocol)) return undefined
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (pathname.endsWith('/responses')) return 'responses'
  if (pathname.endsWith('/chat/completions')) return 'chat-completions'
  return undefined
}
