import type { DocData, DocDataV1, DocDataV2, MindNodeData, NodeLink } from '../types'

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
 * v1/v2 → v2 节点级迁移（纯函数）：href→links[0]、note→richNote。
 * 与 version 无关，仅做字段补全。
 */
function migrateNodes(nodes: Record<string, MindNodeData>): Record<string, MindNodeData> {
  const out: Record<string, MindNodeData> = {}
  for (const [id, n] of Object.entries(nodes)) {
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

    out[id] = next
  }
  return out
}

/**
 * 文档迁移（纯函数）。
 *
 * 规则：
 * - version 1 → 3：先做 v1→v2 节点字段补全（href→links、note→richNote），再设 version=3
 * - version 2 → 3：节点不变，仅设 version=3（M9 新增 relations/summaries/boundaryBoxes 不补，undefined 即「无」）
 * - version 3 → 原样浅拷贝返回
 *
 * 设计决策：不改盘直到首次编辑保存（懒迁移），调用方在 loadDoc 后调用此函数。
 */
export function migrateDoc(doc: DocDataV1 | DocDataV2 | DocData): DocData {
  // 已是 v3：浅拷贝返回（调用方不应依赖返回值与输入相同引用）
  if (doc.version === 3) {
    return { ...doc }
  }

  // v1 → 节点字段补全；v2 → 节点不变
  const nodes = doc.version === 1 ? migrateNodes(doc.nodes) : doc.nodes

  return {
    ...doc,
    version: 3,
    nodes,
  }
}

/**
 * 判断文档是否已是 v3。
 * 用于 loadDoc 后决定是否需要迁移。
 */
export function isV3(doc: { version: number }): boolean {
  return doc.version === 3
}
