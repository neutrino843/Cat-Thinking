/** 布局种类：logic（逻辑图）/ tree（树形图）/ org（组织架构图）/ fishbone（鱼骨图）/ timeline（时间轴） */
export type LayoutKind = 'logic' | 'tree' | 'org' | 'fishbone' | 'timeline'

/** 甘特任务字段（M4 启用，模型先行预留） */
export interface TaskData {
  start?: string
  end?: string
  progress?: number
  milestone?: boolean
  deps?: { from: string; type: 'FS' | 'SS' | 'FF' | 'SF' }[]
  /** M16：优先级 0=无 1=低 2=中 3=高 */
  priority?: 0 | 1 | 2 | 3
  /** M16：负责人（自由文本） */
  owner?: string
  /** M16：任务备注（纯文本，区别于节点富备注） */
  note?: string
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

/* ---- M9 关系表达（PRD 4.1.5 P1）---- */

/** 关系线：任意两节点间的箭头连接，可带文字标签；独立于 parent/children 层级 */
export interface Relation {
  id: string
  /** 起点节点 id */
  from: string
  /** 终点节点 id */
  to: string
  /** 关系线文字标签 */
  label?: string
  /** 颜色 key：'' 用主题 ink；'b0'..'b5' 用分支色 */
  color?: string
}

/** 概要：花括号框选一组兄弟节点 */
export interface Summary {
  id: string
  /** 被框选的兄弟节点 id 列表（应同 parent，运行时宽松校验） */
  members: string[]
  /** 概要文字标签 */
  label?: string
  color?: string
}

/** 边界框：矩形框选任意节点 */
export interface BoundaryBox {
  id: string
  /** 被框选的节点 id 列表（可任意） */
  members: string[]
  /** 标题文字 */
  label?: string
  color?: string
}

/** 节点与来源原文之间的定位关系。字符区间基于规范化后的纯文本。 */
export interface SourceAnchor {
  nodeId: string
  start: number
  end: number
  /** 标题路径或段落所属章节，便于后续展示引用来源。 */
  locator?: string
  /** PDF 等分页文档使用；文本/Markdown/DOCX 省略。 */
  page?: number
}

/** Cat-Thinking 内建解析器支持的来源文档类型。 */
export type SourceKind = 'text' | 'markdown' | 'pdf' | 'docx'

/**
 * 独立持久化的来源文档。原文不塞进 DocData，避免每次编辑节点时重复序列化大文本。
 * 后续摘要、大纲、题目、知识拓展和节点 AI 都以 source.id 为稳定输入边界。
 */
export interface SourceDocument {
  version: 1
  id: string
  docId: string
  name: string
  kind: SourceKind
  mime: string
  size: number
  lastModified: number
  importedAt: number
  extractor: string
  text: string
  charCount: number
  anchors: SourceAnchor[]
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

/** M9：关系表达（PRD 4.1.5 P1）——v3 新增可选字段，旧文档懒迁移后 undefined 即「无」 */
interface DocDataV3 {
  version: 3
  id: string
  title: string
  rootId: string
  layout: LayoutKind
  nodes: Record<string, MindNodeData>
  /** 关系线列表（可选） */
  relations?: Relation[]
  /** 概要列表（可选） */
  summaries?: Summary[]
  /** 边界框列表（可选） */
  boundaryBoxes?: BoundaryBox[]
  createdAt: number
  updatedAt: number
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

/** 当前文档类型（v3）；v1/v2 数据经 migrateDoc 升级后也符合此类型 */
export type DocData = DocDataV3

/** 旧 v1/v2 类型仅用于 migrate 函数签名 */
export type { DocDataV1, DocDataV2 }

export interface DocMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}
