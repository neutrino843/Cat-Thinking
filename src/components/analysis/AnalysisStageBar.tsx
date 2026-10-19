import { useEffect, useState } from 'react'

const STAGES = [
  { key: 'receiving', label: '上传原文', estimate: '几秒', slowAfter: 20 },
  { key: 'queued', label: '排队中', estimate: '几秒', slowAfter: 20 },
  { key: 'planning', label: '规划分析', estimate: '几秒', slowAfter: 20 },
  { key: 'mapping', label: '提取证据', estimate: '10-20秒', slowAfter: 45 },
  { key: 'merging', label: '合并证据', estimate: '几秒', slowAfter: 20 },
  { key: 'generating', label: '生成结果', estimate: '15-30秒', slowAfter: 60 },
  { key: 'validating', label: '校验结果', estimate: '几秒', slowAfter: 20 },
] as const

const STORAGE_KEY = 'msz.analysis.history.v1'
const MAX_HISTORY = 20

interface AnalysisHistoryEntry {
  charCount: number
  kinds: string[]
  totalMs: number
  at: number
}

function loadHistory(): AnalysisHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is AnalysisHistoryEntry =>
      typeof entry?.charCount === 'number' && typeof entry?.totalMs === 'number' && typeof entry?.at === 'number')
  } catch { return [] }
}

function saveHistory(entry: AnalysisHistoryEntry): void {
  try {
    const history = loadHistory()
    history.push(entry)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)))
  } catch { /* storage full or blocked */ }
}

function bucket(charCount: number): string {
  if (charCount < 5000) return '0-5k'
  if (charCount < 20000) return '5k-20k'
  return '20k-100k'
}

function estimateFromHistory(charCount: number, kinds: string[]): number | null {
  const history = loadHistory()
  const sameBucket = history.filter((entry) => bucket(entry.charCount) === bucket(charCount) && entry.kinds.join(',') === kinds.join(','))
  if (sameBucket.length < 3) return null
  const sorted = sameBucket.map((entry) => entry.totalMs).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '不到1秒'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}分${rest}秒` : `${minutes}分钟`
}

interface AnalysisStageBarProps {
  status: string
  progress: number
  charCount?: number
  kinds?: string[]
  startedAt?: number
  onComplete?: (totalMs: number) => void
}

/** AI 分析阶段步骤条 + 预计剩余时间 */
export default function AnalysisStageBar({ status, progress, charCount = 0, kinds = [], startedAt, onComplete }: AnalysisStageBarProps) {
  const [elapsed, setElapsed] = useState(0)
  const currentIndex = STAGES.findIndex((stage) => stage.key === status)
  const activeIndex = currentIndex === -1 ? (status === 'succeeded' || status === 'partial' ? STAGES.length : 0) : currentIndex

  useEffect(() => {
    if (!startedAt) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  useEffect(() => {
    if ((status === 'succeeded' || status === 'partial') && startedAt && onComplete) {
      onComplete(Date.now() - startedAt)
    }
  }, [status, startedAt, onComplete])

  const estimated = charCount > 0 && kinds.length > 0 ? estimateFromHistory(charCount, kinds) : null
  const showEstimate = estimated !== null && status !== 'succeeded' && status !== 'partial'
  const currentStage = STAGES[activeIndex]
  const running = status !== 'succeeded' && status !== 'partial'
  const slow = running && currentStage !== undefined && elapsed > currentStage.slowAfter * 1000

  return (
    <div className="analysis-stage-bar" aria-label="分析阶段进度">
      <div className="analysis-stage-steps">
        {STAGES.map((stage, index) => {
          const done = index < activeIndex
          const current = index === activeIndex
          return (
            <div key={stage.key} className={`analysis-stage-step ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
              <span className="analysis-stage-dot">{done ? '✓' : index + 1}</span>
              <span className="analysis-stage-label">{stage.label}</span>
              {current && running && (
                <span className="analysis-stage-estimate">{slow ? '比预期久' : stage.estimate}</span>
              )}
            </div>
          )
        })}
      </div>
      <div className="analysis-stage-info">
        <progress max={1} value={progress} aria-label="分析进度" />
        <div className="analysis-stage-meta">
          {startedAt && running && (
            <span>已进行 {formatDuration(elapsed)}</span>
          )}
          {showEstimate && (
            <span>预计约 {formatDuration(estimated)}</span>
          )}
          {estimated === null && charCount > 0 && running && (
            <span>首次分析该长度内容，时间可能稍长</span>
          )}
        </div>
        {slow && (
          <p className="analysis-stage-slow" role="status">
            等待比预期久：模型服务尚未返回响应。你可以继续等待，或取消后重新生成。
          </p>
        )}
      </div>
    </div>
  )
}

/** 记录一次完成的分析到历史 */
export function recordAnalysisComplete(charCount: number, kinds: string[], totalMs: number): void {
  saveHistory({ charCount, kinds, totalMs, at: Date.now() })
}
