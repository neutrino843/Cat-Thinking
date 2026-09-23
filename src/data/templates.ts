import type { DocData, MindNodeData } from '../types'

interface TplNode {
  text: string
  note?: string
  children?: TplNode[]
}

export interface Tpl {
  id: string
  name: string
  root: TplNode
}

export const TEMPLATES: Tpl[] = [
  {
    id: 'blank',
    name: '空白文档',
    root: { text: '中心主题' },
  },
  {
    id: 'welcome',
    name: '欢迎教程',
    root: {
      text: '欢迎使用猫思之 🐱',
      children: [
        {
          text: '快速上手',
          children: [
            { text: 'Tab 新建子节点', note: '选中节点后按 Tab' },
            { text: 'Enter 新建兄弟节点' },
            { text: 'Delete 删除节点' },
            { text: 'Ctrl+Z 撤销，Ctrl+Shift+Z 重做' },
            { text: '双击或 F2 编辑文本' },
          ],
        },
        {
          text: '玩转画布',
          children: [
            { text: '滚轮缩放，空白处拖拽平移' },
            { text: '拖动节点到另一节点上可换父' },
            { text: 'Space 折叠 / 展开（试试这里）' },
            { text: 'Alt+↑↓ 调整兄弟顺序' },
          ],
        },
        {
          text: '数据安全',
          children: [
            { text: '所有数据只保存在你的浏览器里' },
            { text: '自动保存，无需手动 Ctrl+S' },
            { text: '可导出 JSON / SVG / PNG 随身携带' },
          ],
        },
        {
          text: '效率工具',
          children: [
            { text: 'Ctrl+K 打开命令面板' },
            { text: 'Ctrl+F 搜索节点' },
            { text: '右上角可切换大纲视图' },
          ],
        },
      ],
    },
  },
  {
    id: 'book',
    name: '读书笔记',
    root: {
      text: '《书名》读书笔记',
      children: [
        { text: '核心观点', children: [{ text: '观点 1' }, { text: '观点 2' }] },
        { text: '金句摘录', children: [{ text: '「……」—— 第 x 章' }] },
        { text: '行动启发', children: [{ text: '我可以尝试……' }] },
        { text: '疑问与延伸', children: [{ text: '作者没有回答……' }] },
      ],
    },
  },
  {
    id: 'project',
    name: '项目规划',
    root: {
      text: '项目名',
      children: [
        { text: '目标', children: [{ text: '可量化的目标 1' }, { text: '可量化的目标 2' }] },
        { text: '里程碑', children: [{ text: 'M1 原型' }, { text: 'M2 内测' }, { text: 'M3 发布' }] },
        { text: '风险', children: [{ text: '技术风险' }, { text: '时间风险' }] },
        { text: '待办', children: [{ text: '需求梳理' }, { text: '技术选型' }, { text: '排期' }] },
      ],
    },
  },
  {
    id: 'meeting',
    name: '会议纪要',
    root: {
      text: '会议主题（日期）',
      children: [
        { text: '与会人', children: [{ text: '张三' }, { text: '李四' }] },
        { text: '议题', children: [{ text: '议题 1：结论与待办' }, { text: '议题 2：结论与待办' }] },
        { text: '决议', children: [{ text: '决定 1' }] },
        { text: '行动项', children: [{ text: '负责人 + 事项 + 截止时间' }] },
      ],
    },
  },
  {
    id: 'study',
    name: '学习计划',
    root: {
      text: '学习主题',
      children: [
        { text: '第一阶段：入门', children: [{ text: '资料 1' }, { text: '练习' }] },
        { text: '第二阶段：实践', children: [{ text: '小项目' }] },
        { text: '第三阶段：输出', children: [{ text: '写博客 / 做分享' }] },
        { text: '检验标准', children: [{ text: '能讲清楚……' }] },
      ],
    },
  },
  {
    id: 'swot',
    name: 'SWOT 分析',
    root: {
      text: 'SWOT',
      children: [
        { text: 'S 优势', children: [{ text: '…' }] },
        { text: 'W 劣势', children: [{ text: '…' }] },
        { text: 'O 机会', children: [{ text: '…' }] },
        { text: 'T 威胁', children: [{ text: '…' }] },
      ],
    },
  },
]

export function buildDoc(tpl: Tpl): DocData {
  const now = Date.now()
  const nodes: Record<string, MindNodeData> = {}
  const uid = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)

  const mk = (tn: TplNode, parent: string | null, level: number, color: string): string => {
    const id = uid()
    nodes[id] = {
      id,
      parent,
      children: [],
      text: tn.text,
      ...(tn.note ? { note: tn.note } : {}),
      ...(level > 0 ? { color } : {}),
    }
    if (parent) nodes[parent].children.push(id)
    tn.children?.forEach((c, i) => mk(c, id, level + 1, level === 0 ? 'b' + (i % 6) : color))
    return id
  }
  const rootId = mk(tpl.root, null, 0, '')
  return {
    version: 1,
    id: uid(),
    title: tpl.id === 'blank' ? '未命名导图' : tpl.name,
    rootId,
    layout: 'logic',
    nodes,
    createdAt: now,
    updatedAt: now,
  }
}

export function findTpl(id: string): Tpl {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]
}
