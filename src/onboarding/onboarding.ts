import { create } from 'zustand'

/** 新手任务清单 v2：五项新手任务的状态管理 */
export const ONBOARDING_KEY = 'msz.onboarding.v2'
export const ONBOARDING_ITEMS = [
  { id: 'import', name: '导入资料', description: '带一份自己的讲义或笔记' },
  { id: 'first-question', name: '做第一题', description: '用原文完成一道填空题' },
  { id: 'ai-analysis', name: 'AI 分析', description: '生成知识结构与测验' },
  { id: 'save-practice', name: '存课练习', description: '把分析结果保存到课程并开始练习' },
  { id: 'return-tomorrow', name: '明天继续', description: '今天完成，明天回来复习' },
] as const
export type OnboardingItemId = typeof ONBOARDING_ITEMS[number]['id']

export interface OnboardingProgress {
  version: 2
  items: Record<OnboardingItemId, { done: boolean; doneAt?: number }>
  currentItem: OnboardingItemId
  expanded: boolean
  updatedAt: number
}

const fresh = (): OnboardingProgress => ({
  version: 2,
  items: { import: { done: false }, 'first-question': { done: false }, 'ai-analysis': { done: false }, 'save-practice': { done: false }, 'return-tomorrow': { done: false } },
  currentItem: 'import',
  expanded: false,
  updatedAt: Date.now(),
})

const validIds = new Set(ONBOARDING_ITEMS.map((item) => item.id))

function parse(value: unknown): OnboardingProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fresh()
  const v = value as Record<string, unknown>
  if (v.version !== 2 || typeof v.currentItem !== 'string' || !validIds.has(v.currentItem as OnboardingItemId)) return fresh()
  const items = fresh().items
  const source = v.items as Record<string, unknown> | undefined
  if (source) for (const id of validIds) {
    const entry = source[id] as Record<string, unknown> | undefined
    if (entry && typeof entry.done === 'boolean') items[id as OnboardingItemId] = { done: entry.done, ...(entry.doneAt ? { doneAt: Number(entry.doneAt) } : {}) }
  }
  return { version: 2, items, currentItem: v.currentItem as OnboardingItemId, expanded: !!v.expanded, updatedAt: Number(v.updatedAt) || Date.now() }
}

function load(): OnboardingProgress {
  try { const raw = localStorage.getItem(ONBOARDING_KEY); return raw ? parse(JSON.parse(raw)) : fresh() } catch { return fresh() }
}

export const useOnboarding = create<{ progress: OnboardingProgress }>(() => ({ progress: load() }))

function commit(progress: OnboardingProgress): void {
  try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(progress)) } catch { /* storage full or blocked */ }
  useOnboarding.setState({ progress })
}

export function onboardingDone(id: OnboardingItemId): void {
  const p = useOnboarding.getState().progress
  if (p.items[id].done) return
  const items = { ...p.items, [id]: { done: true, doneAt: Date.now() } }
  const next = ONBOARDING_ITEMS.find((item) => !items[item.id].done)
  commit({ ...p, items, currentItem: next?.id ?? 'return-tomorrow', updatedAt: Date.now() })
}

export function onboardingSetExpanded(expanded: boolean): void {
  const p = useOnboarding.getState().progress
  commit({ ...p, expanded, updatedAt: Date.now() })
}

export function onboardingReset(): void {
  commit(fresh())
}

/** 从旧版 guide v1 迁移到 v2 */
export function migrateFromGuideV1(guideStatus: string, guideStep: string): void {
  const p = useOnboarding.getState().progress
  if (p.items.import.done) return // already migrated or fresh
  const items = { ...p.items }
  if (guideStatus === 'completed') {
    items.import = { done: true }
    items['first-question'] = { done: true }
    commit({ ...p, items, currentItem: 'ai-analysis', updatedAt: Date.now() })
  } else if (['active', 'paused'].includes(guideStatus)) {
    if (['read', 'question'].includes(guideStep)) {
      items.import = { done: true }
      commit({ ...p, items, currentItem: 'first-question', updatedAt: Date.now() })
    } else {
      commit({ ...p, currentItem: 'import', updatedAt: Date.now() })
    }
  }
}
