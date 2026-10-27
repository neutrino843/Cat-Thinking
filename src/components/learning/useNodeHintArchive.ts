import { useEffect, useRef, useState } from 'react'
import type { ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { persistNodeHintResult } from '../../learning/nodeHintResults'
import type { NodeSupport } from '../../learning/nodeTypes'

/** Persist finished results locally without revealing them or starting another model call. */
export function useNodeHintArchive(courseId: string, support: NodeSupport, runId: string | undefined, artifacts: ArtifactEnvelopeV1[]) {
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const pending = useRef<Promise<void>>()
  useEffect(() => {
    if (support.archiveId || support.restored || !runId || !artifacts.length) return
    let live = true
    const work = pending.current ?? persistNodeHintResult(courseId, support, runId, artifacts)
    pending.current = work
    void work.then(() => { if (live) setError('') }, (err: unknown) => {
      if (live) setError(`结果尚未完整保存在本机：${err instanceof Error ? err.message : '本地保存失败'}。请重试保存后再备份。`)
    }).finally(() => { if (pending.current === work) pending.current = undefined })
    return () => { live = false }
  }, [courseId, support, runId, artifacts, retry])
  return { error, retry: () => { setError(''); setRetry((value) => value + 1) } }
}
