import { beforeEach, describe, expect, it } from 'vitest'
import { t, useI18n } from './index'
import { zhCN } from './zh-CN'
import { enUS } from './en-US'

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear()
    useI18n.setState({ lang: 'zh-CN' })
  })

  it('默认语言 zh-CN 返回中文文案', () => {
    expect(t('common.untitled')).toBe('未命名导图')
  })

  it('切换到 en-US 返回英文文案', () => {
    useI18n.getState().setLang('en-US')
    expect(t('common.untitled')).toBe('Untitled')
    expect(t('view.mind')).toBe('Mind')
  })

  it('占位符插值', () => {
    useI18n.getState().setLang('en-US')
    expect(t('file.savedTo', { name: 'a.msz' })).toBe('Saved to a.msz')
    useI18n.getState().setLang('zh-CN')
    expect(t('panel.batchHint', { n: 3 })).toBe('已选中 3 个节点')
  })

  it('缺失 key 原样返回', () => {
    // @ts-expect-error 故意传入不存在的 key
    expect(t('nope.key')).toBe('nope.key')
  })

  it('setLang 持久化到 localStorage', () => {
    useI18n.getState().setLang('en-US')
    expect(localStorage.getItem('msz.lang')).toBe('en-US')
  })

  it('zh-CN 与 en-US 的 key 完全一致（无遗漏）', () => {
    const zhKeys = Object.keys(zhCN).sort()
    const enKeys = Object.keys(enUS).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(40)
  })
})
