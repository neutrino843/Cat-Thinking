import { describe, expect, it } from 'vitest'
import { loadAnalysisServiceConfig } from '../src/config.js'

describe('analysis service configuration', () => {
  it('loads safe local defaults and freezes the result', () => {
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test' })

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8_787)
    expect(config.auth.mode).toBe('disabled')
    expect(config.corsOrigins).toEqual([])
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.corsOrigins)).toBe(true)
  })

  it('requires authentication and an exact origin in production', () => {
    expect(() => loadAnalysisServiceConfig({ NODE_ENV: 'production' })).toThrow(/service-token authentication/)
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'production',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: 's'.repeat(48),
    })).toThrow(/exact CORS origin/)
  })

  it('rejects weak secrets and wildcard or path-based origins', () => {
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: 'short',
    })).toThrow(/32 UTF-8 bytes/)
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_CORS_ORIGINS: 'https://*.example.com,https://app.example.com/path',
    })).toThrow(/Invalid exact CORS origin/)
  })

  it('parses bounded numbers, booleans, proxy hops, and deduplicated origins', () => {
    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_CORS_ORIGINS: 'https://app.example.com, https://app.example.com',
      ANALYSIS_PORT: '9000',
      ANALYSIS_TRUST_PROXY_HOPS: '1',
      ANALYSIS_RATE_LIMIT_MAX: '25',
      ANALYSIS_ENABLE_REQUEST_LOGS: 'false',
    })

    expect(config.corsOrigins).toEqual(['https://app.example.com'])
    expect(config.port).toBe(9_000)
    expect(config.trustProxyHops).toBe(1)
    expect(config.rateLimitMax).toBe(25)
    expect(config.requestLogsEnabled).toBe(false)
  })

  it('accepts a fully safe production configuration and explicit true booleans', () => {
    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'production',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: 'production-token-that-is-at-least-thirty-two-bytes',
      ANALYSIS_CORS_ORIGINS: 'https://app.example.com',
      ANALYSIS_ENABLE_REQUEST_LOGS: 'true',
    })

    expect(config.environment).toBe('production')
    expect(config.auth.mode).toBe('service-token')
    expect(config.requestLogsEnabled).toBe(true)
  })

  it('rejects invalid boolean and bounded numeric values', () => {
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_ENABLE_REQUEST_LOGS: 'sometimes',
    })).toThrow()
    expect(() => loadAnalysisServiceConfig({ NODE_ENV: 'test', ANALYSIS_PORT: '0' })).toThrow()
  })
})
