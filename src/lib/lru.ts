/**
 * M8-P1（P-4）：固定容量 LRU（最近最少使用）缓存。
 *
 * 背景：measure.ts 的文本宽度缓存旧实现是无界 Map，长会话/大量不同文本会持续增长。
 * 旧版加了容量上限但读命中不刷新新近度（实质是 FIFO）；本实现读/写命中都会把键
 * 提到最新，超容量时淘汰最久未访问项。
 *
 * 约定：V 中不得使用 undefined 作为合法值（undefined 表示未命中）。
 */
export class LRUCache<V> {
  private readonly map = new Map<string, V>()
  private readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('LRUCache capacity 必须为 >= 1 的整数')
    }
    this.capacity = capacity
  }

  get size(): number {
    return this.map.size
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    // 删除后重插：刷新为最近使用
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: string, value: V): void {
    if (this.map.delete(key)) {
      // 已存在：删旧插新即完成刷新
      this.map.set(key, value)
      return
    }
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }

  clear(): void {
    this.map.clear()
  }
}
