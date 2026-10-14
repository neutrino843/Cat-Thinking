import { describe, expect, it, vi } from 'vitest'
import { importQueue, type ImportTask } from './importQueue'

function textFile(name: string, text = `${name}\n\n正文内容。`): File {
  return new File([text], name, { type: 'text/plain', lastModified: 1_760_000_000_000 })
}

function waitUntil(predicate: () => boolean): Promise<unknown> {
  // 该 vitest 版本的 vi.waitFor 只在回调抛错时重试，返回 false 会被视为成功。
  return vi.waitFor(() => {
    if (!predicate()) throw new Error('condition not met yet')
  }, { timeout: 5_000, interval: 20 })
}

describe('文档导入队列', () => {
  it('多文件按入队顺序串行解析，并发恒为 1', async () => {
    const created: string[] = []
    let maxInFlight = 0
    const unsubscribe = importQueue.subscribe((tasks: readonly ImportTask[]) => {
      maxInFlight = Math.max(maxInFlight, tasks.filter(({ status }) => status === 'parsing').length)
    })
    importQueue.enqueue([textFile('一.txt'), textFile('二.txt'), textFile('三.txt')], {
      onDraft: (draft) => created.push(draft.doc.title),
    })
    await waitUntil(() => created.length === 3)
    unsubscribe()
    expect(created).toEqual(['一.txt', '二.txt', '三.txt'])
    expect(maxInFlight).toBe(1)
  })

  it('单个文件失败不阻塞后续任务，失败原因透传', async () => {
    const failures: string[] = []
    const created: string[] = []
    importQueue.enqueue([textFile('好的.txt'), textFile('empty.txt', '   ')], {
      onDraft: (draft) => created.push(draft.doc.title),
      onFailure: (name) => failures.push(name),
    })
    await waitUntil(() => created.length === 1 && failures.length === 1)
    expect(failures).toEqual(['empty.txt'])
    expect(created).toEqual(['好的.txt'])
  })

  it('cancelQueued 只清掉尚未开始的任务', async () => {
    const created: string[] = []
    importQueue.enqueue([textFile('先开始.txt'), textFile('排队中.txt'), textFile('排队中2.txt')], {
      onDraft: (draft) => created.push(draft.doc.title),
    })
    // enqueue 返回时首个任务已同步进入 parsing，其余仍在排队
    expect(importQueue.snapshot[0].status).toBe('parsing')
    importQueue.cancelQueued()
    expect(importQueue.snapshot.map(({ name }) => name)).toEqual(['先开始.txt'])
    await waitUntil(() => !importQueue.active)
    expect(created).toEqual(['先开始.txt'])
    expect(importQueue.snapshot.every(({ status }) => status === 'done')).toBe(true)
  })
})
