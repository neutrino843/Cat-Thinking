import type { DocData, MindNodeData } from '../types'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * 从模板文档克隆出一篇全新文档（M5 自定义模板 / 模板复用）：
 * - 文档 id 与全部节点 id 重新生成；
 * - parent / children / task.deps[].from / links[].nodeId 同步重映射，依赖与内部链接不悬空；
 * - 图片/附件的 blobId 通过 blobMap 重映射（旧→新），由 cloneDocBlobs 落盘新 blob；
 * - 折叠状态重置为展开；createdAt/updatedAt 刷新。
 * 输入文档不被修改。返回克隆文档与 blobId 重映射表。
 */
export function cloneFromTemplate(src: DocData): { doc: DocData; blobMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  for (const oldId of Object.keys(src.nodes)) idMap.set(oldId, uid())
  const blobMap = new Map<string, string>()
  const remapBlob = (oldId: string): string => {
    let nid = blobMap.get(oldId)
    if (!nid) {
      nid = uid()
      blobMap.set(oldId, nid)
    }
    return nid
  }

  const nodes: Record<string, MindNodeData> = {}
  for (const [oldId, n] of Object.entries(src.nodes)) {
    const id = idMap.get(oldId)
    if (!id) throw new Error(`模板节点 ${oldId} 缺少 ID 映射`)
    // M7-P2：内部节点链接 nodeId 重映射；目标不在本模板内则丢弃该链接（不悬空）
    let links = n.links
    if (links && links.length) {
      links = links
        .map((l) => {
          if (l.kind !== 'node' || !l.nodeId) return l
          const nodeId = idMap.get(l.nodeId)
          return nodeId ? { ...l, nodeId } : null
        })
        .filter((l): l is NonNullable<typeof l> => !!l)
    }
    // M7-P3：图片/附件 blobId 重映射
    let images = n.images
    if (images && images.length) {
      images = images.map((im) => ({ ...im, blobId: remapBlob(im.blobId) }))
    }
    let attachments = n.attachments
    if (attachments && attachments.length) {
      attachments = attachments.map((at) => ({ ...at, blobId: remapBlob(at.blobId) }))
    }
    nodes[id] = {
      ...n,
      id,
      parent: n.parent ? (idMap.get(n.parent) ?? null) : null,
      children: n.children.map((c) => idMap.get(c)).filter((x): x is string => !!x),
      collapsed: false,
      ...(links && links.length ? { links } : {}),
      ...(images && images.length ? { images } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(n.task
        ? {
            task: {
              ...n.task,
              deps: n.task.deps
                ?.map((d) => {
                  const from = idMap.get(d.from)
                  return from ? { from, type: d.type } : null
                })
                .filter((d): d is { from: string; type: 'FS' | 'SS' | 'FF' | 'SF' } => !!d),
            },
          }
        : {}),
    }
  }

  // M9：关系表达 overlay 字段 id 重映射（from/to/members）
  const remappedRelations = src.relations?.length
    ? src.relations
        .map((r) => {
          const from = idMap.get(r.from)
          const to = idMap.get(r.to)
          return from && to ? { ...r, from, to } : null
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
    : undefined
  const remappedSummaries = src.summaries?.length
    ? src.summaries
        .map((s) => ({
          ...s,
          members: s.members
            .map((m) => idMap.get(m))
            .filter((m): m is string => m !== undefined),
        }))
        .filter((s) => s.members.length > 0)
    : undefined
  const remappedBoxes = src.boundaryBoxes?.length
    ? src.boundaryBoxes
        .map((b) => ({
          ...b,
          members: b.members
            .map((m) => idMap.get(m))
            .filter((m): m is string => m !== undefined),
        }))
        .filter((b) => b.members.length > 0)
    : undefined

  const now = Date.now()
  return {
    doc: {
      ...src,
      id: uid(),
      rootId: idMap.get(src.rootId) ?? src.rootId,
      nodes,
      relations: remappedRelations,
      summaries: remappedSummaries,
      boundaryBoxes: remappedBoxes,
      createdAt: now,
      updatedAt: now,
    },
    blobMap,
  }
}

/**
 * M7-P3：克隆文档的 blob 二进制（配合 cloneFromTemplate 的 blobMap）。
 * 对每个 [oldId, newId]：从源文档取 blob，按新 id 写入目标文档。
 * 由调用方注入 getBlobFn/putBlobFn 以避免本模块依赖 IndexedDB（便于测试）。
 */
export async function cloneDocBlobs(
  _srcDocId: string,
  dstDocId: string,
  blobMap: Map<string, string>,
  getBlobFn: (id: string) => Promise<Blob | undefined>,
  putBlobFn: (id: string, docId: string, blob: Blob, nodeId?: string) => Promise<void>,
): Promise<void> {
  for (const [oldId, newId] of blobMap) {
    const blob = await getBlobFn(oldId)
    if (!blob) continue
    await putBlobFn(newId, dstDocId, blob)
  }
}
