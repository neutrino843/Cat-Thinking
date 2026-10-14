import { describe, expect, it } from 'vitest'
import { inferProviderProtocolFromUrl, personalProviderModelsInputSchema, personalProviderSettingsInputSchema } from '../src/providerSettings.js'

describe('personal provider settings contract', () => {
  it('infers protocol only from an explicit endpoint before sending any request', () => {
    expect(inferProviderProtocolFromUrl('https://api.example.com/v1/responses/')).toBe('responses')
    expect(inferProviderProtocolFromUrl('https://api.example.com/v1/chat/completions')).toBe('chat-completions')
    expect(inferProviderProtocolFromUrl('https://api.example.com/v1')).toBeUndefined()
    expect(inferProviderProtocolFromUrl('https://api.example.com/v1/notresponses')).toBeUndefined()
    expect(inferProviderProtocolFromUrl('file:///responses')).toBeUndefined()
    expect(inferProviderProtocolFromUrl('invalid')).toBeUndefined()
  })

  it('allows discovering models before selecting one, while saving still requires a model', () => {
    const input = { version: 1, providerId: 'custom', baseUrl: 'https://api.example.com/v1', apiKey: 'synthetic',
      protocol: 'chat-completions', structuredOutput: 'json_object', networkMode: 'public' }
    expect(personalProviderModelsInputSchema.safeParse(input).success).toBe(true)
    expect(personalProviderSettingsInputSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false)
    expect(personalProviderSettingsInputSchema.safeParse({ ...input, expectedRevision: 0, modelId: 'custom/model:latest' }).success).toBe(true)
  })
})
