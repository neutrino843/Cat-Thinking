// @vitest-environment node
import { createConnection, createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { assertLoopbackPortsAvailable, chooseLocalAppPorts, probeLoopbackPort, stopOwnedService } = await import(pathToFileURL(resolve('scripts/local-app-lifecycle.mjs')).href)

describe('local application lifecycle', () => {
  it('chooses a frontend fallback while the occupied owner remains functional', async () => {
    const listener = createServer((socket) => socket.end('unrelated-owner-preserved'))
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    try {
      const ports = await chooseLocalAppPorts({ preferredServicePort: address.port, preferredFrontendPort: address.port })
      expect(ports.frontendPort).not.toBe(address.port)
      expect(ports.servicePort).not.toBe(address.port)
      expect(ports.frontendPort).not.toBe(ports.servicePort)
      expect(ports.serviceUrl).toBe(`http://127.0.0.1:${ports.servicePort}`)
      expect(ports.frontendUrl).toBe(`http://127.0.0.1:${ports.frontendPort}`)
      expect(ports.origins).toBe(`http://localhost:${ports.frontendPort},${ports.frontendUrl}`)
      expect(listener.listening).toBe(true)
      const response = await new Promise<string>((done, reject) => {
        const client = createConnection({ host: '127.0.0.1', port: address.port })
        client.once('data', (bytes) => { client.destroy(); done(bytes.toString()) })
        client.once('error', reject)
      })
      expect(response).toBe('unrelated-owner-preserved')
    } finally { await new Promise<void>((done) => listener.close(() => done())) }
  })
  it('reports exhausted bounded candidates without closing an occupied listener', async () => {
    const listener = createServer()
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    try {
      await expect(chooseLocalAppPorts({ preferredServicePort: address.port, candidateCount: 1 }))
        .rejects.toThrow('local_app_no_available_port:service:1')
      expect(listener.listening).toBe(true)
    } finally { await new Promise<void>((done) => listener.close(() => done())) }
  })
  it('preserves permission failures as distinct errors and does not scan around them', async () => {
    const denied = new EventEmitter() as EventEmitter & { listen: () => void }
    denied.listen = () => { queueMicrotask(() => denied.emit('error', Object.assign(new Error('private OS text'), { code: 'EPERM' }))) }
    const failure = probeLoopbackPort(8787, () => denied)
    await expect(failure).rejects.toMatchObject({ systemCode: 'EPERM', port: 8787 })
    const probe = vi.fn(() => failure)
    await expect(chooseLocalAppPorts({ probe })).rejects.toThrow('local_app_port_probe_failed:8787:EPERM')
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('prefers available defaults and rejects unbounded or invalid port selection', async () => {
    const probe = vi.fn(async () => true)
    expect(await chooseLocalAppPorts({ probe })).toMatchObject({ servicePort: 8787, frontendPort: 5173 })
    await expect(chooseLocalAppPorts({ candidateCount: 11, probe })).rejects.toThrow('local_app_port_configuration_invalid')
    await expect(chooseLocalAppPorts({ preferredServicePort: 0, probe })).rejects.toThrow('local_app_port_configuration_invalid')
  })
  it('refuses occupied ports without stopping their owner, and allows a released port', async () => {
    const listener = createServer()
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    try {
      await expect(assertLoopbackPortsAvailable([address.port])).rejects.toThrow(`local_app_port_unavailable:${address.port}`)
      expect(listener.listening).toBe(true)
    } finally { await new Promise<void>((done) => listener.close(() => done())) }
    await expect(assertLoopbackPortsAvailable([address.port])).resolves.toBeUndefined()
  })

  it('gives its service time to drain and disconnect using only its parent IPC channel', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('message', message => { if (message.type === 'cat.analysis.shutdown') setTimeout(() => { process.send({ drained: true }); process.disconnect(); }, 30) }); process.send({ ready: true });"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    let drained = false
    child.on('message', (message: unknown) => { if ((message as { drained?: boolean }).drained) drained = true })
    try {
      await new Promise<void>((done, reject) => { child.once('message', () => done()); child.once('error', reject) })
      await stopOwnedService(child, 2000)
      expect(drained).toBe(true)
      expect(child.exitCode).toBe(0)
      await expect(stopOwnedService(child, 2000)).resolves.toBeUndefined()
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
  })

  it('bounds shutdown time when its own child ignores the drain request', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('message', () => {}); process.send({ ready: true }); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    try {
      await new Promise<void>((done, reject) => { child.once('message', () => done()); child.once('error', reject) })
      await stopOwnedService(child, 30)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
  })
})
