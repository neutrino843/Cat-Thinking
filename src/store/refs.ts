/**
 * 跨组件共享的可变引用（避免为 DOM 元素引入额外状态层）。
 *
 * 使用约定：
 * - 仅用于「导出/命令」场景读取当前挂载的 DOM，不参与 React 渲染流；
 * - 组件挂载/更新时写入 current，卸载无需刻意清空（旧元素自然不可用）；
 * - 读取方必须判空。
 */

/** Toolbar 搜索输入框：供快捷键（如 Ctrl/Cmd+F）聚焦 */
export const searchRef: { current: HTMLInputElement | null } = { current: null }

/** 思维导图 Canvas 内的 <g class="world">：SVG/PNG 导出时序列化其 innerHTML */
export const worldHolder: { current: Element | null } = { current: null }

/** 甘特图根 <svg>：甘特视图下 SVG/PNG 导出的序列化来源 */
export const ganttHolder: { current: SVGSVGElement | null } = { current: null }
