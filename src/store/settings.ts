import { create } from 'zustand'
import type { GanttScale } from '../lib/gantt'

export type SketchLevel = 0 | 1 | 2
export type ViewKind = 'mind' | 'gantt'

interface SettingsState {
  dark: boolean
  sketch: SketchLevel
  view: ViewKind
  ganttScale: GanttScale
  sidebar: boolean
  outline: boolean
  paletteOpen: boolean
  /** 演示模式（内存态，不持久化） */
  presenting: boolean
  slide: number
  /** 减少动效（持久化；缺省跟随系统 prefers-reduced-motion） */
  reduceMotion: boolean
  toggleDark: () => void
  setSketch: (s: SketchLevel) => void
  setView: (v: ViewKind) => void
  setGanttScale: (v: GanttScale) => void
  toggleSidebar: () => void
  toggleOutline: () => void
  setPalette: (open: boolean) => void
  startPresenting: () => void
  exitPresenting: () => void
  setSlide: (n: number) => void
  nextSlide: () => void
  prevSlide: () => void
  toggleReduceMotion: () => void
}

function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? def : v === '1'
  } catch {
    return def
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}

/** 读取手绘档位：仅接受 0/1/2（注意 0 是合法值，不能用 || 回退——修 F-1） */
function loadSketch(): SketchLevel {
  try {
    const raw = localStorage.getItem('msz.sketch')
    if (raw === null) return 1
    const v = Number(raw)
    return v === 0 || v === 1 || v === 2 ? v : 1
  } catch {
    return 1
  }
}

/**
 * 减少动效初始值：用户显式设置（msz.reduceMotion）优先；未设置过才跟随系统。
 * 设计取舍（L-2）：一旦用户手动选择即持久化，之后系统 prefers-reduced-motion 变化
 * 不再自动跟随——显式选择优先于系统默认；用户可再次手动切换。
 */
function initReduceMotion(): boolean {
  try {
    const v = localStorage.getItem('msz.reduceMotion')
    if (v !== null) return v === '1'
  } catch {
    /* ignore */
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

const initialReduceMotion = initReduceMotion()
try {
  document.documentElement.dataset.reduceMotion = initialReduceMotion ? '1' : '0'
} catch {
  /* ignore */
}

export const useSettings = create<SettingsState>((set) => ({
  dark: loadBool('msz.dark', false),
  sketch: loadSketch(),
  view: (localStorage.getItem('msz.view') as ViewKind) || 'mind',
  ganttScale: ((localStorage.getItem('msz.ganttScale') as GanttScale) || 'day'),
  sidebar: loadBool('msz.sidebar', true),
  outline: loadBool('msz.outline', false),
  paletteOpen: false,
  presenting: false,
  slide: 0,
  reduceMotion: initialReduceMotion,
  toggleDark: () =>
    set((s) => {
      save('msz.dark', String(!s.dark))
      return { dark: !s.dark }
    }),
  setSketch: (v) => {
    save('msz.sketch', String(v))
    set({ sketch: v })
  },
  setView: (v) => {
    save('msz.view', v)
    set({ view: v })
  },
  setGanttScale: (v) => {
    save('msz.ganttScale', v)
    set({ ganttScale: v })
  },
  toggleSidebar: () =>
    set((s) => {
      save('msz.sidebar', String(!s.sidebar))
      return { sidebar: !s.sidebar }
    }),
  toggleOutline: () =>
    set((s) => {
      save('msz.outline', String(!s.outline))
      return { outline: !s.outline }
    }),
  setPalette: (open) => set({ paletteOpen: open }),
  startPresenting: () => set({ presenting: true, slide: 0, paletteOpen: false }),
  exitPresenting: () => set({ presenting: false }),
  setSlide: (n) => set({ slide: Math.max(0, n) }),
  nextSlide: () => set((s) => ({ slide: s.slide + 1 })),
  prevSlide: () => set((s) => ({ slide: Math.max(0, s.slide - 1) })),
  toggleReduceMotion: () =>
    set((s) => {
      const v = !s.reduceMotion
      save('msz.reduceMotion', String(v))
      try {
        document.documentElement.dataset.reduceMotion = v ? '1' : '0'
      } catch {
        /* ignore */
      }
      return { reduceMotion: v }
    }),
}))
