export type LayoutKind = 'logic' | 'tree'

/** 甘特任务字段（M4 启用，模型先行预留） */
export interface TaskData {
  start?: string
  end?: string
  progress?: number
  milestone?: boolean
  deps?: { from: string; type: 'FS' | 'SS' | 'FF' | 'SF' }[]
}

export interface MindNodeData {
  id: string
  parent: string | null
  children: string[]
  text: string
  note?: string
  href?: string
  /** 分支色索引 'b0'..'b5' */
  color?: string
  collapsed?: boolean
  task?: TaskData
}

export interface DocData {
  version: 1
  id: string
  title: string
  rootId: string
  layout: LayoutKind
  nodes: Record<string, MindNodeData>
  createdAt: number
  updatedAt: number
}

export interface DocMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}
