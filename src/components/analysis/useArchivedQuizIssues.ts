import { useMemo, useSyncExternalStore } from 'react'
import { liveQuery } from 'dexie'
import { readQuizArchiveIssueIds, type QuizEnvelope } from '../../analysis/quizPractice'

interface ArchivedQuizIssues { ready: boolean; questionIds: string[]; error?: string }
function createIssueStore(artifact: QuizEnvelope, disabled: boolean) {
  let state: ArchivedQuizIssues = { ready: false, questionIds: [] }
  let generation = 0
  const listeners = new Set<() => void>()
  let stop: (() => void) | undefined
  const publish = (next: ArchivedQuizIssues) => { state = next; for (const listener of listeners) listener() }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (!disabled && !stop) {
        const token = ++generation
        const subscription = liveQuery(async () => await readQuizArchiveIssueIds({ docId: artifact.docId, runId: artifact.runId, artifact })).subscribe({
          next: (questionIds) => { if (token === generation) publish({ ready: true, questionIds }) },
          error: () => { if (token === generation) publish({ ready: false, questionIds: [], error: '题目状态暂时无法核对，请恢复查看分析结果。' }) },
        })
        stop = () => subscription.unsubscribe()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { generation++; stop?.(); stop = undefined; state = { ready: false, questionIds: [] } }
      }
    },
  }
}
/** Each immutable artifact/availability pair owns an observer, fencing late results after rebinding. */
export function useArchivedQuizIssues(artifact: QuizEnvelope, disabled: boolean): ArchivedQuizIssues {
  const store = useMemo(() => createIssueStore(artifact, disabled), [artifact, disabled])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
