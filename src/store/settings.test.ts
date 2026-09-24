import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * settings 在模块初始化时读取 localStorage，因此每个用例先 resetModules
 * 再动态 import，确保拿到按当前存储初始化的全新 store。
 */
describe('settings 持久化初始化', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  async function loadSettings() {
    return (await import('./settings')).useSettings
  }

  it('F-1：msz.sketch=0 被保留，不被 || 1 吞掉', async () => {
    localStorage.setItem('msz.sketch', '0')
    const useSettings = await loadSettings()
    expect(useSettings.getState().sketch).toBe(0)
  })

  it('msz.sketch=2 保留；脏值回退 1', async () => {
    localStorage.setItem('msz.sketch', '2')
    expect((await loadSettings()).getState().sketch).toBe(2)

    localStorage.setItem('msz.sketch', '9')
    vi.resetModules()
    expect((await loadSettings()).getState().sketch).toBe(1)
  })

  it('未设置 msz.sketch 时默认 1', async () => {
    expect((await loadSettings()).getState().sketch).toBe(1)
  })

  it('F-1 回归：sketch=0 时其他值不受影响（view 默认 mind）', async () => {
    localStorage.setItem('msz.sketch', '0')
    const useSettings = await loadSettings()
    expect(useSettings.getState().view).toBe('mind')
  })
})
