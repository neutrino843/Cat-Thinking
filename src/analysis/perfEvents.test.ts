import { beforeEach, describe, expect, it } from 'vitest'
import { analysisPerfEnabled, readAnalysisPerfEvents, recordAnalysisPerf, setAnalysisPerfEnabled } from './perfEvents'

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('analysisPerfEvents（C3 埋点）', () => {
  beforeEach(() => {
    localStorage.removeItem('msz.analysis.perf.v1')
    localStorage.removeItem('msz.analysis.perf.enabled')
  })

  it('默认开启，记录后异步落盘可读回', async () => {
    expect(analysisPerfEnabled()).toBe(true)
    recordAnalysisPerf({ stage: 'doc-parse', ms: 120, kind: 'docx', bytes: 2048 })
    expect(readAnalysisPerfEvents()).toEqual([])
    await flushAsync()
    expect(readAnalysisPerfEvents()).toEqual([
      { stage: 'doc-parse', ms: 120, kind: 'docx', bytes: 2048, at: expect.any(Number) },
    ])
  })

  it('开关关闭后不记录，重新开启恢复', async () => {
    setAnalysisPerfEnabled(false)
    expect(analysisPerfEnabled()).toBe(false)
    recordAnalysisPerf({ stage: 'analysis-create', ms: 300, runId: 'run-1', chars: 1000 })
    await flushAsync()
    expect(readAnalysisPerfEvents()).toEqual([])
    setAnalysisPerfEnabled(true)
    recordAnalysisPerf({ stage: 'run-complete', ms: 51000, runId: 'run-1', repairCount: 1 })
    await flushAsync()
    expect(readAnalysisPerfEvents()).toHaveLength(1)
  })

  it('事件表上限 60 条，保留最新', async () => {
    for (let index = 0; index < 65; index += 1) {
      recordAnalysisPerf({ stage: 'run-complete', ms: index, runId: `run-${index}` })
    }
    await flushAsync()
    const events = readAnalysisPerfEvents()
    expect(events).toHaveLength(60)
    expect(events[0]?.runId).toBe('run-5')
    expect(events[59]?.runId).toBe('run-64')
  })

  it('损坏的事件表数据容错为空数组', () => {
    localStorage.setItem('msz.analysis.perf.v1', 'not-json')
    expect(readAnalysisPerfEvents()).toEqual([])
    localStorage.setItem('msz.analysis.perf.v1', '{"oops":1}')
    expect(readAnalysisPerfEvents()).toEqual([])
  })
})
