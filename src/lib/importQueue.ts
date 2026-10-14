import { prepareDocumentImport, type DocumentImportDraft } from './documentImport'
import type { ImportProgress } from './documentExtractors'

/**
 * 文档导入串行队列：并发恒为 1，避免多文件同时解析耗尽浏览器内存。
 * 任务按入队顺序逐个解析；单个失败不阻塞后续任务。
 */

export interface ImportTask {
  id: string
  name: string
  status: 'queued' | 'parsing' | 'done' | 'failed'
  progress?: ImportProgress
  error?: string
}

export interface ImportQueueHandlers {
  onDraft: (draft: DocumentImportDraft) => void
  onFailure?: (name: string, message: string) => void
}

type ImportQueueListener = (tasks: readonly ImportTask[]) => void

const tasks: ImportTask[] = []
const filesById = new Map<string, File>()
const listeners = new Set<ImportQueueListener>()
let handlers: ImportQueueHandlers | null = null
let draining = false
let sequence = 0

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${(sequence++).toString(36)}`

function emit(): void {
  const snapshot = tasks.map((task) => ({ ...task }))
  for (const listener of listeners) listener(snapshot)
}

/** 上一批已完成/失败的任务保留到新批次入队前，避免列表无限增长。 */
function pruneFinished(): void {
  for (let index = tasks.length - 1; index >= 0; index--) {
    if (tasks[index].status === 'done' || tasks[index].status === 'failed') {
      filesById.delete(tasks[index].id)
      tasks.splice(index, 1)
    }
  }
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const task = tasks.find(({ status }) => status === 'queued')
      if (!task) break
      task.status = 'parsing'
      emit()
      try {
        const file = filesById.get(task.id)
        if (!file) throw new Error('导入任务缺少文件')
        const draft = await prepareDocumentImport(file, (progress) => {
          task.progress = progress
          emit()
        })
        task.status = 'done'
        task.progress = undefined
        emit()
        filesById.delete(task.id)
        handlers?.onDraft(draft)
      } catch (reason) {
        task.status = 'failed'
        task.error = reason instanceof Error ? reason.message : String(reason)
        emit()
        filesById.delete(task.id)
        handlers?.onFailure?.(task.name, task.error)
      }
    }
  } finally {
    draining = false
  }
}

export const importQueue = {
  /** 入队并开始串行解析；onDraft 逐个回调成功草稿，onFailure 逐个回调失败原因。 */
  enqueue(files: File[], next: ImportQueueHandlers): void {
    handlers = next
    pruneFinished()
    for (const file of files) {
      const id = uid()
      filesById.set(id, file)
      tasks.push({ id, name: file.name, status: 'queued' })
    }
    emit()
    void drain()
  },

  subscribe(listener: ImportQueueListener): () => void {
    listeners.add(listener)
    listener(tasks.map((task) => ({ ...task })))
    return () => listeners.delete(listener)
  },

  /** 清空尚未开始的排队任务；进行中的任务不受影响。 */
  cancelQueued(): void {
    for (let index = tasks.length - 1; index >= 0; index--) {
      if (tasks[index].status === 'queued') {
        filesById.delete(tasks[index].id)
        tasks.splice(index, 1)
      }
    }
    emit()
  },

  get active(): boolean {
    return tasks.some(({ status }) => status === 'queued' || status === 'parsing')
  },

  get snapshot(): readonly ImportTask[] {
    return tasks.map((task) => ({ ...task }))
  },
}
