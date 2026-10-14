import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AesGcmContentCipher } from '../src/infrastructure/contentCipher.js'
import { ANALYSIS_SCHEMA_VERSION } from '../src/infrastructure/postgres/migrations.js'

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), end: vi.fn(), on: vi.fn(), connect: vi.fn() }))
vi.mock('pg', () => ({ Pool: class {
  query = mocks.query; on = mocks.on; end = mocks.end; connect = mocks.connect
} }))
import { PostgresJobStore } from '../src/infrastructure/postgres/postgresJobStore.js'
const options = { connectionString: 'postgresql://synthetic:synthetic@localhost/cat_analysis_test', ssl: 'disable' as const,
  poolMax: 1, connectTimeoutMs: 1000, cipher: new AesGcmContentCipher(Buffer.alloc(32, 31)), schemaPolicy: 'require-current' as const }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.end.mockResolvedValue(undefined)
})
describe('target PostgreSQL connection requires existing current schema without DDL', () => {
  it('reads the current migration version and does not invoke migrations', async () => {
    mocks.query.mockResolvedValue({ rows: [{ version: ANALYSIS_SCHEMA_VERSION }] })
    const store = await PostgresJobStore.connect(options)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0][0]).toBe('SELECT MAX(version)::integer AS version FROM cat_analysis_schema_migrations')
    await store.close(); expect(mocks.end).toHaveBeenCalledOnce()
  })
  it('rejects missing, older and newer schema versions and closes initialization resources', async () => {
    for (const version of [null, ANALYSIS_SCHEMA_VERSION - 1, ANALYSIS_SCHEMA_VERSION + 1]) {
      mocks.query.mockResolvedValue({ rows: [{ version }] })
      await expect(PostgresJobStore.connect(options)).rejects.toThrow('analysis_database_schema_not_current')
    }
    expect(mocks.release).toHaveBeenCalledTimes(3); expect(mocks.end).toHaveBeenCalledTimes(3)
    expect(mocks.query.mock.calls.every(([query]) => query.startsWith('SELECT'))).toBe(true)
  })
  it('sanitizes missing-table/query errors and never attempts DDL recovery', async () => {
    mocks.query.mockRejectedValue(new Error('raw database secret would be unsafe'))
    await expect(PostgresJobStore.connect(options)).rejects.toThrow('analysis_database_schema_not_current')
    expect(mocks.end).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce()
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
})
