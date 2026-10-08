import { describe, expect, it } from 'vitest'
import { LRUCache } from './lru'

describe('LRUCache', () => {
  it('set/get 基本读写，未命中返回 undefined', () => {
    const c = new LRUCache<number>(2)
    expect(c.get('a')).toBeUndefined()
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    expect(c.size).toBe(1)
    expect(c.has('a')).toBe(true)
  })

  it('容量超限时淘汰最久未使用项', () => {
    const c = new LRUCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3) // a 最旧 → 淘汰
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })

  it('get 命中刷新新近度：被读过的键不被淘汰', () => {
    const c = new LRUCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('a')).toBe(1) // 读 a → b 成为最旧
    c.set('c', 3)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('set 已存在键时刷新新近度并更新值', () => {
    const c = new LRUCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 10) // a 提为最新
    c.set('c', 3) // b 淘汰
    expect(c.get('a')).toBe(10)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('容量为 1 的边界：永远只留最新键', () => {
    const c = new LRUCache<number>(1)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.size).toBe(1)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    c.get('b')
    c.set('a', 3)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(3)
  })

  it('clear 清空；非法容量抛错', () => {
    const c = new LRUCache<number>(2)
    c.set('a', 1)
    c.clear()
    expect(c.size).toBe(0)
    expect(() => new LRUCache<number>(0)).toThrow()
    expect(() => new LRUCache<number>(1.5)).toThrow()
  })
})
