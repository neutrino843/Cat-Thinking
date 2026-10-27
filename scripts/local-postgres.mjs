import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, access, symlink, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { chooseLocalAppPorts, chooseLocalDatabasePort, isLocalDatabasePort, stopOwnedService, waitForLocalReadiness } from './local-app-lifecycle.mjs'
import { assertPostgresTestEvidence } from './postgres-test-evidence.mjs'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = resolve(root, '..', '.cat-thinking-postgres')
const secrets = join(runtime, 'secrets')
const configPath = join(secrets, 'database.json')
// EDB Windows initdb cannot bootstrap UTF8 under some non-ASCII install paths.
// The junction contains no data; its target remains the durable project directory.
const nativeRuntime = join(tmpdir(), `cat-analysis-pg-${createHash('sha256').update(runtime).digest('hex').slice(0, 12)}`)
const data = join(nativeRuntime, 'data')
const binaries = join(nativeRuntime, 'pgsql', 'bin')
const nativePath = (path) => join(nativeRuntime, path)
const ensureNativePath = async () => {
  if ([...nativeRuntime].some((character) => character.codePointAt(0) > 127)) throw new Error('local_database_requires_ASCII_temporary_directory')
  await mkdir(runtime, { recursive: true })
  try {
    const stat = await lstat(nativeRuntime)
    if (!stat.isSymbolicLink() || (await realpath(nativeRuntime)).toLowerCase() !== runtime.toLowerCase()) throw new Error('local_database_path_alias_conflict')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(runtime, nativeRuntime, 'junction')
  }
}
const names = Object.freeze({ local: 'cat_analysis_local', test: 'cat_analysis_test', smoke: 'cat_analysis_smoke' })
const exists = async (path) => { try { await access(path); return true } catch { return false } }
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANALYSIS_') && !name.startsWith('VITE_ANALYSIS') && !['PGPASSWORD', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'NODE_ENV'].includes(name)))
const execute = async (file, args, env = cleanEnvironment()) => {
  try { return await exec(file, args, { cwd: root, env, windowsHide: true, maxBuffer: 2_000_000 }) }
  catch { throw new Error(`local_database_command_failed:${file.split(/[\\/]/u).pop()}`) }
}
const pg = async (name, args, env = cleanEnvironment()) => {
  // Windows PostgreSQL background children may retain inherited pipes. Wait for
  // pg_ctl's exit, with no inherited pipe handles, rather than collecting output.
  const child = spawn(join(binaries, `${name}.exe`), args, { cwd: root, env, windowsHide: true, stdio: 'ignore', shell: false })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  if (code !== 0) throw new Error(`local_database_command_failed:${name}.exe`)
}
const load = async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (config.version !== 1 || config.host !== '127.0.0.1' || !isLocalDatabasePort(config.port) || !config.admin?.password
    || Object.entries(names).some(([kind, name]) => config.databases?.[kind]?.name !== name || config.databases[kind].user !== name || !config.databases[kind].password)) throw new Error('local_database_configuration_invalid')
  return config
}
const pool = (config, kind) => new Pool({ host: config.host, port: config.port,
  database: kind ? names[kind] : 'postgres', user: kind ? config.databases[kind].user : config.admin.user,
  password: kind ? config.databases[kind].password : config.admin.password, ssl: false, max: 2, connectionTimeoutMillis: 5000 })
const url = (config, kind) => `postgresql://${config.databases[kind].user}:${encodeURIComponent(config.databases[kind].password)}@${config.host}:${config.port}/${names[kind]}`
const npm = async (args, env = cleanEnvironment()) => {
  if (!process.env.npm_execpath) throw new Error('use_npm_run_database_commands')
  const child = spawn(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  if (code !== 0) throw new Error('local_database_validation_failed')
}
const serviceEnvironment = (config) => ({ ...cleanEnvironment(), NODE_ENV: 'development', ANALYSIS_HOST: '127.0.0.1', ANALYSIS_JOB_STORE: 'postgres',
  ANALYSIS_DATABASE_URL: url(config, 'local'), ANALYSIS_DATABASE_SSL: 'disable', ANALYSIS_CONTENT_ENCRYPTION_KEY: config.contentEncryptionKey,
  ANALYSIS_AUTH_MODE: 'service-token', ANALYSIS_SERVICE_TOKEN: config.serviceToken, ANALYSIS_CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  ANALYSIS_PROVIDER_MODE: 'disabled', ANALYSIS_RELEASE_HOLD: 'true' })
const running = async () => {
  try { await pg('pg_ctl', ['-D', data, 'status']); return true } catch { return false }
}
const start = async () => { await load(); if (!await running()) await pg('pg_ctl', ['-D', data, '-l', nativePath('postgres.log'), '-w', '-t', '30', 'start']) }
const stop = async () => { if (await running()) await pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']) }

const setup = async () => {
  if (!await exists(join(binaries, 'initdb.exe'))) throw new Error('install_PostgreSQL_with_npm_run_db_install_first')
  await mkdir(secrets, { recursive: true })
  // Restrict local credentials to the current Windows user and SYSTEM.
  const { stdout: identity } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
  const sid = identity.match(/S-1-5-[0-9-]+/u)?.[0]
  if (!sid) throw new Error('current_user_identity_unavailable')
  // Program files may have been unpacked by a different sandbox account. Only
  // credential and cluster directories need private ACLs; never take their ownership.
  const protect = async (path) => {
    // (OI)/(CI) apply to directories, not file ACEs. Preserve explicit file
    // access before removing inheritance; add directory propagation separately.
    await execute('icacls.exe', [path, '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '/T', '/Q'])
    await execute('icacls.exe', [path, '/inheritance:r', '/T', '/Q'])
    await execute('icacls.exe', [path, '/grant', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/T', '/Q'])
  }
  await protect(secrets)
  if (!await exists(configPath)) {
    const port = await chooseLocalDatabasePort()
    const config = { version: 1, host: '127.0.0.1', port, admin: { user: 'cat_analysis_admin', password: randomBytes(32).toString('base64url') },
      databases: Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, { name, user: name, password: randomBytes(32).toString('base64url') }])),
      contentEncryptionKey: randomBytes(32).toString('base64'), serviceToken: randomBytes(32).toString('base64url') }
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 })
  }
  const config = await load()
  if (!await exists(join(data, 'PG_VERSION'))) {
    const passwordFile = join(secrets, 'initdb-password.tmp')
    try {
      await writeFile(passwordFile, config.admin.password, { flag: 'wx', mode: 0o600 })
      await pg('initdb', ['-D', data, '-U', config.admin.user, '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${nativePath('secrets/initdb-password.tmp')}`])
    } finally { await rm(passwordFile, { force: true }) }
    await writeFile(join(data, 'postgresql.auto.conf'), `listen_addresses = '127.0.0.1'\nport = ${config.port}\npassword_encryption = 'scram-sha-256'\nmax_connections = 30\nshared_buffers = '64MB'\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\nlog_parameter_max_length_on_error = 0\n`)
  }
  await protect(data)
  await start()
  const admin = pool(config)
  try {
    for (const [kind, database] of Object.entries(config.databases)) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [database.user])).rowCount) await admin.query(`CREATE ROLE ${names[kind]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${database.password}'`)
      if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database.name])).rowCount) await admin.query(`CREATE DATABASE ${names[kind]} OWNER ${names[kind]}`)
      await admin.query(`REVOKE ALL ON DATABASE ${names[kind]} FROM PUBLIC`)
    }
    await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC')
  } finally { await admin.end() }
  for (const kind of Object.keys(names)) {
    const connection = pool(config, kind)
    try { await connection.query('SELECT 1') } finally { await connection.end() }
  }
  console.log(`Local PostgreSQL ready at 127.0.0.1:${config.port}; three isolated databases configured. Provider disabled; release held.`)
}

const status = async () => {
  const active = await running()
  const config = await exists(configPath) ? await load() : undefined
  console.log(JSON.stringify({ installed: await exists(join(binaries, 'postgres.exe')), configured: Boolean(config), running: active, host: '127.0.0.1', port: config?.port ?? null, databases: Object.values(names), provider: 'disabled', releaseHold: true }, null, 2))
}
const prepareProvider = async () => {
  const arguments_ = process.argv.slice(3)
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--config' || !arguments_[1])) throw new Error('local_provider_preparation_arguments_invalid')
  const config = await load()
  const environment = { ...serviceEnvironment(config), ANALYSIS_TEST_DATABASE_URL: url(config, 'smoke'), ANALYSIS_RECOVERY_TEST_DATABASE_URL: url(config, 'test') }
  if (arguments_.length) {
    const { readBoundedFile } = await import('../services/analysis-service/dist/release/buildIdentity.js')
    const input = JSON.parse(await readBoundedFile(resolve(arguments_[1]), 65_536))
    const allowedOperations = new Set(['ANALYSIS_CI_PREREQUISITES_PATH', 'ANALYSIS_RELEASE_PUBLIC_KEY_PATH', 'ANALYSIS_LIVE_SMOKE',
      'ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_TOKENS', 'ANALYSIS_LIVE_SMOKE_MAX_ESTIMATED_COST_MICROS', 'ANALYSIS_LIVE_SMOKE_EXECUTION_ID',
      'ANALYSIS_LIVE_SMOKE_CHECKPOINT_PATH', 'ANALYSIS_RELEASE_SIGNING_KEY_PATH', 'ANALYSIS_RELEASE_ATTESTATION_PATH'])
    if (!input || input.version !== 1 || typeof input.environment !== 'object' || input.environment === null
      || Array.isArray(input.environment) || Object.keys(input).some((name) => !['version', 'environment'].includes(name))
      || Object.entries(input.environment).some(([name, value]) => (!/^ANALYSIS_PROVIDER_[A-Z0-9_]{1,100}$/u.test(name) && !allowedOperations.has(name))
        || typeof value !== 'string' || value.length > 8192)) throw new Error('local_provider_preparation_configuration_invalid')
    Object.assign(environment, input.environment)
  }
  // Preparation does not start PostgreSQL, the service, a dispatcher or a Provider.
  const child = spawn(process.execPath, ['scripts/prepare-analysis-provider.mjs'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: false })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  if (code === 2) process.exitCode = 2
  else if (code !== 0) throw new Error('local_provider_preparation_failed')
}
const validate = async () => {
  const config = await load()
  await start()
  const environment = { ...cleanEnvironment(), NODE_ENV: 'test', ANALYSIS_TEST_DATABASE_URL: url(config, 'test'), ANALYSIS_PROVIDER_MODE: 'disabled', ANALYSIS_RELEASE_HOLD: 'true' }
  await mkdir(join(runtime, 'evidence'), { recursive: true })
  await npm(['run', 'test:service:postgres', '--', '--reporter=json', `--outputFile=${join(runtime, 'evidence', 'postgres-tests.json')}`], environment)
  const report = JSON.parse(await readFile(join(runtime, 'evidence', 'postgres-tests.json'), 'utf8'))
  assertPostgresTestEvidence(report)
  await npm(['run', 'coverage:postgres'], environment)
  console.log('Real local PostgreSQL recovery tests and coverage passed; no live Provider invoked.')
}
const backup = async (config) => {
  const directory = join(secrets, 'backups')
  await mkdir(directory, { recursive: true })
  const path = nativePath(`secrets/backups/cat_analysis_local-${Date.now()}.dump`)
  const database = config.databases.local
  await pg('pg_dump', ['-h', config.host, '-p', String(config.port), '-U', database.user, '-d', database.name, '-Fc', '--no-owner', '--no-acl', '-f', path], { ...cleanEnvironment(), PGPASSWORD: database.password })
  console.log('Local database backup created under the protected backups directory. Preserve database.json with the dump to retain its encryption key.')
  return path
}
const verify = async () => {
  const config = await load()
  await start()
  await npm(['run', 'build:service'])
  const { PostgresJobStore } = await import('../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js')
  const { AesGcmContentCipher } = await import('../services/analysis-service/dist/infrastructure/contentCipher.js')
  const { RunService } = await import('../services/analysis-service/dist/domain/runService.js')
  const { loadAnalysisServiceConfig } = await import('../services/analysis-service/dist/config.js')
  const { ReleaseGate } = await import('../services/analysis-service/dist/release/releaseGate.js')
  const { buildAnalysisServer } = await import('../services/analysis-service/dist/api/server.js')
  const serviceConfig = loadAnalysisServiceConfig(serviceEnvironment(config))
  const connect = () => PostgresJobStore.connectFromConfig(serviceConfig.jobStore, new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64')))
  const tenantId = 'local-database-self-check'
  const sourceId = 'synthetic-source'
  const text = 'Synthetic local database recovery verification.'
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  let store = await connect()
  let runId
  let restoredDatabase
  let dump
  let cleanupFailed
  try {
    const service = new RunService({ store, retentionSeconds: 3600 })
    const created = await service.createRun(tenantId, { version: 1, requestKey: hash(randomBytes(32)), docId: 'synthetic-local-doc',
      manifest: { version: 1, sources: [{ version: 1, sourceId, kind: 'text', extractor: 'local-self-check@1', contentHash: hash(text), charCount: text.length, byteCount: Buffer.byteLength(text) }] },
      artifacts: ['summary'], options: { locale: 'zh-CN', qualityProfile: 'standard', summaryDetail: 'standard', quizQuestionCount: 1, externalKnowledge: false } })
    runId = created.run.id
    await service.uploadSource(tenantId, runId, { version: 1, sourceId, contentHash: hash(text), partHash: hash(text), partIndex: 0, partCount: 1, start: 0, end: text.length, totalChars: text.length, text })
    await store.close()
    await stop()
    await start()
    store = await connect()
    if ((await store.getSourceContent(tenantId, runId, sourceId))?.text !== text) throw new Error('physical_restart_decryption_failed')
    if ((await new ReleaseGate({ config: serviceConfig }).status()).ready) throw new Error('local_release_must_remain_held')
    const server = await buildAnalysisServer(serviceConfig, { logger: false, runService: new RunService({ store, retentionSeconds: 3600 }) })
    try {
      if ((await server.inject({ url: '/ready' })).statusCode !== 200) throw new Error('local_store_not_ready')
      const headers = { authorization: `Bearer ${config.serviceToken}`, 'x-cat-tenant-id': tenantId, origin: 'http://localhost:5173' }
      if ((await server.inject({ url: '/api/analysis/v1/capabilities', headers })).json().acceptsRuns !== false) throw new Error('local_admission_not_closed')
      if ((await server.inject({ method: 'POST', url: '/api/analysis/v1/runs', headers, payload: {} })).statusCode !== 503) throw new Error('local_admission_not_rejected')
    } finally { await server.close() }
    dump = await backup(config)
    restoredDatabase = `cat_analysis_restore_${randomBytes(8).toString('hex')}`
    const admin = pool(config)
    try { await admin.query(`CREATE DATABASE ${restoredDatabase} OWNER ${names.local}`); await admin.query(`REVOKE ALL ON DATABASE ${restoredDatabase} FROM PUBLIC`) } finally { await admin.end() }
    await pg('pg_restore', ['-h', config.host, '-p', String(config.port), '-U', names.local, '-d', restoredDatabase, '--exit-on-error', '--no-owner', '--no-acl', dump], { ...cleanEnvironment(), PGPASSWORD: config.databases.local.password })
    const restoreUrl = new URL(url(config, 'local'))
    restoreUrl.pathname = `/${restoredDatabase}`
    const restoreConfig = { ...serviceConfig.jobStore, connectionString: restoreUrl.toString() }
    const restored = await PostgresJobStore.connectFromConfig(restoreConfig, new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64')))
    try { if ((await restored.getSourceContent(tenantId, runId, sourceId))?.text !== text) throw new Error('backup_restore_decryption_failed') } finally { await restored.close() }
    // Also verify that test credentials cannot access the local database.
    const isolated = new Pool({ host: config.host, port: config.port, user: names.test, password: config.databases.test.password, database: names.local, connectionTimeoutMillis: 5000 })
    try {
      let rejected = false
      try { await isolated.query('SELECT 1') } catch (error) { rejected = error.code === '42501' }
      if (!rejected) throw new Error('cross_database_access_not_isolated')
    } finally { await isolated.end() }
  } finally {
    const failures = []
    try { if (runId) await store.deleteContent(tenantId, runId) } catch { failures.push('content') }
    try { await store.close() } catch { failures.push('store') }
    if (restoredDatabase) {
      const admin = pool(config)
      try { await admin.query(`DROP DATABASE ${restoredDatabase}`) } catch { failures.push('restore') } finally { await admin.end() }
    }
    try { if (dump) await rm(dump, { force: true }) } catch { failures.push('dump') }
    cleanupFailed = failures.length > 0
  }
  if (cleanupFailed) throw new Error('local_database_verification_cleanup_failed')
  console.log('Physical restart, encrypted source recovery, isolated backup restore, cross-database denial, service readiness and HTTP 503 admission verified.')
}

const startApp = async (verifyOnly, personal = false) => {
  // Select before any install or compilation. Never reuse a listener merely
  // because it answers HTTP; strict child binding still detects a later race.
  const ports = await chooseLocalAppPorts()
  const { servicePort, frontendPort, serviceUrl, frontendUrl, origins } = ports
  if (servicePort !== 8787 || frontendPort !== 5173) console.log(`默认端口已有程序使用，已改用应用地址 ${frontendUrl} 和后台端口 ${servicePort}。现有程序保持运行。`)
  if (personal && !await exists(join(binaries, 'initdb.exe'))) {
    console.log('首次启动正在准备本机数据库，完成后会自动打开应用服务。')
    await npm(['run', 'db:install'])
  }
  if (personal && !await exists(configPath)) await setup()
  const config = await load(); await start(); await npm(['run', 'build:service'])
  const environment = { ...serviceEnvironment(config), ANALYSIS_OPERATING_MODE: personal ? 'personal' : 'deployment',
    // Deployment startup runs normal retention maintenance. Probe only the
    // dedicated test database, never existing personal analysis content.
    ...(verifyOnly && !personal ? { ANALYSIS_DATABASE_URL: url(config, 'test') } : {}),
    ANALYSIS_PORT: String(servicePort), ANALYSIS_CORS_ORIGINS: origins,
    ...(personal && verifyOnly ? { ANALYSIS_PERSONAL_READ_ONLY: 'true' } : {}),
    ANALYSIS_GATEWAY_UPSTREAM: serviceUrl,
    ANALYSIS_GATEWAY_TOKEN: config.serviceToken, ANALYSIS_GATEWAY_TENANT: 'local-development',
    ANALYSIS_GATEWAY_ORIGINS: origins }
  const service = spawn(process.execPath, ['services/analysis-service/dist/index.js'], { cwd: root, env: environment, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true, shell: false })
  // Outcomes never reject while startup polling is awaiting a different promise.
  const observeExit = (child) => new Promise((done) => {
    child.once('error', () => done({ code: 1 }))
    child.once('exit', (code) => done({ code }))
  })
  const exited = observeExit(service)
  let frontend
  let frontendExit
  let stopping = false
  let shutdownPromise
  const stopChildren = () => {
    stopping = true
    frontend?.kill()
    shutdownPromise ??= stopOwnedService(service)
  }
  process.once('SIGINT', stopChildren); process.once('SIGTERM', stopChildren)
  try {
    const ready = await waitForLocalReadiness({
      probe: async () => (await fetch(`${serviceUrl}/ready`, { signal: AbortSignal.timeout(1000) })).ok,
      hasExited: () => service.exitCode !== null || service.signalCode !== null,
      shouldStop: () => stopping,
    })
    if (ready === 'stopped') return
    if (ready === 'exited') throw new Error('local_service_exited_unsuccessfully')
    if (ready !== 'ready') throw new Error('local_service_startup_timeout')
    frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: false })
    frontendExit = observeExit(frontend)
    {
      const frontendReady = await waitForLocalReadiness({
        probe: async () => (await fetch(`${frontendUrl}/`, { signal: AbortSignal.timeout(1000) })).ok,
        hasExited: () => frontend.exitCode !== null || frontend.signalCode !== null || service.exitCode !== null || service.signalCode !== null,
        shouldStop: () => stopping, timeoutMs: 15_000,
      })
      if (frontendReady === 'stopped') return
      if (frontendReady === 'exited') throw new Error('local_app_exited_unsuccessfully')
      if (frontendReady !== 'ready') throw new Error('local_frontend_startup_timeout')
    }
    console.log(personal
      ? `CatThinking 已启动：${frontendUrl} 。点击「AI 设置」，选择服务商、填写密钥和模型，然后保存并连接。按 Ctrl+C 可正常停止应用；文档和已保存连接会保留。`
      : `Local development app ready at ${frontendUrl}; deployment admission stays held.`)
    if (personal && !verifyOnly) {
      const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', frontendUrl],
        { cwd: root, env: cleanEnvironment(), stdio: 'ignore', windowsHide: true, shell: false })
      browser.once('error', () => console.log(`请在浏览器打开 ${frontendUrl} 。`))
      browser.unref()
    }
    if (verifyOnly) {
      const headers = { origin: frontendUrl, 'content-type': 'application/json', authorization: 'Bearer browser-forged', 'x-cat-tenant-id': 'browser-forged' }
      const capabilities = await fetch(`${frontendUrl}/api/analysis/v1/capabilities`, { headers, signal: AbortSignal.timeout(5000) })
      if (!capabilities.ok) throw new Error('local_gateway_capabilities_unavailable')
      const value = await capabilities.json()
      if (personal) {
        if (value.operatingMode !== 'personal') throw new Error('local_personal_mode_missing')
        const settings = await fetch(`${frontendUrl}/api/analysis/v1/personal/settings`, { headers, signal: AbortSignal.timeout(5000) })
        const { personalProviderStatusSchema } = await import('@cat-thinking/analysis-contracts')
        if (!settings.ok || !personalProviderStatusSchema.parse(await settings.json()).available) throw new Error('local_personal_settings_unavailable')
        console.log('Personal app and authenticated settings gateway verified; only metadata was read and no analysis was created.')
      } else {
        if (value.acceptsRuns !== false) throw new Error('local_gateway_admission_not_closed')
        const create = await fetch(`${frontendUrl}/api/analysis/v1/runs`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000) })
        if (create.status !== 503) throw new Error('local_gateway_creation_not_rejected')
        console.log('Local app and trusted browser gateway verified: acceptsRuns=false, new runs rejected with HTTP 503; Provider disabled.')
      }
    } else {
      const outcome = await Promise.race([frontendExit, exited])
      if (!stopping && outcome.code !== 0) throw new Error('local_app_exited_unsuccessfully')
    }
  } finally {
    process.removeListener('SIGINT', stopChildren); process.removeListener('SIGTERM', stopChildren)
    stopChildren()
    await shutdownPromise
    await Promise.all([exited, ...(frontendExit ? [frontendExit] : [])])
  }
}

// A paid sample check is a separate, explicit operation, never part of startup.
const verifyPersonalProvider = async (allArtifacts = false) => {
  const maximum = allArtifacts ? 8 : 3
  const requestLimit = Number((allArtifacts ? process.env.ANALYSIS_PERSONAL_LEARNING_REQUEST_LIMIT : process.env.ANALYSIS_PERSONAL_VERIFICATION_REQUEST_LIMIT) ?? String(maximum))
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > maximum) {
    throw new Error('local_personal_verification_request_limit_invalid')
  }
  const config = await load()
  await start()
  await npm(['run', 'build:service'])
  const { loadAnalysisServiceConfig } = await import('../services/analysis-service/dist/config.js')
  const { AesGcmContentCipher } = await import('../services/analysis-service/dist/infrastructure/contentCipher.js')
  const { PostgresJobStore } = await import('../services/analysis-service/dist/infrastructure/postgres/postgresJobStore.js')
  const { PostgresPersonalProfileStore } = await import('../services/analysis-service/dist/infrastructure/postgres/postgresPersonalProfileStore.js')
  const { verifyPersonalProvider: verifySummaryOutline, verifyPersonalLearningPipeline } = await import('../services/analysis-service/dist/operations/personalProviderVerification.js')
  const verifySample = allArtifacts ? verifyPersonalLearningPipeline : verifySummaryOutline
  const serviceConfig = loadAnalysisServiceConfig({ ...serviceEnvironment(config), ANALYSIS_OPERATING_MODE: 'personal' })
  const boundedDatabaseUrl = new URL(serviceConfig.jobStore.connectionString)
  boundedDatabaseUrl.searchParams.set('options', '-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000')
  boundedDatabaseUrl.searchParams.set('query_timeout', '6000')
  const verificationStoreConfig = { ...serviceConfig.jobStore, connectionString: boundedDatabaseUrl.toString() }
  const cipher = new AesGcmContentCipher(Buffer.from(config.contentEncryptionKey, 'base64'))
  const store = await PostgresJobStore.connect({ ...verificationStoreConfig, cipher, schemaPolicy: 'require-current',
    applicationName: 'cat-analysis-personal-sample-verification' })
  let profiles
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    profiles = await PostgresPersonalProfileStore.connect(verificationStoreConfig, cipher, store)
    const result = await verifySample({ store, profiles, signal: controller.signal, requestLimit })
    // Only the operation's allowlisted metadata and validated public sample artifacts.
    console.log(JSON.stringify(result, null, 2))
    if (result.outcome !== 'passed' || !result.cleanupComplete || !result.profileStateUnchanged) process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    try { await profiles?.close() } finally { await store.close() }
  }
}

const action = process.argv[2]
try {
  if (action === 'personal-provider-check' && process.env.ANALYSIS_PERSONAL_VERIFICATION_ACK !== 'personal-live-up-to-3') {
    throw new Error('local_personal_verification_requires_explicit_paid_sample_acknowledgement')
  }
  if (action === 'personal-learning-check' && process.env.ANALYSIS_PERSONAL_LEARNING_ACK !== 'personal-live-all-up-to-8') {
    throw new Error('local_personal_learning_requires_explicit_paid_sample_acknowledgement')
  }
  if (process.platform !== 'win32') throw new Error('local_native_PostgreSQL_commands_require_Windows')
  await ensureNativePath()
  if (action === 'setup') await setup()
  else if (action === 'start') { await start(); await status() }
  else if (action === 'stop') { await stop(); console.log('Project PostgreSQL stopped; all data retained.') }
  else if (action === 'status') await status()
  else if (action === 'prepare-provider') await prepareProvider()
  else if (action === 'test') await validate()
  else if (action === 'browser' || action === 'personal-browser') {
    const config = await load(); await start()
    const reportPath = join(root, 'test-results', action === 'personal-browser' ? 'personal-browser-results.json' : 'analysis-browser-results.json')
    await npm(['run', action === 'personal-browser' ? 'e2e:personal' : 'e2e:analysis'], { ...cleanEnvironment(), NODE_ENV: 'test',
      ANALYSIS_TEST_DATABASE_URL: url(config, 'test'), ANALYSIS_BROWSER_JSON_REPORT_PATH: reportPath })
  }
  else if (action === 'verify') await verify()
  else if (action === 'backup') { const config = await load(); await start(); await backup(config) }
  else if (action === 'service') {
    const config = await load(); await start(); await npm(['run', 'build:service'])
    const child = spawn(process.execPath, ['services/analysis-service/dist/index.js'], { cwd: root, env: serviceEnvironment(config), stdio: 'inherit', windowsHide: true, shell: false })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
    if (code !== 0) throw new Error('local_service_exited_unsuccessfully')
  }
  else if (action === 'app' || action === 'app-check') await startApp(action === 'app-check')
  else if (action === 'personal-app' || action === 'personal-check') await startApp(action === 'personal-check', true)
  else if (action === 'personal-provider-check') await verifyPersonalProvider()
  else if (action === 'personal-learning-check') await verifyPersonalProvider(true)
  else throw new Error('unknown_local_database_command')
} catch (error) {
  // Never print DB errors, subprocess output or credential-bearing connection strings.
  if (error.message?.startsWith('local_app_no_available_port:')) console.error('未找到可用的本机应用端口，已完成有限次数检查。请关闭不需要的开发服务后重试；现有程序未被停止。')
  else if (error.message?.startsWith('local_app_port_probe_failed:')) console.error(['EPERM', 'EACCES'].includes(error.systemCode)
    ? '本机系统拒绝监听应用端口。请检查终端权限或本机安全软件设置后重试；现有程序未被停止。'
    : '本机端口检查失败，请检查系统网络设置后重试；现有程序未被停止。')
  else console.error(error.message?.startsWith('local_') || error.message?.startsWith('required_') || error.message?.startsWith('install_') || error.message?.startsWith('use_') || error.message?.startsWith('unknown_') ? error.message : 'Local database operation failed; credentials and raw database errors withheld.')
  process.exitCode = 1
}
