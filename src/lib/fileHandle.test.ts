import { afterEach, describe, expect, it } from 'vitest'
import { isFileHandleSupported } from './fileHandle'

/**
 * fileHandle 的文件读写流程依赖浏览器 File System Access API + IndexedDB，
 * 主体由 E2E（e2e/msz-file.spec.ts，注入 mock picker/handle）覆盖；
 * 这里单测能力检测这一纯逻辑分支（支持 / 不支持的判定）。
 */
describe('isFileHandleSupported', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker
  })

  it('两个 picker 均为函数才判定支持', () => {
    expect(isFileHandleSupported()).toBe(false)

    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = () => {}
    expect(isFileHandleSupported()).toBe(false)

    ;(window as unknown as Record<string, unknown>).showOpenFilePicker = () => {}
    expect(isFileHandleSupported()).toBe(true)
  })

  it('非函数值（某些浏览器残留属性）不判定为支持', () => {
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = true
    ;(window as unknown as Record<string, unknown>).showOpenFilePicker = 'yes'
    expect(isFileHandleSupported()).toBe(false)
  })
})
