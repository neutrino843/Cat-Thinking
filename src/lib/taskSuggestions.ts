import type { DocData } from '../types'

export interface TaskSuggestion { id: string; text: string; reason: string }
/** Suggestions are a preview only. Never mutate nodes or invent dates/dependencies. */
export function suggestTasks(doc: DocData): TaskSuggestion[] {
  return Object.values(doc.nodes).filter((node) => node.id !== doc.rootId && !node.task
    && /完成|复习|练习|阅读|学习|整理|提交|编写|实现|设计|测试|验证|准备|制作|调研|发布|考试|截止|交付/u.test(node.text))
    .map((node) => ({ id: node.id, text: node.text, reason: '包含行动或交付词，请确认是否为可执行任务' }))
}
