import { z } from 'zod'

const SERVICE_VERSION = '0.1.0' as const
const DEFAULT_BODY_LIMIT = 2_100_000

const integerFromEnvironment = (fallback: number, minimum: number, maximum: number) => z.preprocess(
  (value) => value === undefined || value === '' ? fallback : value,
  z.coerce.number().int().min(minimum).max(maximum),
)

const booleanFromEnvironment = (fallback: boolean) => z.preprocess((value) => {
  if (value === undefined || value === '') return fallback
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return value
}, z.boolean())

const originListSchema = z.string().default('').transform((value, context) => {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean)
  const unique = new Set<string>()
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || origin.includes('*')) {
        throw new Error('not an exact HTTP origin')
      }
      unique.add(origin)
    } catch {
      context.addIssue({ code: 'custom', message: `Invalid exact CORS origin: ${origin}` })
    }
  }
  return [...unique]
})

const secretSchema = z.string().max(4_096).refine(
  (secret) => new TextEncoder().encode(secret).byteLength >= 32,
  'service token must contain at least 32 UTF-8 bytes',
)

const databaseUrlSchema = z.string().max(4_096).superRefine((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      context.addIssue({ code: 'custom', message: 'database URL must use postgres or postgresql' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'database URL is invalid' })
  }
})

const encryptionKeySchema = z.string().max(100).regex(
  /^[A-Za-z0-9+/]{43}=$/u,
  'content encryption key must be canonical base64 for exactly 32 bytes',
)

const selectedEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ANALYSIS_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
    ANALYSIS_PORT: integerFromEnvironment(8_787, 1, 65_535),
    ANALYSIS_LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    ANALYSIS_CORS_ORIGINS: originListSchema,
    ANALYSIS_AUTH_MODE: z.enum(['disabled', 'service-token']).default('disabled'),
    ANALYSIS_SERVICE_TOKEN: z.string().optional(),
    ANALYSIS_TRUST_PROXY_HOPS: integerFromEnvironment(0, 0, 10),
    ANALYSIS_RATE_LIMIT_MAX: integerFromEnvironment(60, 1, 100_000),
    ANALYSIS_RATE_LIMIT_WINDOW_MS: integerFromEnvironment(60_000, 1_000, 3_600_000),
    ANALYSIS_BODY_LIMIT_BYTES: integerFromEnvironment(DEFAULT_BODY_LIMIT, 1_024, 4_500_000),
    ANALYSIS_REQUEST_TIMEOUT_MS: integerFromEnvironment(30_000, 1_000, 300_000),
    ANALYSIS_CONNECTION_TIMEOUT_MS: integerFromEnvironment(10_000, 1_000, 120_000),
    ANALYSIS_KEEP_ALIVE_TIMEOUT_MS: integerFromEnvironment(5_000, 1_000, 120_000),
    ANALYSIS_SHUTDOWN_TIMEOUT_MS: integerFromEnvironment(10_000, 1_000, 120_000),
    ANALYSIS_RETENTION_SECONDS: integerFromEnvironment(3_600, 0, 604_800),
    ANALYSIS_ENABLE_REQUEST_LOGS: booleanFromEnvironment(true),
    ANALYSIS_JOB_STORE: z.enum(['disabled', 'postgres']).default('disabled'),
    ANALYSIS_DATABASE_URL: z.string().optional(),
    ANALYSIS_DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),
    ANALYSIS_CONTENT_ENCRYPTION_KEY: z.string().optional(),
    ANALYSIS_DB_POOL_MAX: integerFromEnvironment(10, 1, 100),
    ANALYSIS_DB_CONNECT_TIMEOUT_MS: integerFromEnvironment(10_000, 1_000, 120_000),
    ANALYSIS_SSE_HEARTBEAT_MS: integerFromEnvironment(15_000, 1_000, 120_000),
    ANALYSIS_SSE_POLL_MS: integerFromEnvironment(1_000, 100, 10_000),
    ANALYSIS_LEASE_MS: integerFromEnvironment(30_000, 1_000, 600_000),
    ANALYSIS_CLEANUP_BATCH_SIZE: integerFromEnvironment(100, 1, 1_000),
    ANALYSIS_CLEANUP_INTERVAL_MS: integerFromEnvironment(60_000, 1_000, 3_600_000),
  })
  .strict()
  .superRefine((environment, context) => {
    if (environment.ANALYSIS_AUTH_MODE === 'service-token') {
      const parsed = secretSchema.safeParse(environment.ANALYSIS_SERVICE_TOKEN)
      if (!parsed.success) {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_SERVICE_TOKEN'],
          message: parsed.error.issues[0]?.message ?? 'invalid service token',
        })
      }
    }
    if (environment.NODE_ENV === 'production') {
      if (environment.ANALYSIS_AUTH_MODE !== 'service-token') {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_AUTH_MODE'],
          message: 'production requires service-token authentication',
        })
      }
      if (environment.ANALYSIS_CORS_ORIGINS.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_CORS_ORIGINS'],
          message: 'production requires at least one exact CORS origin',
        })
      }
    }
    if (environment.ANALYSIS_JOB_STORE === 'postgres') {
      const database = databaseUrlSchema.safeParse(environment.ANALYSIS_DATABASE_URL)
      if (!database.success) {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_DATABASE_URL'],
          message: environment.ANALYSIS_DATABASE_URL === undefined
            ? 'PostgreSQL job store requires a database URL'
            : database.error.issues[0]?.message ?? 'invalid database URL',
        })
      }
      const encryptionKey = encryptionKeySchema.safeParse(environment.ANALYSIS_CONTENT_ENCRYPTION_KEY)
      if (!encryptionKey.success) {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_CONTENT_ENCRYPTION_KEY'],
          message: environment.ANALYSIS_CONTENT_ENCRYPTION_KEY === undefined
            ? 'PostgreSQL job store requires a content encryption key'
            : encryptionKey.error.issues[0]?.message ?? 'invalid content encryption key',
        })
      }
      if (environment.NODE_ENV === 'production' && environment.ANALYSIS_DATABASE_SSL !== 'require') {
        context.addIssue({
          code: 'custom',
          path: ['ANALYSIS_DATABASE_SSL'],
          message: 'production PostgreSQL requires TLS',
        })
      }
    }
  })

export interface AnalysisServiceConfig {
  readonly serviceVersion: string
  readonly environment: 'development' | 'test' | 'production'
  readonly host: string
  readonly port: number
  readonly logLevel: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  readonly corsOrigins: readonly string[]
  readonly auth:
    | Readonly<{ mode: 'disabled' }>
    | Readonly<{ mode: 'service-token'; token: string }>
  readonly trustProxyHops: number
  readonly rateLimitMax: number
  readonly rateLimitWindowMs: number
  readonly bodyLimitBytes: number
  readonly requestTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly keepAliveTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly retentionSeconds: number
  readonly requestLogsEnabled: boolean
  readonly jobStore:
    | Readonly<{ mode: 'disabled' }>
    | Readonly<{
        mode: 'postgres'
        connectionString: string
        ssl: 'disable' | 'require'
        poolMax: number
        connectTimeoutMs: number
        encryptionKey: string
      }>
  readonly sseHeartbeatMs: number
  readonly ssePollMs: number
  readonly leaseMs: number
  readonly cleanupBatchSize: number
  readonly cleanupIntervalMs: number
}

const selectEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string | undefined> => ({
  NODE_ENV: environment.NODE_ENV,
  ANALYSIS_HOST: environment.ANALYSIS_HOST,
  ANALYSIS_PORT: environment.ANALYSIS_PORT,
  ANALYSIS_LOG_LEVEL: environment.ANALYSIS_LOG_LEVEL,
  ANALYSIS_CORS_ORIGINS: environment.ANALYSIS_CORS_ORIGINS,
  ANALYSIS_AUTH_MODE: environment.ANALYSIS_AUTH_MODE,
  ANALYSIS_SERVICE_TOKEN: environment.ANALYSIS_SERVICE_TOKEN,
  ANALYSIS_TRUST_PROXY_HOPS: environment.ANALYSIS_TRUST_PROXY_HOPS,
  ANALYSIS_RATE_LIMIT_MAX: environment.ANALYSIS_RATE_LIMIT_MAX,
  ANALYSIS_RATE_LIMIT_WINDOW_MS: environment.ANALYSIS_RATE_LIMIT_WINDOW_MS,
  ANALYSIS_BODY_LIMIT_BYTES: environment.ANALYSIS_BODY_LIMIT_BYTES,
  ANALYSIS_REQUEST_TIMEOUT_MS: environment.ANALYSIS_REQUEST_TIMEOUT_MS,
  ANALYSIS_CONNECTION_TIMEOUT_MS: environment.ANALYSIS_CONNECTION_TIMEOUT_MS,
  ANALYSIS_KEEP_ALIVE_TIMEOUT_MS: environment.ANALYSIS_KEEP_ALIVE_TIMEOUT_MS,
  ANALYSIS_SHUTDOWN_TIMEOUT_MS: environment.ANALYSIS_SHUTDOWN_TIMEOUT_MS,
  ANALYSIS_RETENTION_SECONDS: environment.ANALYSIS_RETENTION_SECONDS,
  ANALYSIS_ENABLE_REQUEST_LOGS: environment.ANALYSIS_ENABLE_REQUEST_LOGS,
  ANALYSIS_JOB_STORE: environment.ANALYSIS_JOB_STORE,
  ANALYSIS_DATABASE_URL: environment.ANALYSIS_DATABASE_URL,
  ANALYSIS_DATABASE_SSL: environment.ANALYSIS_DATABASE_SSL,
  ANALYSIS_CONTENT_ENCRYPTION_KEY: environment.ANALYSIS_CONTENT_ENCRYPTION_KEY,
  ANALYSIS_DB_POOL_MAX: environment.ANALYSIS_DB_POOL_MAX,
  ANALYSIS_DB_CONNECT_TIMEOUT_MS: environment.ANALYSIS_DB_CONNECT_TIMEOUT_MS,
  ANALYSIS_SSE_HEARTBEAT_MS: environment.ANALYSIS_SSE_HEARTBEAT_MS,
  ANALYSIS_SSE_POLL_MS: environment.ANALYSIS_SSE_POLL_MS,
  ANALYSIS_LEASE_MS: environment.ANALYSIS_LEASE_MS,
  ANALYSIS_CLEANUP_BATCH_SIZE: environment.ANALYSIS_CLEANUP_BATCH_SIZE,
  ANALYSIS_CLEANUP_INTERVAL_MS: environment.ANALYSIS_CLEANUP_INTERVAL_MS,
})

export const loadAnalysisServiceConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AnalysisServiceConfig => {
  const parsed = selectedEnvironmentSchema.parse(selectEnvironment(environment))
  const auth: AnalysisServiceConfig['auth'] = parsed.ANALYSIS_AUTH_MODE === 'service-token'
    ? Object.freeze({ mode: 'service-token' as const, token: secretSchema.parse(parsed.ANALYSIS_SERVICE_TOKEN) })
    : Object.freeze({ mode: 'disabled' as const })
  const jobStore: AnalysisServiceConfig['jobStore'] = parsed.ANALYSIS_JOB_STORE === 'postgres'
    ? Object.freeze({
        mode: 'postgres' as const,
        connectionString: databaseUrlSchema.parse(parsed.ANALYSIS_DATABASE_URL),
        ssl: parsed.ANALYSIS_DATABASE_SSL,
        poolMax: parsed.ANALYSIS_DB_POOL_MAX,
        connectTimeoutMs: parsed.ANALYSIS_DB_CONNECT_TIMEOUT_MS,
        encryptionKey: encryptionKeySchema.parse(parsed.ANALYSIS_CONTENT_ENCRYPTION_KEY),
      })
    : Object.freeze({ mode: 'disabled' as const })

  return Object.freeze({
    serviceVersion: SERVICE_VERSION,
    environment: parsed.NODE_ENV,
    host: parsed.ANALYSIS_HOST,
    port: parsed.ANALYSIS_PORT,
    logLevel: parsed.ANALYSIS_LOG_LEVEL,
    corsOrigins: Object.freeze([...parsed.ANALYSIS_CORS_ORIGINS]),
    auth,
    trustProxyHops: parsed.ANALYSIS_TRUST_PROXY_HOPS,
    rateLimitMax: parsed.ANALYSIS_RATE_LIMIT_MAX,
    rateLimitWindowMs: parsed.ANALYSIS_RATE_LIMIT_WINDOW_MS,
    bodyLimitBytes: parsed.ANALYSIS_BODY_LIMIT_BYTES,
    requestTimeoutMs: parsed.ANALYSIS_REQUEST_TIMEOUT_MS,
    connectionTimeoutMs: parsed.ANALYSIS_CONNECTION_TIMEOUT_MS,
    keepAliveTimeoutMs: parsed.ANALYSIS_KEEP_ALIVE_TIMEOUT_MS,
    shutdownTimeoutMs: parsed.ANALYSIS_SHUTDOWN_TIMEOUT_MS,
    retentionSeconds: parsed.ANALYSIS_RETENTION_SECONDS,
    requestLogsEnabled: parsed.ANALYSIS_ENABLE_REQUEST_LOGS,
    jobStore,
    sseHeartbeatMs: parsed.ANALYSIS_SSE_HEARTBEAT_MS,
    ssePollMs: parsed.ANALYSIS_SSE_POLL_MS,
    leaseMs: parsed.ANALYSIS_LEASE_MS,
    cleanupBatchSize: parsed.ANALYSIS_CLEANUP_BATCH_SIZE,
    cleanupIntervalMs: parsed.ANALYSIS_CLEANUP_INTERVAL_MS,
  })
}
