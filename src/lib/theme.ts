export const FONT_BODY = "system-ui, 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif"
export const FONT_HAND = "'Segoe Print', 'Comic Sans MS', 'KaiTi', 'STKaiti', cursive"

export interface Theme {
  paper: string
  grid: string
  ink: string
  inkSoft: string
  accent: string
  accentText: string
  nodeFill: string
  rootFill: string
  rootText: string
  selStroke: string
  searchFill: string
  hoverStroke: string
  panel: string
  branch: string[]
}

export const THEME_LIGHT: Theme = {
  paper: '#FAF6EE',
  grid: '#E8DFCB',
  ink: '#3F3A33',
  // M5 对比度核查：次级文字（11px 角标/月份）在纸底需 ≥4.5:1，由 #A39B8B 加深
  inkSoft: '#6E685C',
  accent: '#C96F4A',
  accentText: '#FFF8EE',
  nodeFill: '#FFFDF6',
  rootFill: '#C96F4A',
  rootText: '#FFF8EE',
  selStroke: '#C96F4A',
  searchFill: '#F5E3B8',
  hoverStroke: '#8A9B6E',
  panel: '#F3ECDD',
  branch: ['#C96F4A', '#8A9B6E', '#D9A441', '#7F9BB3', '#B5838D', '#9A8C98'],
}

export const THEME_DARK: Theme = {
  paper: '#2A2622',
  grid: '#3A352E',
  ink: '#E8E0D2',
  // M5：暗纸上次级文字提亮至 4.5:1 以上
  inkSoft: '#9A9184',
  accent: '#E08B66',
  accentText: '#2A2622',
  nodeFill: '#35302A',
  rootFill: '#C96F4A',
  rootText: '#FFF3E4',
  selStroke: '#E08B66',
  searchFill: '#5C5033',
  hoverStroke: '#A8B98A',
  panel: '#33302B',
  branch: ['#E08B66', '#A8B98A', '#E6BC5E', '#9DB4C9', '#C99AA5', '#B3A5B1'],
}

export function getTheme(dark: boolean): Theme {
  return dark ? THEME_DARK : THEME_LIGHT
}
