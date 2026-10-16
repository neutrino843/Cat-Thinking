import { create } from 'zustand'

/** Derived presentation only; saved learning records remain the source of truth. */
export const useAchievementShelf = create<{ resting: boolean }>(() => ({ resting: false }))
