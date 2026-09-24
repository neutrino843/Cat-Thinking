/** 布局种类。M7-P4 将扩展 'org' | 'fishbone' | 'timeline'，当前仅 logic/tree */
export type LayoutKind = 'logic' | 'tree'

/** 甘特任务字段（M4 启用，模型先行预留） */
export interface TaskData {
  start?: string
  end?: string
  progress?: number
  milestone?: boolean
  deps?: { from: string; type: 'FS' | 'SS' | 'FF' | 'SF' }[]
}

/** 节点标签（M7-P1）：文本 + 颜色色板 key */
export interface NodeTag {
  id: string
  text: string
  /** 色板 key：'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'violet' | 'gray' */
  color: string
}

/** 节点超链接（M7-P2）：外部 URL 或内部节点引用 */
export interface NodeLink {
  id: string
  kind: 'url' | 'node'
  /** kind=url 时必填 */
  url?: string
  /** kind=node 时必填，指向同文档内另一节点 id */
  nodeId?: string
}

/** 节点图片（M7-P3）：Blob 存储引用 + 尺寸/裁剪 */
export interface NodeImage {
  id: string
  /** → db.blobs 表 id */
  blobId: string
  w: number
  h: number
  /** 归一化裁剪 0..1，未裁剪则省略 */
  crop?: { x: number; y: number; w: number; h: number }
}

/** 节点附件（M7-P3）：Blob 存储 + 元信息 */
export interface Attachment {
  id: string
  blobId: string
  name: string
  size: number
  mime: string
}

/** 备注富文本（M7-P2）：严格白名单 HTML 子集 */
export interface RichNote {
  html: string
}

export interface MindNodeData {
  id: string
  parent: string | null
  children: string[]
  text: string
  /** 旧纯文本备注，v2 保留兼容；富文本用 richNote */
  note?: string
  /** 旧单链接，v2 迁移为 links[0] */
  href?: string
  /** 分支色索引 'b0'..'b5' */
  color?: string
  collapsed?: boolean
  task?: TaskData

  /* ---- M7 富内容扩展（v2 新增，可选字段） ---- */
  /** 自定义标签列表 */
  tags?: NodeTag[]
  /** 内置手绘图标 id 集合 */
  icons?: string[]
  /** 多链接列表（替代旧单 href） */
  links?: NodeLink[]
  /** 图片列表 */
  images?: NodeImage[]
  /** 附件列表 */
  attachments?: Attachment[]
  /** 富文本备注（与 note 并存：note=纯串兼容，richNote=富文本） */
  richNote?: RichNote
}

interface DocDataV2 {
  version: 2
  id: string
  title: string
  rootId: string
  layout: LayoutKind
  nodes: Record<string, MindNodeData>
  createdAt: number
  updatedAt: number
}

/** 兼容旧 v1 类型：version 字面量不同，运行时由 migrate 归一化 */
interface DocDataV1 {
  version: 1
  id: string
  title: string
  rootId: string
  layout: LayoutKind
  nodes: Record<string, MindNodeData>
  createdAt: number
  updatedAt: number
}

/** 当前文档类型（v2）；v1 数据经 migrateDoc 升级后也符合此类型 */
export type DocData = DocDataV2

/** 旧 v1 类型仅用于 migrate 函数签名 */
export type { DocDataV1 }

export interface DocMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}
