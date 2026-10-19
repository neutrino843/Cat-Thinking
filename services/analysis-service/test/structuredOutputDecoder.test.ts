import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StructuredOutputDecodeError, decodeStructuredOutput } from '../src/providers/structuredOutputDecoder.js'

const schema = z.object({ title: z.string(), items: z.array(z.number()) })
const decode = (text: string) => decodeStructuredOutput(text, schema, 10_000)

describe('structuredOutputDecoder 语法级容错（C1-a）', () => {
  it('合法 JSON 直接通过，不受容错影响', () => {
    expect(decode('{"title":"a","items":[1,2]}')).toEqual({ title: 'a', items: [1, 2] })
  })

  it('Markdown 代码围栏包装的 JSON 可解码', () => {
    expect(decode('```json\n{"title":"a","items":[1]}\n```')).toEqual({ title: 'a', items: [1] })
    expect(decode('```\n{"title":"a","items":[2]}\n```')).toEqual({ title: 'a', items: [2] })
  })

  it('尾逗号可解码', () => {
    expect(decode('{"title":"a","items":[1,2,],}')).toEqual({ title: 'a', items: [1, 2] })
  })

  it('BOM 与首尾空白可解码', () => {
    expect(decode('\uFEFF  {"title":"a","items":[]}  ')).toEqual({ title: 'a', items: [] })
  })

  it('围栏 + 尾逗号 + BOM 组合可解码', () => {
    expect(decode('\uFEFF```json\n{"title":"a","items":[3,],}\n```')).toEqual({ title: 'a', items: [3] })
  })

  it('字符串内部的逗号与右括号不被误改', () => {
    const text = '{"title":"a,}b]","items":[1]}'
    expect(decode(text)).toEqual({ title: 'a,}b]', items: [1] })
    const broken = '{"title":"keep,","items":[1,]}'
    expect(decode(broken)).toEqual({ title: 'keep,', items: [1] })
  })

  it('转义引号内的逗号括号不被误改', () => {
    const text = '{"title":"say \\",}] ok","items":[1,]}'
    expect(decode(text)).toEqual({ title: 'say ",}] ok', items: [1] })
  })

  it('真正损坏的 JSON 仍然拒绝（invalid_json）', () => {
    expect(() => decode('{"title":"a","items":[1')).toThrow(StructuredOutputDecodeError)
    expect(() => decode('不是 JSON')).toThrow(StructuredOutputDecodeError)
    expect(() => decode('{"title":"a","items":[1]')).toThrow(StructuredOutputDecodeError)
  })

  it('语义校验不被容错削弱：schema_invalid 与 too_large 保持原语义', () => {
    expect(() => decode('{"title":123,"items":[]}')).toThrow(StructuredOutputDecodeError)
    expect(decode('{"title":"a","unknown":true,"items":[]}')).toEqual({ title: 'a', items: [] })
    expect(() => decodeStructuredOutput('{"title":"a","items":[]}', schema, 10)).toThrow(StructuredOutputDecodeError)
    try {
      decodeStructuredOutput('{"title":123,"items":[]}', schema, 10_000)
      expect.unreachable()
    } catch (error) {
      expect((error as StructuredOutputDecodeError).code).toBe('schema_invalid')
    }
    try {
      decodeStructuredOutput('{"title":"a","items":[]}', schema, 10)
      expect.unreachable()
    } catch (error) {
      expect((error as StructuredOutputDecodeError).code).toBe('too_large')
    }
  })

  it('原型污染防护保持有效', () => {
    expect(() => decode('{"__proto__":{},"title":"a","items":[]}')).toThrow(StructuredOutputDecodeError)
  })
})
