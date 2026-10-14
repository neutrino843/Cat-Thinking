import { createServer } from 'node:net'

const validPort = (port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535
const probeError = (port, error) => {
  const systemCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'UNKNOWN'
  return Object.assign(new Error(`local_app_port_probe_failed:${port}:${systemCode}`), { port, systemCode })
}

// Only EADDRINUSE means another listener owns the port. Permission and network
// failures stop selection instead of being disguised as ordinary occupancy.
export const probeLoopbackPort = async (port, serverFactory = createServer) => {
  if (!validPort(port)) throw new Error('local_app_port_configuration_invalid')
  const server = serverFactory()
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(probeError(port, error))
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close((error) => {
      if (error) reject(probeError(port, error))
      else resolve(true)
    }))
  })
}

export const chooseLocalAppPorts = async ({ preferredServicePort = 8787, preferredFrontendPort = 5173,
  candidateCount = 10, probe = probeLoopbackPort } = {}) => {
  if (!validPort(preferredServicePort) || !validPort(preferredFrontendPort)
    || !Number.isSafeInteger(candidateCount) || candidateCount < 1 || candidateCount > 10) {
    throw new Error('local_app_port_configuration_invalid')
  }
  const choose = async (preferred, role, excluded = new Set()) => {
    let examined = 0
    for (let offset = 0; offset < candidateCount && preferred + offset <= 65_535; offset += 1) {
      const port = preferred + offset
      examined += 1
      if (excluded.has(port)) continue
      if (await probe(port)) return port
    }
    throw new Error(`local_app_no_available_port:${role}:${examined}`)
  }
  const servicePort = await choose(preferredServicePort, 'service')
  const frontendPort = await choose(preferredFrontendPort, 'frontend', new Set([servicePort]))
  const serviceUrl = `http://127.0.0.1:${servicePort}`
  const frontendUrl = `http://127.0.0.1:${frontendPort}`
  return Object.freeze({ servicePort, frontendPort, serviceUrl, frontendUrl,
    origins: `http://localhost:${frontendPort},${frontendUrl}` })
}

// A non-owning port probe never stops an existing listener. Personal service
// ownership remains governed by its separate PostgreSQL advisory lock.
export const assertLoopbackPortsAvailable = async (ports = [8787, 5173]) => {
  for (const port of ports) {
    if (!await probeLoopbackPort(port)) throw new Error(`local_app_port_unavailable:${port}`)
  }
}

// Windows terminates Node immediately on child.kill(). An owned IPC channel
// lets the service finish its dispatcher drain before the bounded fallback.
export const stopOwnedService = (child, timeoutMs = 12_000) => new Promise((resolve) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return }
  const finished = () => { clearTimeout(timer); child.removeListener('exit', finished); child.removeListener('error', finished); resolve() }
  const timer = setTimeout(() => { child.kill() }, timeoutMs)
  child.once('exit', finished)
  child.once('error', finished)
  if (child.connected) {
    child.send({ type: 'cat.analysis.shutdown' }, (error) => { if (error) child.kill() })
  } else child.kill()
})
