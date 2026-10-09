/** 简体中文文案（默认语言）。新增 key 必须同时在 en-US 补齐。 */
export const zhCN = {
  // 通用
  'app.name': '猫思之',
  'common.confirm': '确定',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.save': '保存',
  'common.close': '关闭',
  'common.untitled': '未命名导图',
  'common.searchPlaceholder': '搜索节点…',
  'common.clear': '清除',
  'common.loading': '加载中…',

  // 视图
  'view.mind': '导图',
  'view.gantt': '甘特',
  'view.outline': '大纲',
  'view.fit': '适应窗口',

  // 大纲
  'outline.title': '大纲 · 双向同步',
  'outline.placeholder': '输入内容…',
  'outline.fold': '折叠 / 展开',
  'outline.outdent': '升级（提升为父的兄弟）',
  'outline.indent': '降级（移到前一兄弟下）',
  'outline.addChild': '新建子节点',
  'outline.remove': '删除节点',

  // 侧栏
  'sidebar.docs': '文档库',
  'sidebar.new': '新建文档',
  'sidebar.trash': '回收站',
  'sidebar.import': '导入文件',
  'sidebar.empty': '暂无文档',

  // 文档导入（M17）
  'import.document': '从文档生成',
  'import.extracting': '正在提取…',
  'import.map': '导入导图',
  'import.documentTitle': '从文档生成可编辑导图',
  'import.documentHint': '先在本地提取文本和结构，确认后创建新导图；原文会与导图分开保存。',
  'import.ready': '已就绪',
  'import.mapTitle': '将创建的导图标题',
  'import.chars': '字符',
  'import.sections': '章节',
  'import.paragraphs': '段落',
  'import.nodes': '草稿节点',
  'import.preview': '一级结构预览',
  'import.noPreview': '没有可预览的一级结构',
  'import.currentSupport': '支持 TXT、Markdown、文本型 PDF 和 DOCX，均在浏览器本地解析；扫描版 PDF 暂不支持 OCR。',
  'import.create': '创建可编辑导图',
  'import.saving': '正在创建…',
  'import.failed': '文档导入失败：',

  // 文件
  'file.open': '打开 .msz',
  'file.save': '保存到文件',
  'file.saveAs': '另存为 .msz',
  'file.export': '导出',
  'file.saved': '已保存',
  'file.savedTo': '已保存到 {name}',
  'file.unsupported':
    '当前浏览器不支持直接读写 .msz 文件（需 Chrome/Edge 100+）。\n可使用侧栏「导入文件」与「导出 JSON」达到同样的备份迁移效果。',

  // 过滤
  'filter.allTags': '全部标签',
  'filter.allStatus': '全部状态',
  'filter.todo': '未开始',
  'filter.doing': '进行中',
  'filter.done': '已完成',
  'filter.milestone': '里程碑',
  'filter.hitCount': '{n} 个节点',
  'filter.clear': '清除节点过滤',

  // 节点面板
  'panel.batch': '批量操作',
  'panel.batchHint': '已选中 {n} 个节点',
  'panel.batchColor': '批量配色',
  'panel.batchTag': '批量加标签',
  'panel.branchColor': '分支颜色',
  'panel.default': '默',

  // 标签
  'tabs.close': '关闭标签',
  'tabs.untitled': '未命名导图',

  // 演示
  'present.exit': '退出演示',

  // 设置
  'settings.dark': '深色',
  'settings.light': '浅色',
  'settings.sketch': '手绘',
  'settings.reduceMotion': '减少动效',
  'settings.language': '语言',
  'settings.zh': '简体中文',
  'settings.en': 'English',

  // 回收站
  'trash.title': '回收站',
  'trash.restore': '还原',
  'trash.deleteForever': '永久删除',
  'trash.empty': '清空回收站',
  'trash.emptyConfirm': '确定清空回收站？此操作不可撤销。',
  'trash.back': '返回文档库',

  // 模板
  'tpl.blank': '空白文档',

  // 甘特
  'gantt.today': '今天',
  'gantt.scaleDay': '日',
  'gantt.scaleWeek': '周',
  'gantt.scaleMonth': '月',
  'gantt.colName': '任务',
  'gantt.colStart': '开始',
  'gantt.colEnd': '结束',
  'gantt.colProgress': '进度',
  'gantt.colMilestone': '里程碑',
  'gantt.colDeps': '依赖',
  'gantt.makeTask': '变为任务',
  'gantt.editTask': '编辑',
  'gantt.depsCount': '{n} 项',
  'gantt.criticalPath': '关键路径',
  'gantt.colPriority': '优先级',
  'gantt.colOwner': '负责人',
  'gantt.priorityNone': '无',
  'gantt.priorityLow': '低',
  'gantt.priorityMedium': '中',
  'gantt.priorityHigh': '高',
  'gantt.ownerPlaceholder': '负责人',

  // 版本历史（M15）
  'history.title': '版本历史',
  'history.empty': '暂无历史版本',
  'history.restore': '恢复',
  'history.restoreConfirm': '确定恢复到此版本？当前未保存的更改将丢失。',
  'history.restoreFailed': '恢复失败：版本数据已损坏。',
  'history.deleteConfirm': '确定删除此版本快照？',
}

export type I18nDict = Record<keyof typeof zhCN, string>
export type I18nKey = keyof I18nDict
