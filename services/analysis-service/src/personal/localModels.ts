import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, readdir, statfs, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const LOCAL_MODELS = ['qwen3:4b', 'qwen3:8b'] as const
export interface LocalModelState { running: boolean; models: string[]; download: { state: 'idle' | 'downloading' | 'ready' | 'failed'; model?: string; completed: number; total: number }; message?: string }
const ROOT = 'http://127.0.0.1:11434'
/** One download per application backend. No arbitrary process arguments or remote endpoints. */
export class LocalModelManager {
  private download: LocalModelState['download'] = { state: 'idle', completed: 0, total: 0 }
  private controller?: AbortController
  private starting = false
  private ownedEngine?: ChildProcess
  private readonly settingsPath: string
  private async modelDirectory(): Promise<string> {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, 'utf8')) as { directory?: string }
      if (settings.directory && isAbsolute(settings.directory)) return settings.directory
      throw new Error('local_storage_settings_invalid')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('local_storage_settings_unreadable', { cause: error }) }
    return join(homedir(), '.ollama', 'models')
  }
  async storage(directory?: string) {
    const configured = await this.modelDirectory()
    if (directory && !isAbsolute(directory)) throw new Error('local_storage_path_invalid')
    const target = resolve(directory ?? configured)
    if (!isAbsolute(target) || (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(target))) throw new Error('local_storage_path_invalid')
    let existing = target
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
    const stats = await statfs(existing)
    const folders = (await readdir(existing, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .slice(0, 200).map((item) => ({ name: item.name, path: join(existing, item.name) }))
    const drives = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map((letter) => `${letter}:\\`).filter(existsSync) : ['/']
    return { directory: target, browsing: existing, parent: dirname(existing), configured, folders, drives,
      freeBytes: stats.bavail * stats.bsize, canChange: !this.ownedEngine && !(await this.status()).running,
      externalEngine: !this.ownedEngine && (await this.status()).running }
  }
  async configureStorage(directory: string) {
    if (this.download.state === 'downloading' || (await this.status()).running) throw new Error('local_storage_engine_running')
    const info = await this.storage(directory)
    await mkdir(info.directory, { recursive: true })
    const probe = join(info.directory, `.cat-thinking-write-check-${randomUUID()}`)
    try { await writeFile(probe, '', { flag: 'wx' }) } finally { await unlink(probe).catch(() => {}) }
    await mkdir(dirname(this.settingsPath), { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify({ version: 1, directory: info.directory }), { mode: 0o600 })
    return this.storage()
  }
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), settingsPath?: string) {
    this.settingsPath = settingsPath ?? process.env.CAT_THINKING_MODEL_SETTINGS ?? join(homedir(), '.cat-thinking', 'local-models.json')
  }
  async status(): Promise<LocalModelState> {
    try {
      const response = await this.fetcher(`${ROOT}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error()
      const text = await response.text()
      if (text.length > 262144) throw new Error()
      const body = JSON.parse(text) as { models?: { name?: string }[] }
      return { running: true, models: (body.models ?? []).flatMap((item) => typeof item.name === 'string' ? [item.name] : []), download: { ...this.download } }
    } catch { return { running: false, models: [], download: { ...this.download }, message: '本地模型引擎未启动；若尚未安装，请先安装 Ollama。' } }
  }
  async start(): Promise<LocalModelState> {
    if ((await this.status()).running || this.starting) return this.status()
    this.starting = true
    try {
      const installed = process.platform === 'win32' && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : undefined
      const bundled = fileURLToPath(new URL('../../../../runtime/ollama/ollama.exe', import.meta.url))
      const executable = existsSync(bundled) ? bundled : installed && existsSync(installed) ? installed : 'ollama'
      const modelDirectory = await this.modelDirectory()
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ['serve'], { shell: false, windowsHide: true, detached: true, stdio: 'ignore',
          env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1', OLLAMA_MODELS: modelDirectory,
            OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_MAX_LOADED_MODELS: '1' } })
        child.once('error', reject)
        child.once('spawn', () => { this.ownedEngine = child; child.unref(); resolve() })
        child.once('exit', () => { if (this.ownedEngine === child) this.ownedEngine = undefined })
      })
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await this.status()
        if (state.running) return state
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return this.status()
    } catch { return { ...await this.status(), message: '未能启动 Ollama。请安装后重试，或检查本机 11434 端口。' } }
    finally { this.starting = false }
  }
  pull(model: string): LocalModelState['download'] {
    if (!LOCAL_MODELS.includes(model as typeof LOCAL_MODELS[number])) throw new Error('unsupported local model')
    if (this.download.state === 'downloading') return { ...this.download }
    this.download = { state: 'downloading', model, completed: 0, total: 0 }
    this.controller = new AbortController()
    void this.consume(model, this.controller.signal)
    return { ...this.download }
  }
  cancel(): void { this.controller?.abort() }
  async stop() {
    if (!this.ownedEngine) return this.status()
    this.cancel()
    const child = this.ownedEngine
    await new Promise<void>((done) => { child.once('exit', () => done()); child.kill() })
    return this.status()
  }
  close(): void { this.cancel(); this.ownedEngine?.kill(); this.ownedEngine = undefined }
  private async consume(model: string, signal: AbortSignal): Promise<void> {
    const timer = setTimeout(() => this.controller?.abort(), 2 * 60 * 60 * 1000)
    try {
      const response = await this.fetcher(`${ROOT}/api/pull`, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) })
      if (!response.ok || !response.body) throw new Error()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let succeeded = false
      const line = (value: string) => {
        if (!value.trim()) return
        const item = JSON.parse(value) as { status?: string; error?: string; completed?: number; total?: number }
        if (item.error) throw new Error()
        if (typeof item.total === 'number' && Number.isFinite(item.total) && item.total > 0) {
          this.download.total = item.total
          this.download.completed = Math.max(0, Math.min(Number.isFinite(item.completed) ? item.completed ?? 0 : 0, item.total))
        }
        if (item.status === 'success') succeeded = true
      }
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          const lines = pending.split('\n'); pending = lines.pop() ?? ''
          if (pending.length > 16384 || lines.some((value) => value.length > 16384)) throw new Error()
          lines.forEach(line)
        }
        pending += decoder.decode(); line(pending)
        if (!succeeded || signal.aborted) throw new Error()
        this.download.state = 'ready'
      } finally { await reader.cancel(); reader.releaseLock() }
    } catch { this.download.state = 'failed' }
    finally { clearTimeout(timer); this.controller = undefined }
  }
}
