import { create } from 'zustand'
import { zhCN, type I18nKey } from './zh-CN'
import { enUS } from './en-US'

export type Lang = 'zh-CN' | 'en-US'

const DICTS = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const

const LANG_KEY = 'msz.lang'

function loadLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'zh-CN' || v === 'en-US') return v
  } catch {
    /* ignore */
  }
  return 'zh-CN'
}

interface I18nState {
  lang: Lang
  setLang: (l: Lang) => void
}

export const useI18n = create<I18nState>((set) => ({
  lang: loadLang(),
  setLang: (l) => {
    try {
      localStorage.setItem(LANG_KEY, l)
      document.documentElement.lang = l
    } catch {
      /* ignore */
    }
    set({ lang: l })
  },
}))

/**
 * 取文案：支持 `{name}` 占位插值。缺失 key 时原样返回 key（便于渐进迁移）。
 */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const lang = useI18n.getState().lang
  let s: string = (DICTS[lang] as Record<string, string>)[key] ?? (zhCN as Record<string, string>)[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}

/** React hook：订阅语言变化以触发重渲染，返回 t 函数 */
export function useT() {
  // 仅订阅，不消费返回值——语言变化时 zustand 会重渲染调用方
  useI18n((s) => s.lang)
  return t
}
