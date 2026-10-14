import { spawn, execFile } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, access, lstat, realpath, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { Pool } from 'pg'

const exec = promisify(execFile)
const exists = async (path) => { try { await access(path); return true } catch { return false } }
export const readDesktopJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
export const cleanDesktopEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('ANALYSIS_') && !name.startsWith('VITE_ANALYSIS') && !['PGPASSWORD', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'].includes(name)))
export function validateDatabaseConfiguration(config) {
  if (config?.version !== 1 || config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
    config.admin?.user !== 'cat_analysis_admin' || !/^[A-Za-z0-9_-]{40,100}$/u.test(config.admin.password) ||
    config.databases?.local?.name !== 'cat_analysis_local' || config.databases.local.user !== 'cat_analysis_local' ||
    !/^[A-Za-z0-9_-]{40,100}$/u.test(config.databases.local.password) || !/^[A-Za-z0-9_-]{40,100}$/u.test(config.serviceToken) ||
    typeof config.contentEncryptionKey !== 'string' || Buffer.from(config.contentEncryptionKey, 'base64').length !== 32) throw new Error('desktop_database_config_invalid_no_key_regeneration')
  return config
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true })
  if (process.platform !== 'win32') return
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
  const sid = stdout.match(/S-1-5-[0-9-]+/u)?.[0]
  if (!sid) throw new Error('desktop_current_user_unavailable')
  for (const args of [[path, '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '/T', '/Q'],
    [path, '/inheritance:r', '/T', '/Q'], [path, '/grant', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/T', '/Q']]) {
    await exec('icacls.exe', args, { windowsHide: true, maxBuffer: 1_000_000 })
  }
}
export async function assertOwnedDataDirectory(dataRoot) {
  const path = resolve(dataRoot)
  if (path === dirname(path)) throw new Error('desktop_data_root_invalid')
  const owner = await readDesktopJson(join(path, '.cat-thinking-data.json'))
  if (owner.version !== 1 || owner.application !== 'cat-thinking' || !/^[a-f0-9-]{36}$/u.test(owner.installId) || resolve(owner.dataRoot).toLowerCase() !== path.toLowerCase()) throw new Error('desktop_data_owner_invalid')
  if ((await lstat(path)).isSymbolicLink()) throw new Error('desktop_data_root_link_unexpected')
  return owner
}
async function asciiAlias(target, role) {
  const hash = createHash('sha256').update(resolve(target).toLowerCase()).digest('hex').slice(0, 16)
  const base = process.env.CAT_THINKING_ALIAS_ROOT ? resolve(process.env.CAT_THINKING_ALIAS_ROOT) : tmpdir()
  if (/[^\x20-\x7e]/u.test(base)) throw new Error('desktop_ascii_alias_root_required')
  const path = join(base, `cat-thinking-${role}-${hash}`)
  try {
    const info = await lstat(path)
    if (!info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== (await realpath(target)).toLowerCase()) throw new Error('desktop_alias_conflict')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(target, path, 'junction')
  }
  return path
}
export async function databaseRuntime(programRoot, dataRoot) {
  await assertOwnedDataDirectory(dataRoot)
  await privateDirectory(dataRoot)
  const programAlias = await asciiAlias(programRoot, 'program')
  const dataAlias = await asciiAlias(dataRoot, 'data')
  const binaries = join(programAlias, 'runtime/postgres/bin')
  const cluster = join(dataAlias, 'cluster')
  const run = async (name, args, environment = {}) => {
    const child = spawn(join(binaries, `${name}.exe`), args, { cwd: programAlias, env: { ...cleanDesktopEnvironment(), ...environment }, windowsHide: true, stdio: 'ignore', shell: false })
    const result = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
    if (result !== 0) throw new Error(`desktop_database_command_failed:${name}`)
  }
  const configPath = join(dataRoot, 'secrets/database.json')
  const load = async () => validateDatabaseConfiguration(await readDesktopJson(configPath))
  const connect = (config, admin = false) => {
    const credentials = admin ? config.admin : config.databases.local
    const pool = new Pool({ host: config.host, port: config.port, user: credentials.user, password: credentials.password,
      database: admin ? 'postgres' : credentials.name, ssl: false, max: 2, connectionTimeoutMillis: 5000 })
    pool.on('error', () => undefined)
    return pool
  }
  const running = async () => { try { await run('pg_ctl', ['-D', cluster, 'status']); return true } catch { return false } }
  const start = async () => { if (!await running()) await run('pg_ctl', ['-D', cluster, '-l', join(dataAlias, 'postgres.log'), '-w', '-t', '30', 'start']) }
  const stop = async () => { if (await running()) await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', '-t', '30', 'stop']) }
  const setup = async () => {
    await privateDirectory(join(dataRoot, 'secrets'))
    if (!await exists(configPath)) {
      if (await exists(join(cluster, 'PG_VERSION'))) throw new Error('desktop_cluster_without_key_refuse_reinitialize')
      const config = { version: 1, host: '127.0.0.1', port: 55435, admin: { user: 'cat_analysis_admin', password: randomBytes(32).toString('base64url') },
        databases: { local: { name: 'cat_analysis_local', user: 'cat_analysis_local', password: randomBytes(32).toString('base64url') } },
        contentEncryptionKey: randomBytes(32).toString('base64'), serviceToken: randomBytes(32).toString('base64url') }
      await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    }
    const config = await load()
    if (!await exists(join(cluster, 'PG_VERSION'))) {
      const passwordFile = join(dataAlias, 'secrets/initdb-password.tmp')
      try {
        await writeFile(passwordFile, config.admin.password, { flag: 'wx', mode: 0o600 })
        await run('initdb', ['-D', cluster, '-U', config.admin.user, '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${passwordFile}`])
      } finally { await rm(passwordFile, { force: true }) }
      await writeFile(join(cluster, 'postgresql.auto.conf'), `listen_addresses = '127.0.0.1'\nport = ${config.port}\npassword_encryption = 'scram-sha-256'\nmax_connections = 30\nshared_buffers = '64MB'\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\nlog_parameter_max_length_on_error = 0\n`)
    }
    if ((await readFile(join(cluster, 'PG_VERSION'), 'utf8')).trim() !== '18') throw new Error('desktop_postgres_major_upgrade_requires_migration')
    await privateDirectory(join(dataRoot, 'cluster'))
    await start()
    const admin = connect(config, true)
    try {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', ['cat_analysis_local'])).rowCount) await admin.query(`CREATE ROLE cat_analysis_local LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${config.databases.local.password}'`)
      if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', ['cat_analysis_local'])).rowCount) await admin.query('CREATE DATABASE cat_analysis_local OWNER cat_analysis_local')
      await admin.query('REVOKE ALL ON DATABASE cat_analysis_local FROM PUBLIC')
      await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC')
    } finally { await admin.end() }
    return config
  }
  return { binaries, cluster, dataAlias, run, load, connect, running, start, stop, setup }
}

export function serviceEnvironment(config, ports, readOnly = false) {
  // The existing service deliberately reserves NODE_ENV=production for TLS deployments.
  // Desktop uses its explicit authenticated loopback personal mode with already-built assets.
  return { ...cleanDesktopEnvironment(), NODE_ENV: 'development', ANALYSIS_HOST: '127.0.0.1', ANALYSIS_PORT: String(ports.servicePort), ANALYSIS_OPERATING_MODE: 'personal',
    ANALYSIS_JOB_STORE: 'postgres', ANALYSIS_DATABASE_URL: `postgresql://cat_analysis_local:${encodeURIComponent(config.databases.local.password)}@127.0.0.1:${config.port}/cat_analysis_local`,
    ANALYSIS_DATABASE_SSL: 'disable', ANALYSIS_CONTENT_ENCRYPTION_KEY: config.contentEncryptionKey, ANALYSIS_AUTH_MODE: 'service-token',
    ANALYSIS_SERVICE_TOKEN: config.serviceToken, ANALYSIS_CORS_ORIGINS: ports.frontendUrl, ANALYSIS_PROVIDER_MODE: 'disabled', ANALYSIS_RELEASE_HOLD: 'true',
    ...(readOnly ? { ANALYSIS_PERSONAL_READ_ONLY: 'true' } : {}) }
}
