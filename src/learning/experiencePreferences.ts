import { create } from 'zustand'

export const EXPERIENCE_KEY = 'msz.learning.experience.v1'
export const START_CHOICES = { auto: '自动推荐', course: '先选课程', review: '到期复习优先' } as const
export const STUDY_CHOICES = { guided: '逐步学习', practice: '直接练习' } as const
export const COMPANION_CHOICES = { gentle: '轻陪伴', quiet: '仅在呼唤时', beginner: '首次详细引导' } as const
export interface ExperiencePreferences {
  reading: 'paged' | 'continuous'
  catSide: 'left' | 'right'
  motion: boolean
  rewards: boolean
  start: keyof typeof START_CHOICES
  study: keyof typeof STUDY_CHOICES
  companion: keyof typeof COMPANION_CHOICES
}
export const DEFAULT_EXPERIENCE: ExperiencePreferences = { reading: 'paged', catSide: 'right', motion: true, rewards: true, start: 'auto', study: 'guided', companion: 'gentle' }
export function parseExperience(value: unknown): ExperiencePreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_EXPERIENCE }
  const p = value as Partial<ExperiencePreferences>
  return {
    reading: p.reading === 'continuous' ? 'continuous' : 'paged',
    catSide: p.catSide === 'left' ? 'left' : 'right',
    motion: p.motion !== false,
    rewards: p.rewards !== false,
    start: p.start && Object.hasOwn(START_CHOICES, p.start) ? p.start : DEFAULT_EXPERIENCE.start,
    study: p.study && Object.hasOwn(STUDY_CHOICES, p.study) ? p.study : DEFAULT_EXPERIENCE.study,
    companion: p.companion && Object.hasOwn(COMPANION_CHOICES, p.companion) ? p.companion : DEFAULT_EXPERIENCE.companion,
  }
}
function load(): ExperiencePreferences {
  try { return parseExperience(JSON.parse(localStorage.getItem(EXPERIENCE_KEY) ?? 'null')) } catch { return { ...DEFAULT_EXPERIENCE } }
}
export const useExperience = create<{ preferences: ExperiencePreferences; error: string }>(() => ({ preferences: load(), error: '' }))
export function saveExperience(change: Partial<ExperiencePreferences>): void {
  const preferences = parseExperience({ ...useExperience.getState().preferences, ...change })
  let error = ''
  try { localStorage.setItem(EXPERIENCE_KEY, JSON.stringify(preferences)) }
  catch { error = '偏好暂时无法保存到本机，本次选择已生效，刷新后可能恢复之前的设置。' }
  useExperience.setState({ preferences, error })
}
export function refreshExperience(): void { useExperience.setState({ preferences: load(), error: '' }) }
