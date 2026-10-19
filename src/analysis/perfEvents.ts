/**
 * C3 分析性能埋点：客户端分段计时事件（解析/创建/上传/运行终态），落 localStorage 事件表。
 * 细分调用与修复时长以服务端 invocation 表（startedAt/completedAt）为准，前端不重复存储。
 * 可开关：msz.analysis.perf.enabled（默认开，'off' 关闭）；写入经缓冲异步落盘，不阻塞交互。
 */
const STORAGE_KEY = 'msz.analysis.perf.v1'
const ENABLE_KEY = 'msz.analysis.perf.enabled'
const MAX_EVENTS = 60

export type AnalysisPerfStage = 'doc-parse' | 'analysis-create' | 'analysis-upload' | 'run-complete' | 'panel-open'

export interface AnalysisPerfEvent {
  stage: AnalysisPerfStage
  ms: number
  at: number
  runId?: string
  kind?: string
  bytes?: number
  chars?: number
  parts?: number
  repairCount?: number
}

export function analysisPerfEnabled(): boolean {
  try { return localStorage.getItem(ENABLE_KEY) !== 'off' } catch { return false }
}

export function setAnalysisPerfEnabled(enabled: boolean): void {
  try { localStorage.setItem(ENABLE_KEY, enabled ? 'on' : 'off') } catch { /* storage blocked */ }
}

export function readAnalysisPerfEvents(): AnalysisPerfEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed as AnalysisPerfEvent[] : []
  } catch { return [] }
}

let pending: AnalysisPerfEvent[] = []
let flushScheduled = false

function flushPending(): void {
  flushScheduled = false
  if (!pending.length) return
  const all = [...readAnalysisPerfEvents(), ...pending].slice(-MAX_EVENTS)
  pending = []
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch { /* quota or blocked */ }
}

export function recordAnalysisPerf(event: Omit<AnalysisPerfEvent, 'at'>): void {
  if (!analysisPerfEnabled()) return
  pending.push({ ...event, at: Date.now() })
  if (!flushScheduled) {
    flushScheduled = true
    setTimeout(flushPending, 0)
  }
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const startedAt = performance.now()
  const result = await fn()
  return { result, ms: Math.round(performance.now() - startedAt) }
}
