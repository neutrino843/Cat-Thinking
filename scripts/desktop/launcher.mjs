import { createServer } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, open, rm, stat, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { databaseRuntime, assertOwnedDataDirectory, serviceEnvironment, cleanDesktopEnvironment, readDesktopJson } from './runtime.mjs'
import { safeChild } from './package.mjs'

const defaultProgramRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
export async function assertFixedPorts(ports) {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('desktop_fixed_port_invalid')
    await new Promise((done, reject) => { const server = createPortProbe(); server.once('error', () => reject(new Error(`desktop_fixed_port_occupied:${port}`))); server.listen(port, '127.0.0.1', () => server.close(done)) })
  }
}
export async function stopDesktop(dataRoot) {
  await assertOwnedDataDirectory(dataRoot)
  let lock
  try { lock = await readDesktopJson(join(dataRoot, 'app.lock')) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!Number.isInteger(lock.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(lock.url) || !/^[a-f0-9]{64}$/u.test(lock.token)) throw new Error('desktop_owned_lock_invalid')
  const result = await fetch(`${lock.url}/__desktop__/stop`, { method: 'POST', headers: { 'x-cat-desktop-control': lock.token }, signal: AbortSignal.timeout(5000) })
  if (!result.ok) throw new Error('desktop_stop_owned_instance_failed')
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { await stat(join(dataRoot, 'app.lock')) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('desktop_owned_shutdown_not_completed')
}
export async function startDesktop({ programRoot = defaultProgramRoot, dataRoot, verifyOnly = false, openBrowser = true } = {}) {
  if (!dataRoot || process.platform !== 'win32') throw new Error('desktop_requires_owned_windows_data_directory')
  await assertOwnedDataDirectory(dataRoot)
  const manifest = JSON.parse(await readFile(join(programRoot, 'manifest.json'), 'utf8'))
  if (manifest.application !== 'cat-thinking' || manifest.version !== 1) throw new Error('desktop_program_manifest_invalid')
  let settings
  try { settings = await readDesktopJson(join(dataRoot, 'app.json')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    settings = { version: 1, frontendPort: 53013, servicePort: 53014 }
    await writeFile(join(dataRoot, 'app.json'), JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
  }
  if (settings.version !== 1 || settings.frontendPort === settings.servicePort) throw new Error('desktop_fixed_origin_invalid')
  const ports = { frontendPort: settings.frontendPort, servicePort: settings.servicePort, frontendUrl: `http://127.0.0.1:${settings.frontendPort}`, serviceUrl: `http://127.0.0.1:${settings.servicePort}` }
  await assertFixedPorts([ports.frontendPort, ports.servicePort])
  const token = randomBytes(32).toString('hex')
  const lockPath = join(dataRoot, 'app.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, token, url: ports.frontendUrl, release: manifest.release }))
  await lock.close()
  let runtime, service, server
  let stopping
  let closed = false
  let serviceExit
  const shutdown = () => stopping ??= (async () => {
    closed = true
    const serverClosed = server?.listening ? new Promise((done) => server.close(done)) : Promise.resolve()
    if (service && service.exitCode === null) {
      if (service.connected) service.send({ type: 'cat.analysis.shutdown' }, () => {})
      const timer = setTimeout(() => service.kill(), 15_000)
      await serviceExit
      clearTimeout(timer)
    }
    server?.closeAllConnections()
    await serverClosed
    if (runtime) await runtime.stop()
    const current = await readDesktopJson(lockPath)
    if (current.token === token) await rm(lockPath)
  })()
  const onSignal = () => void shutdown().catch(() => { process.exitCode = 1 })
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  try {
    runtime = await databaseRuntime(programRoot, dataRoot)
    const config = await runtime.setup()
    let pauseOnUpgrade = false
    try { pauseOnUpgrade = (await readDesktopJson(join(dataRoot, 'pause-provider.json'))).pause === true } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (pauseOnUpgrade) {
      const connection = runtime.connect(config)
      try {
        const existing = await connection.query("SELECT to_regclass('public.cat_analysis_personal_state') AS name")
        if (existing.rows[0]?.name) await connection.query('UPDATE cat_analysis_personal_state SET enabled=FALSE,revision=revision+1 WHERE singleton=TRUE AND enabled=TRUE')
      } finally { await connection.end() }
      await rm(join(dataRoot, 'pause-provider.json'))
    }
    service = spawn(join(programRoot, 'runtime/node.exe'), ['services/analysis-service/dist/index.js'], { cwd: programRoot,
      env: serviceEnvironment(config, ports, verifyOnly), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, shell: false })
    serviceExit = new Promise((done) => { service.once('error', () => done(1)); service.once('exit', done) })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (closed || service.exitCode !== null) throw new Error('desktop_service_failed')
      try { ready = (await fetch(`${ports.serviceUrl}/ready`, { signal: AbortSignal.timeout(500) })).ok } catch { /* bounded local readiness */ }
      if (ready) break
      await new Promise((done) => setTimeout(done, 100))
    }
    if (!ready) throw new Error('desktop_service_not_ready')
    const { createBrowserGateway } = await import(pathToFileURL(join(programRoot, 'services/analysis-service/dist/api/browserGateway.js')).href)
    const gateway = createBrowserGateway({ upstream: ports.serviceUrl, token: config.serviceToken, tenantId: 'local-development', origins: [ports.frontendUrl] })
    const dist = await realpath(join(programRoot, 'dist'))
    server = createServer(async (request, response) => {
      try {
        if (request.headers.host !== `127.0.0.1:${ports.frontendPort}`) { response.writeHead(403); response.end(); return }
        if (request.url === '/__desktop__/stop') {
          if (request.method !== 'POST' || request.headers.origin || request.headers['x-cat-desktop-control'] !== token) { response.writeHead(403); response.end(); return }
          response.writeHead(202); response.end(); setImmediate(onSignal); return
        }
        if (request.url?.startsWith('/api/analysis/v1')) { await gateway(request, response); return }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
        const pathname = decodeURIComponent(new URL(request.url ?? '/', ports.frontendUrl).pathname)
        let path = pathname === '/' ? join(dist, 'index.html') : safeChild(dist, pathname.slice(1))
        try { if (!(await stat(path)).isFile()) throw new Error('missing') } catch { if (extname(pathname)) { response.writeHead(404); response.end(); return }; path = join(dist, 'index.html') }
        if (!(await realpath(path)).startsWith(dist + '\\')) throw new Error('desktop_static_path_escape')
        response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': extname(path) === '.html' ? 'no-store' : 'public, max-age=3600' })
        if (request.method === 'HEAD') response.end()
        else createReadStream(path).on('error', () => response.destroy()).pipe(response)
      } catch { if (!response.headersSent) response.writeHead(404); response.end() }
    })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(ports.frontendPort, '127.0.0.1', done) })
    if (verifyOnly) {
      const metadata = await fetch(`${ports.frontendUrl}/api/analysis/v1/personal/settings`, { signal: AbortSignal.timeout(5000) })
      const value = await metadata.json()
      if (!metadata.ok || !value.available || value.acceptsRuns) throw new Error('desktop_isolated_readonly_verification_failed')
      if (!(await fetch(ports.frontendUrl)).ok) throw new Error('desktop_static_frontend_unavailable')
      return { frontendUrl: ports.frontendUrl, release: manifest.release, ready: true, providerReadOnly: true }
    }
    if (openBrowser) {
      const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', ports.frontendUrl], { windowsHide: true, env: cleanDesktopEnvironment(), stdio: 'ignore', shell: false })
      browser.once('error', () => {}); browser.unref()
    }
    await serviceExit
    if (!closed) throw new Error('desktop_service_exited')
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
    await shutdown()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, dataRoot] = process.argv.slice(2)
  const run = action === 'stop' ? stopDesktop(dataRoot) : startDesktop({ dataRoot, verifyOnly: action === 'verify', openBrowser: action !== 'verify' })
  run.then((result) => { if (result) console.log(JSON.stringify(result)) }).catch(() => { console.error('猫思之启动或停止失败：检查数据目录、固定端口或安装完整性；原有密钥与数据不会自动重建。'); process.exitCode = 1 })
}
