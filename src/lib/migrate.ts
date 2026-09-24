import type { DocData, DocDataV1, MindNodeData, NodeLink } from '../types'

/**
 * 生成短 id：优先 crypto.randomUUID，降级 Math.random。
 * 独立函数便于测试时 mock。
 */
function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * v1 → v2 文档迁移（纯函数）。
 *
 * 规则：
 * - version 1 → 2（已为 2 则原样返回浅拷贝）
 * - href 存在 → links[0] = { id, kind:'url', url: href }；旧 href 不清空（兼容旧读取方）
 * - note 存在且 richNote 未设 → richNote = { html: 转义后的 note }
 * - 其余 v2 新字段（tags/icons/images/attachments）不补——undefined 即「无」
 *
 * 设计决策：不改盘直到首次编辑保存（懒迁移），调用方在 loadDoc 后调用此函数。
 */
export function migrateDoc(doc: DocDataV1 | DocData): DocData {
  // 已是 v2：浅拷贝返回（调用方不应依赖返回值与输入相同引用）
  if (doc.version === 2) {
    return { ...doc }
  }

  // v1 → v2
  const nodes: Record<string, MindNodeData> = {}
  for (const [id, n] of Object.entries(doc.nodes)) {
    const next: MindNodeData = { ...n }

    // href → links[0]（仅当 links 尚未存在且有 href）
    if (n.href && !n.links) {
      const link: NodeLink = {
        id: genId(),
        kind: 'url',
        url: n.href,
      }
      next.links = [link]
    }

    // note 纯串 → richNote.html（转义基本 HTML 特殊字符）
    if (n.note && !n.richNote) {
      const escaped = n.note
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      next.richNote = { html: escaped }
    }

    nodes[id] = next
  }

  return {
    ...doc,
    version: 2,
    nodes,
  }
}

/**
 * 判断文档是否已是 v2。
 * 用于 loadDoc 后决定是否需要迁移。
 */
export function isV2(doc: { version: number }): boolean {
  return doc.version === 2
}
