import { describe, expect, it } from 'vitest'
import { parseImported } from './exporters'
import { simpleFixture } from '../test/fixture'

describe('导入校验 parseImported', () => {
  it('合法 JSON 文档可解析并补齐版本号', () => {
    const d = parseImported(JSON.stringify(simpleFixture()))
    expect(d.version).toBe(1)
    expect(d.nodes[d.rootId]).toBeDefined()
  })

  it('非法结构抛错', () => {
    expect(() => parseImported('{"foo":1}')).toThrow(/猫思之/)
    expect(() => parseImported('not json')).toThrow()
    expect(() => parseImported(JSON.stringify({ version: 1, rootId: 'x', nodes: {} }))).toThrow()
  })
})
