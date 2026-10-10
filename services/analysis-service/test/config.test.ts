import { describe, expect, it } from 'vitest'
import { loadAnalysisServiceConfig } from '../src/config.js'

describe('analysis service configuration', () => {
  it('loads safe local defaults and freezes the result', () => {
    const config = loadAnalysisServiceConfig({ NODE_ENV: 'test' })

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8_787)
    expect(config.auth.mode).toBe('disabled')
    expect(config.provider.mode).toBe('disabled')
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

  it('requires a PostgreSQL URL, canonical content key, and production TLS', () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64')
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_JOB_STORE: 'postgres',
    })).toThrow(/database URL|content encryption key/)
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_JOB_STORE: 'postgres',
      ANALYSIS_DATABASE_URL: 'https://not-postgres.example/database',
      ANALYSIS_CONTENT_ENCRYPTION_KEY: encryptionKey,
    })).toThrow(/postgres/)
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'production',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: 'production-token-that-is-at-least-thirty-two-bytes',
      ANALYSIS_CORS_ORIGINS: 'https://app.example.com',
      ANALYSIS_JOB_STORE: 'postgres',
      ANALYSIS_DATABASE_URL: 'postgresql://user:secret@db.example.com/cat_analysis',
      ANALYSIS_CONTENT_ENCRYPTION_KEY: encryptionKey,
      ANALYSIS_DATABASE_SSL: 'disable',
    })).toThrow(/requires TLS/)

    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_JOB_STORE: 'postgres',
      ANALYSIS_DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/cat_analysis',
      ANALYSIS_CONTENT_ENCRYPTION_KEY: encryptionKey,
      ANALYSIS_DATABASE_SSL: 'disable',
      ANALYSIS_DB_POOL_MAX: '4',
      ANALYSIS_SSE_POLL_MS: '250',
    })
    expect(config.jobStore).toMatchObject({ mode: 'postgres', poolMax: 4 })
    expect(config.ssePollMs).toBe(250)
  })

  it('loads a frozen allowlisted OpenAI-compatible provider configuration', () => {
    const config = loadAnalysisServiceConfig({
      NODE_ENV: 'test',
      ANALYSIS_PROVIDER_MODE: 'openai-compatible',
      ANALYSIS_PROVIDER_ID: 'approved-provider',
      ANALYSIS_PROVIDER_BASE_URL: 'https://models.example.com/v1',
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.example.com,models.example.com',
      ANALYSIS_PROVIDER_API_KEY: 'provider-test-key-with-safe-length',
      ANALYSIS_PROVIDER_API_STYLE: 'chat-completions',
      ANALYSIS_PROVIDER_MODEL_ID: 'approved/model-v1',
      ANALYSIS_PROVIDER_PROFILE_VERSION: 'profile-v1',
      ANALYSIS_PROVIDER_TIMEOUT_MS: '45000',
      ANALYSIS_PROVIDER_MAX_INPUT_CHARACTERS: '50000',
      ANALYSIS_PROVIDER_MAX_OUTPUT_TOKENS: '4096',
      ANALYSIS_PROVIDER_MAX_RESPONSE_BYTES: '500000',
    })

    expect(config.provider).toMatchObject({
      mode: 'openai-compatible',
      id: 'approved-provider',
      allowedHosts: ['models.example.com'],
      apiStyle: 'chat-completions',
      modelId: 'approved/model-v1',
      timeoutMs: 45_000,
    })
    expect(Object.isFrozen(config.provider)).toBe(true)
    if (config.provider.mode === 'openai-compatible') {
      expect(Object.isFrozen(config.provider.allowedHosts)).toBe(true)
    }
  })

  it('fails closed for incomplete, unapproved, or insecure provider configuration', () => {
    const base = {
      NODE_ENV: 'test',
      ANALYSIS_PROVIDER_MODE: 'openai-compatible',
      ANALYSIS_PROVIDER_ID: 'approved-provider',
      ANALYSIS_PROVIDER_BASE_URL: 'https://models.example.com/v1',
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.example.com',
      ANALYSIS_PROVIDER_API_KEY: 'provider-test-key-with-safe-length',
      ANALYSIS_PROVIDER_MODEL_ID: 'approved-model',
      ANALYSIS_PROVIDER_PROFILE_VERSION: 'profile-v1',
    }

    expect(() => loadAnalysisServiceConfig({
      ...base,
      ANALYSIS_PROVIDER_API_KEY: undefined,
    })).toThrow(/API key/)
    expect(() => loadAnalysisServiceConfig({
      ...base,
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'other.example.com',
    })).toThrow(/allowlisted/)
    expect(() => loadAnalysisServiceConfig({
      ...base,
      ANALYSIS_PROVIDER_BASE_URL: 'https://user:secret@models.example.com/v1?leak=yes',
    })).toThrow(/without credentials or query data/)
    expect(() => loadAnalysisServiceConfig({
      ...base,
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.example.com/path',
    })).toThrow(/Invalid exact provider host/)
  })

  it('requires HTTPS for a production provider', () => {
    expect(() => loadAnalysisServiceConfig({
      NODE_ENV: 'production',
      ANALYSIS_AUTH_MODE: 'service-token',
      ANALYSIS_SERVICE_TOKEN: 'production-token-that-is-at-least-thirty-two-bytes',
      ANALYSIS_CORS_ORIGINS: 'https://app.example.com',
      ANALYSIS_PROVIDER_MODE: 'openai-compatible',
      ANALYSIS_PROVIDER_ID: 'approved-provider',
      ANALYSIS_PROVIDER_BASE_URL: 'http://models.example.com/v1',
      ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.example.com',
      ANALYSIS_PROVIDER_API_KEY: 'provider-test-key-with-safe-length',
      ANALYSIS_PROVIDER_MODEL_ID: 'approved-model',
      ANALYSIS_PROVIDER_PROFILE_VERSION: 'profile-v1',
    })).toThrow(/requires HTTPS/)
  })
})
