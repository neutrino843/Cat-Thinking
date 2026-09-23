import type { DocData } from '../types'
import { LAST_KEY, saveDoc } from './db'

let timer: ReturnType<typeof setTimeout> | undefined
let pending: DocData | null = null

/** 变更后 ≤1s 防抖落盘（PRD §4.3 自动保存） */
export function schedulePersist(doc: DocData) {
  pending = doc
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 700)
}

export function flush() {
  if (!pending) return
  const doc = pending
  pending = null
  saveDoc(doc).catch((e) => console.error('[猫思之] 保存失败', e))
  try {
    localStorage.setItem(LAST_KEY, doc.id)
  } catch {
    /* ignore */
  }
}

window.addEventListener('beforeunload', flush)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush()
})
