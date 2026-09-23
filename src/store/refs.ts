/** 跨组件共享的可变引用（避免为 DOM 元素引入额外状态层） */
export const searchRef: { current: HTMLInputElement | null } = { current: null }
export const worldHolder: { current: Element | null } = { current: null }
export const ganttHolder: { current: SVGSVGElement | null } = { current: null }
