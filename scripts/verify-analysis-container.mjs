import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('ANALYSIS_') && !name.startsWith('VITE_ANALYSIS') && name !== 'NODE_ENV'))
const execute = (file, args, env = environment, timeoutMs = 600_000) => new Promise((done, reject) => {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
  let output = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error('container_validation_timeout')) }, timeoutMs)
  child.stdout.on('data', (chunk) => { if (output.length < 1_000_000) output += chunk.toString() })
  // Subprocess diagnostics may contain environment details. Do not forward them.
  child.stderr.resume()
  child.once('error', () => { clearTimeout(timer); reject(new Error('container_validation_tool_unavailable')) })
  child.once('exit', (code) => {
    clearTimeout(timer)
    if (code === 0) done(output.trim())
    else reject(new Error('container_validation_command_failed'))
  })
})
const unusedPort = () => new Promise((done, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address()
    listener.close((error) => {
      if (error || !address || typeof address === 'string') reject(new Error('container_validation_port_unavailable'))
      else done(address.port)
    })
  })
})

const nonce = randomBytes(16).toString('hex')
const name = `cat-analysis-validation-${nonce}`
const image = `${name}:local`
let imageBuilt = false
let containerStarted = false
let report
let failed = false
try {
  if (process.argv.length !== 2) throw new Error('container_validation_arguments_invalid')
  const commit = await execute('git', ['rev-parse', 'HEAD'], environment, 10_000)
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('container_validation_commit_invalid')
  const engine = await execute('docker', ['info', '--format', '{{.OSType}}'], environment, 10_000)
  if (engine !== 'linux') throw new Error('container_validation_requires_linux_engine')
  console.log('Validating the pinned service image with Provider disabled and release held.')
  await execute('docker', ['build', '--build-arg', `ANALYSIS_BUILD_COMMIT=${commit}`,
    '--file', 'services/analysis-service/Dockerfile', '--tag', image, '.'])
  imageBuilt = true
  const port = await unusedPort()
  const token = randomBytes(32).toString('base64url')
  await execute('docker', ['run', '--detach', '--name', name, '--publish', `127.0.0.1:${port}:8787`,
    '--env', 'ANALYSIS_AUTH_MODE=service-token', '--env', 'ANALYSIS_SERVICE_TOKEN',
    '--env', 'ANALYSIS_CORS_ORIGINS=https://app.example.test',
    '--env', 'ANALYSIS_PROVIDER_MODE=disabled', '--env', 'ANALYSIS_RELEASE_HOLD=true', image],
  { ...environment, ANALYSIS_SERVICE_TOKEN: token }, 30_000)
  containerStarted = true
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { /* Startup polling is bounded. */ }
    if (ready) break
    await new Promise((done) => setTimeout(done, 250))
  }
  if (!ready) throw new Error('container_validation_startup_failed')
  const headers = { authorization: `Bearer ${token}`, 'x-cat-tenant-id': 'public-synthetic-container', origin: 'https://app.example.test' }
  const response = await fetch(`${base}/api/analysis/v1/capabilities`, { headers, signal: AbortSignal.timeout(5000) })
  const { engineCapabilitiesSchema } = await import('@cat-thinking/analysis-contracts')
  if (!response.ok || engineCapabilitiesSchema.parse(await response.json()).acceptsRuns !== false) throw new Error('container_validation_admission_not_closed')
  const creation = await fetch(`${base}/api/analysis/v1/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
  if (creation.status !== 503) throw new Error('container_validation_creation_not_rejected')
  report = { version: 1, commit, containerReady: true, acceptsRuns: false, createHttpStatus: 503,
    providerCalls: 0, provider: 'disabled', releaseHold: true, ownedResourcesCleaned: true }
} catch {
  failed = true
} finally {
  // Only resources successfully created by this invocation may be removed.
  try {
    if (containerStarted) await execute('docker', ['rm', '--force', name], environment, 30_000)
    if (imageBuilt) await execute('docker', ['image', 'rm', image], environment, 30_000)
  } catch { failed = true }
}
if (failed || !report) {
  console.error('Container validation did not pass; no release evidence was issued. Existing containers and service credentials were not used.')
  process.exitCode = 1
} else console.log(JSON.stringify(report))
