import { describe, expect, it, vi } from 'vitest'
import { LocalModelManager } from '../src/personal/localModels.js'
import { localChat, configuredChat } from '../src/personal/localChat.js'
import { personalFixtureSettings } from './fixtures/personalProviderFixture.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('local model lifecycle and privacy', () => {
  it('sends an explicit cloud question to the configured MoMA endpoint without claiming it is local', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '依据不足，需要核对原文。' } }] })))
    const result = await configuredChat({ ...personalFixtureSettings(), providerId: 'mobilecloud', baseUrl: 'https://zhenze-huhehaote.cmecloud.cn/v1', modelId: 'deepseek-v4-flash-0731', networkMode: 'public' }, { question: '能确定吗', context: '公开原文' }, fetcher)
    expect(result).toMatchObject({ local: false, model: 'deepseek-v4-flash-0731' })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://zhenze-huhehaote.cmecloud.cn/v1/chat/completions')
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.messages[1].content).toContain('公开原文')
    expect(body).not.toHaveProperty('reasoning_effort')
    await expect(configuredChat({ ...personalFixtureSettings(), networkMode: 'public', apiKey: undefined }, { question: '解释', context: '' }, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('persists an explicitly chosen directory across restart, shows disk space, and refuses relative paths or changing a running engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-model-storage-'))
    try {
      const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error())
      const config = join(root, 'config.json')
      const folder = join(root, 'models')
      const manager = new LocalModelManager(offline, config)
      await expect(manager.storage('../relative')).rejects.toThrow('path_invalid')
      expect(await manager.configureStorage(folder)).toMatchObject({ directory: folder, configured: folder })
      const restarted = new LocalModelManager(offline, config)
      const info = await restarted.storage()
      expect(info.directory).toBe(folder)
      expect(info.freeBytes).toBeGreaterThan(0)
      const running = new LocalModelManager(vi.fn<typeof fetch>().mockResolvedValue(new Response('{"models":[]}')), config)
      await expect(running.configureStorage(join(root, 'other'))).rejects.toThrow('engine_running')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('reads inventory only from the fixed loopback address and reports unavailable engine', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'qwen3:4b' }] })))
    const manager = new LocalModelManager(fetcher)
    expect(await manager.status()).toMatchObject({ running: true, models: ['qwen3:4b'] })
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:11434/api/tags')
    fetcher.mockRejectedValue(new Error('private upstream details'))
    expect(await manager.status()).toMatchObject({ running: false })
  })
  it('limits downloads to explicit models and requires terminal success rather than partial progress', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"total":100,"completed":50}\n'))
    const manager = new LocalModelManager(fetcher)
    expect(() => manager.pull('remote/cloud-model')).toThrow()
    expect(manager.pull('qwen3:4b').state).toBe('downloading')
    await vi.waitFor(async () => expect((await manager.status()).download.state).toBe('failed'))
    fetcher.mockResolvedValue(new Response('{"total":100,"completed":100}\n{"status":"success"}\n'))
    manager.pull('qwen3:4b')
    await vi.waitFor(async () => expect((await manager.status()).download.state).toBe('ready'))
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/api/pull') && init?.body === '{"model":"qwen3:4b","stream":true}')).toBe(true)
  })
  it('never falls back to public/cloud endpoints and marks truncated responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '回答部分' } }] })))
    await expect(localChat({ ...personalFixtureSettings(), networkMode: 'public' }, { question: '解释', context: '' }, fetcher)).rejects.toThrow()
    await expect(localChat({ ...personalFixtureSettings(), modelId: 'qwen:cloud' }, { question: '解释', context: '' }, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    const result = await localChat(personalFixtureSettings(), { question: '解释', context: '原文' }, fetcher)
    expect(result.local).toBe(true)
    expect(result.answer).toContain('尚不完整')
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:9876/v1/chat/completions')
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string)
    expect(body.messages[1].content).toContain('原文')
  })
})
