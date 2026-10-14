import type { DocData, MindNodeData } from '../types'

interface TplNode {
  text: string
  note?: string
  /** M7-P5：标签色示范（color 用色板 key） */
  tags?: { text: string; color: string }[]
  /** M7-P5：内置图标 id 集合（须为 data/icons.ts 中存在的 id） */
  icons?: string[]
  /** M7-P5：任务/里程碑示范 */
  task?: { start?: string; end?: string; milestone?: boolean }
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
      text: '猫思之使用教程 · 能回到原文的学习工作台',
      note: '把课程资料积累成自己的知识体系：理清结构，主动回忆，作答回查，保存历史，再安排复习。顶部「今日学习」进入课程工作台；资料与进度可以一起备份。',
      children: [
        {
          text: '1. 启动与连接 AI',
          note: '可以先编辑文档，不连接 AI 也能使用。第一次体验建议只选一小段原文生成摘要与大纲。',
          children: [
            { text: '双击「启动猫思之.cmd」', note: '保留启动窗口。浏览器未打开时，使用窗口中显示的网址；端口被占用会自动换一个。结束时在窗口按 Ctrl+C。' },
            { text: '打不开时使用终端，或运行「诊断启动.cmd」', note: '在项目文件夹打开 PowerShell，执行 npm.cmd run start:local。诊断入口只检查本机通路，不发送 AI 生成请求。不要把密钥贴到聊天或截图。' },
            { text: '打开顶部「AI 设置」', children: [
              { text: '选择服务商，填入自己的 API 密钥', note: '常见服务会自动填地址。自定义服务需要提供兼容接口地址。本机 Ollama 必须先运行并准备模型，可以不填密钥。' },
              { text: '选择模型，或手动输入模型名称', note: '可刷新账号的可用模型；预设名称只是建议，是否能用取决于服务商账号。' },
              { text: '点击「保存并连接」', note: '连接检查只读取模型列表。服务不提供列表时，按提示明确连接手填的模型；点击生成才会消耗服务商额度。' },
            ] },
          ],
        },
        {
          text: '2. 导入原文，选择分析范围',
          children: [
            { text: '在文档库点击「从文档生成」', note: '支持 TXT、Markdown、DOCX 和 PDF。先检查预览，再点击「创建可编辑导图」。这是本地结构初稿；需要知识层级与内在联系时，在 AI 分析中生成思维导图。扫描版 PDF 需要先转成可选择的文字。' },
            { text: '点击顶部「AI 分析」', note: '选中要分析的来源。范围留空使用全文；也可填起始和结束字符，缩小到一个章节。第一次建议选约 1–2 千字符。' },
            { text: '所选原文会发送给连接的模型', note: '浏览器里的编辑文档与原文是本地数据；AI 分析会把本次选择发送给服务商。请先确认内容适合发送。' },
            { text: '勾选生成内容，再点击生成', note: '可以只选需要的内容。选择思维导图时会同时生成所需大纲；测验题数可以调整。' },
            { text: '按目标选择「整理要点」「理解结构」「自测复习」', note: '整理要点选择摘要与大纲；理解结构选择大纲与导图；自测复习选择测验。想看结构并自测，选择理解结构后再勾选测验。切换目标只是调整勾选，点击生成才开始调用模型；本次任务开始后暂不能追加其他种类，请先选好。' },
          ],
        },
        {
          text: '3. 查看结果与原文依据',
          children: [
            { text: '摘要：抓住主旨、重点和需要澄清的地方' },
            { text: '大纲：按知识结构逐层阅读' },
            { text: '思维导图：先预览，再创建独立导图', children: [
              { text: '点击「创建独立导图」→「打开生成导图」', note: '会保存一篇独立文档并复制引用原文，不覆盖原始文档。重复创建会找回同一份导图，保留手动修改。归档到课程后，还可以显式「创建学习导图」建立节点与知识点的准确身份关联；旧导图不会按同名补绑。' },
              { text: '阅读上级主题、子知识和有依据的关系', note: '在画布继续调整层级、备注与关系线；只根据原文支持的联系理解内容。' },
            ] },
            { text: '测验：先作答，再提交查看答案', note: '客观题按本次生成的参考答案计分，参考答案本身也需要核对；简答题按评分标准自评。作答保存在当前浏览器，可重新作答。' },
            { text: '待复习内容：回看题目与原文', children: [
              { text: '区分与参考答案不一致、未答、简答待自评', note: '提交后自动整理本次清单；简答勾选了部分要点时提示还有待补充的要点，不让模型替你判断掌握程度。' },
              { text: '点击「回看第几题」或「原文」', note: '直接定位到题目或原文片段。查看、作答与自评不新增 AI 生成调用；没有待复习项也不代表已经掌握全部知识。' },
              { text: '重新作答清空当前草稿，课程中的提交历史保留', note: '先把本次结果保存到课程，之后每次提交会保留独立历史；未加入课程的练习仍只有当前记录。旧记录没有精确提交时间时，会明确标为历史导入。原文或产物变化后不能沿用旧作答。' },
            ] },
            { text: '知识整理：区分原文与推断', note: '查看前置知识、应用、类比、对比或拓展。推断不等于原文事实，重要结论需要自己核对。' },
            { text: '点击结果旁的引用，返回原文核对', note: '引用会打开对应来源与片段。结果与当前来源不一致时停止使用旧结果，不靠模型猜测补齐。' },
          ],
        },
        {
          text: '4. 把资料积累成一门课程',
          children: [
            { text: '在 AI 分析结果里点击「保存到课程」', note: '选择已有课程，或输入新课程名称。保存的是本次原文快照与已有结果，不会重新调用模型。之后可「进入课程继续学习」。' },
            { text: '顶部「今日学习」打开课程工作台', note: '工作台包含「今日、知识、练习、资料、记录、备考、应用、备份」八个入口。没有学习资料时，先创建课程、加入文档，再保存分析结果。' },
            { text: '知识页：先核对，再确认知识与题目归属', note: '共同原文依据只表示相关。查看定义、来源和题目后，再确认归属；改名或修改核心说明会转为待确认。个人补充与原文分开保存。' },
            { text: '从知识点进入已有练习，再回到原文补学', note: '同次分析中可点节点的相关练习，也可从题目回到对应知识点。没有准确关联的题目时不会随机补题或偷偷生成；同名概念需要比较来源并人工确认。' },
            { text: '开始引导学习，保存自己的回忆与解释', note: '按阅读、隐藏说明回忆、实际练习、原文回查、自己的解释继续。没有题目可以跳过；读过、提交过、自评完成分别记录。' },
            { text: '资料页查看归档内容与分析范围', note: '原任务删除或到期后，归档原文与已有结果仍可查看。未选入范围表示尚未处理，不代表不重要；要补充内容需明确创建新分析。' },
          ],
        },
        {
          text: '5. 今日安排、长期记录与应用',
          children: [
            { text: '今日页按每天可用时间安排任务', note: '查看到期复习、补学与新学习，以及未排入的任务数量。可暂停或调整日期；延后与跳过不计作答错误。应用关闭后不承诺后台提醒。' },
            { text: '先手动安排日期，再按需启用本地复习建议', note: '在课程「资料」页设置每日分钟和题数，并明确启用本地自动复习日期建议。规则使用 1、3、7、14 天；手动日期优先，同一天重复成功不推进间隔。简答需完成自评并选择回忆难度。' },
            { text: '记录页保留每次回答、自评修订与错因', note: '重新作答不删除课程历史。题目或答案有疑问时，作答与自动安排暂停；核对后解除疑问，再明确恢复已暂停队列。清除历史需要单独确认，复习安排会重置并暂停。' },
            { text: '备考页选择日期与范围，用已有题库组卷', note: '查看分日安排、未排入范围和缺题数量。开始一组模拟练习后，该组报告只使用其中的回答；客观比较、自评、未答与问题题目分别统计，不预测成绩。' },
            { text: '应用页记录解释、比较、案例或实验观察', note: '手工创建任务与自评要点，记录自己的解释、预测和实际观察。完成自评不等同于已经具备迁移能力，重要结论仍需核对。' },
          ],
        },
        {
          text: '6. 暂停、失败与额度',
          children: [
            { text: '「恢复查看」读取已有任务，不重新生成' },
            { text: '分析失败也可能已经消耗额度', note: '已知输入和输出用量会保留；实际费用以服务商账单为准。不要因为失败就连续重新生成。' },
            { text: '刷新或「恢复查看」不会重新付费生成', note: '生成过程中必要的格式修复也会计入用量。失败后不会盲目重发无法确认的调用；明确重试或新生成可能再次产生费用。请先检查失败说明、原文范围和服务商额度。' },
            { text: '在 AI 设置「暂停新分析」', note: '停止新分析并取消尚未完成的任务；已生成结果和编辑文档保留。取消不能退回服务商已产生的费用。' },
            { text: '切换模型或删除连接', note: '旧任务先停止，已有结果不会自动重做。删除连接会擦除保存的密钥，仍保留任务身份与用量记录。' },
            { text: '「删除分析内容」不删除导入文档', note: '删除该任务的后端原文副本、证据、结果与本地关联。已保存的课程归档保留；独立导图在文档库单独管理。要删除课程里的原文副本与记录，请使用资料页的归档删除入口并核对范围。' },
          ],
        },
        {
          text: '7. 保存、课程包与删除范围',
          children: [
            { text: '编辑文档会自动保存在当前浏览器', note: '换浏览器、换网址或清理浏览器数据后，本地文档不会自动跟随。重启时使用启动窗口给出的地址；避免切换 localhost 与 127.0.0.1。' },
            { text: '课程「备份」页导出完整课程包 .mszcourse', note: '包含课程、原文副本、已有结果、完整附件、作答历史与复习安排。可以设置备份密码；密码自己保管，API 密钥和可执行后台任务不在包内。' },
            { text: '恢复前先检查，再确认为一门新课程', note: '选择课程包，按需输入密码，检查数量与缺失项后确认恢复。每次恢复都使用新课程和文档身份，保留当前资料；不会重新连接模型或恢复付费任务。缺失的可编辑文档会说明，合法归档与记录仍可恢复。' },
            { text: '顶部「导出」→「JSON（完整数据）」备份当前文档', note: 'JSON 包含编辑内容和引用原文，小附件会随文档保存；超过 2 MB 的图片或附件需另外保留原文件。导出不包含 API 密钥、服务端 AI 任务记录或练习作答。' },
            { text: 'Chrome / Edge 也可另存为 .msz', note: '之后可打开 .msz 文件继续编辑。JSON 与 .msz 用于恢复文档；SVG、PNG、PDF 适合展示，不作为完整编辑备份。' },
            { text: '移出课程、删除归档、删除课程各有范围', note: '移出课程保留文档与归档；删除一份学习归档会删除该份原文副本及关联记录，停用相应知识点，个人补充保留；删除课程组织会移除课程学习记录并保留原编辑文档。删除前先检查确认提示，必要时导出课程包。' },
            { text: 'AI 数据库备份另做', note: '在项目文件夹运行 npm.cmd run db:backup。备份与加密配置需要配套保管，不能公开上传；目前是开发工作区命令，不是跨机一键恢复功能。' },
          ],
        },
        {
          text: '8. 编辑导图基础',
          children: [
            { text: 'Tab 新建子节点；Enter 新建兄弟节点' },
            { text: '双击或 F2 编辑；Delete 删除节点' },
            { text: 'Ctrl+Z 撤销；Ctrl+Shift+Z 重做' },
            { text: '滚轮缩放，空白处拖拽平移' },
            { text: '拖动节点到另一节点上可换父' },
            { text: 'Space 折叠 / 展开；Alt+↑↓ 调整顺序' },
            { text: 'Ctrl+K 打开命令面板；Ctrl+F 搜索节点' },
            { text: '顶部可切换布局、大纲和演示' },
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
        { text: '核心观点', tags: [{ text: '观点', color: 'blue' }], children: [{ text: '观点 1' }, { text: '观点 2' }] },
        { text: '金句摘录', tags: [{ text: '金句', color: 'amber' }], children: [{ text: '「……」—— 第 x 章' }] },
        { text: '行动启发', icons: ['flag'], children: [{ text: '我可以尝试……' }] },
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
        { text: '里程碑', children: [
          { text: 'M1 原型', task: { milestone: true } },
          { text: 'M2 内测', task: { milestone: true } },
          { text: 'M3 发布', task: { milestone: true } },
        ] },
        { text: '风险', tags: [{ text: '风险', color: 'red' }], children: [{ text: '技术风险' }, { text: '时间风险' }] },
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
        { text: '决议', icons: ['check'], children: [{ text: '决定 1' }] },
        { text: '行动项', tags: [{ text: '待办', color: 'green' }], children: [
          { text: '负责人 + 事项 + 截止时间', task: { start: '2026-09-29', end: '2026-10-05' } },
        ] },
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
        { text: 'S 优势', tags: [{ text: '内部', color: 'green' }], children: [{ text: '…' }] },
        { text: 'W 劣势', tags: [{ text: '内部', color: 'red' }], children: [{ text: '…' }] },
        { text: 'O 机会', tags: [{ text: '外部', color: 'blue' }], children: [{ text: '…' }] },
        { text: 'T 威胁', tags: [{ text: '外部', color: 'orange' }], children: [{ text: '…' }] },
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
      ...(tn.tags ? { tags: tn.tags.map((t) => ({ id: uid(), ...t })) } : {}),
      ...(tn.icons ? { icons: tn.icons } : {}),
      ...(tn.task ? { task: tn.task } : {}),
      ...(level > 0 ? { color } : {}),
    }
    if (parent) nodes[parent].children.push(id)
    tn.children?.forEach((c, i) => mk(c, id, level + 1, level === 0 ? 'b' + (i % 6) : color))
    return id
  }
  const rootId = mk(tpl.root, null, 0, '')
  return {
    version: 3,
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
