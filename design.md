# CatThinking 设计系统

<!-- Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V4 -->

这是应用的共享视觉约定。2026-10-14 完成全站视觉统一：所有页面（学习模块、思维导图编辑器、全部弹窗）共用同一套暖纸色 + 森林绿体系，`tokens.css` 是唯一视觉源文件。现有导图内容、布局、手绘档位与编辑操作保持各自的语义。

## 风格与结构

- 全站风格：暖纸色专业工作台。米白纸面、森林绿主操作、淡绿任务区、1px 细分隔线、柔和投影；课程与学习任务用行列表表达，导图保留画布与手绘档位。
- 应用结构：首页为学习主导航 → 今日任务与真实学习事实 → 课程概览与下一步；课程、练习、知识、备考、记录与备份使用页面内工作区。思维导图进入 `#mindmap`，保留文档标签、画布与工具抽屉，支持返回首页。
- AI 结构：当前文档内打开分析；独立设置面板连接服务；摘要、大纲、导图、测验和知识结果继续保留原文引用。
- 产品定位：能回到原文的学习工作台。以「理清知识，测出疑问，回到原文」连接资料、知识结构、自测与复核，主要服务课程学习、考试复习和实验理论整理。
- 学习目标按钮只调整当前待生成内容，不直接发起付费调用；默认仍是摘要与大纲。已保存课程有独立归档、长期提交与规则复习；当前 live 面板仍显示本次待复习内容。不把答对、自评或计划完成包装成掌握率。
- 桌面保留工具栏与左右工具面板。窄屏工具栏可纵向滚动，文档库与大纲覆盖画布，不挤压为不可编辑的窄条。
- 不使用营销首屏、装饰插画、虚构统计、模拟浏览器窗口或庆祝动效。

## 学习工作区变体

- 纸面继承品牌暖色；全部页面使用低饱和森林绿主操作、淡草绿今日焦点、浅暖褐学习方法区，颜色均由 `tokens.css` 的 `--color-study-*` 提供。
- 标题统一采用离线宋体/衬线字体角色，正文使用本机中文无衬线字体；`--font-study-display` 与正文 token 分工。
- 结构是课程与任务工作台，不是营销页。主要任务优先，课程采用可扫描的行列表，右侧用于继续整理与学习流程说明；未建立课程时显示真正空状态。
- 桌面左导航固定在滚动视窗；768px 以下折为“学习导航”展开按钮。320/375/414/768px 均需要验收。
- 编辑工作区与只读工作区共用细线、柔阴影与舒适间距；编辑态通过行为与聚焦反馈区分，不靠另一套配色区分。不改动文档中的节点样式与用户配色。
- 日期按客户端 Asia/Shanghai 显示；课程排期仍使用各自时区。首页只显示已提交次数、到期/补学任务和规则估计时间，没有虚构连续学习天数、掌握率、AI 节省时间或模拟课程。

## 颜色与字体

颜色、间距、字号、边框、阴影和圆角均以根目录 `tokens.css` 为准，且该文件是全站唯一令牌定义处；旧样式变量全部在该文件内重定向到同一套语义 token，`src/styles.css` 不再重复定义。已有样式保留并增量覆盖，避免丢失编辑器行为。

全站正文使用系统无衬线字体，标题使用本机中文衬线字体。应用中文名称继续使用猫思之。不安装远程字体，离线也能工作。代码与快捷键采用系统等宽字体。标题始终为正体。

主操作统一使用森林绿与浅色文字；画布节点强调色与选中描边同步为同一森林绿。危险操作同时用明确文字和错误色，不只依赖颜色。深色主题调整纸面与正文，主操作依旧可辨。

## 间距与交互

- 4px 基础间距，主要控件最小高度 44px。
- 边框宽度不会在聚焦或错误时变化；聚焦立即出现独立蓝色描边（3px）。
- 按钮通过短距离位移与边框反馈表达可交互；减少动态效果设置或系统偏好会去掉位移。
- 页面/视图切换与弹窗开合使用统一的短淡入过渡，同样受减少动态效果设置管控，不产生布局跳变。
- 加载状态说明正在做什么，错误使用本地固定文案，不展示服务商原始响应、密钥或堆栈。
- 原生 `dialog` 负责顶层模态与背景不可交互；设置面板另设 Tab 首尾循环、Escape、明确关闭和焦点恢复。
- 成功消息静默保留在当前面板；不新增全局庆祝提示。
- 手机验证宽度为 320 / 375 / 414 / 768px；页面不横向滚动，面板内容允许纵向滚动。

## AI 设置的文案与隐私

普通流程是选择 AI 服务、填写 API 密钥、选择或手动填写模型、保存并连接。常见服务的地址与格式已预设；用户确有需要时再打开更多选项。

模型建议是带日期的官方文档快照，不代表账号拥有访问权限。模型列表可从服务商读取，自定义模型不被预设名单限制。没有模型列表的服务需要用户明确选择使用手填模型，首次正式分析再验证生成效果。

API 密钥仅停留在尚未保存的密码输入状态与提交请求中。模型列表预览后保留该输入，避免用户重复粘贴；保存提交或关闭面板时清空。浏览器持久化、文档备份、设置读取响应均不包含密钥。保存端由本地 AI 服务保管密钥，前端只收到是否已有密钥的状态。

连接检查读取模型列表，不生成内容。正式分析会使用服务商额度。未知模型价格不展示 0 元估算，只显示真实使用量和“费用以服务商账单为准”。修改连接不会自动重新生成已有结果。

## 持续开发边界

- 保留 App、Toolbar、Sidebar、Canvas、Outline 与现有结果组件的职责，不替换路由或文档树。
- `tokens.css` 是视觉源文件；`providerCatalog.ts` 是服务与模型建议源文件；设置 API 的共享 schema 是通信契约。
- 前端通过同源网关管理设置，不能直接访问第三方 Provider。
- 后续新增协议先实现服务端适配、输出校验与脱敏测试，再添加 UI 选项。
- UI 不能把未运行的真实生成验证称为已完成，也不能自行解除部署发布门禁。

## Exports

### tokens.css

完整可复用导出为根目录 [tokens.css](./tokens.css)。其他格式如下，供后续前端迁移使用；本项目当前没有引入 Tailwind 或 shadcn。

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.5% 0.014 86);
  --color-paper-2: oklch(95% 0.019 86);
  --color-ink: oklch(20% 0.012 80);
  --color-muted: oklch(43% 0.018 80);
  --color-accent: oklch(38% 0.068 157);
  --color-accent-ink: oklch(98% 0.009 86);
  --color-support: oklch(93% 0.025 157);
  --color-focus: oklch(45% 0.19 265);
  --font-display: 'Noto Serif SC', 'Source Han Serif SC', 'STZhongsong', 'SimSun', serif;
  --font-body: system-ui, 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif;
  --font-outlier: ui-monospace, 'Cascadia Code', Consolas, monospace;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --text-sm: 0.875rem;
  --text-md: 1rem;
  --text-xl: 1.5rem;
  --radius-card: 10px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`

```json
{
  "color": {
    "paper": { "$value": "oklch(97.5% 0.014 86)", "$type": "color" },
    "ink": { "$value": "oklch(20% 0.012 80)", "$type": "color" },
    "accent": { "$value": "oklch(38% 0.068 157)", "$type": "color" },
    "support": { "$value": "oklch(93% 0.025 157)", "$type": "color" },
    "focus": { "$value": "oklch(45% 0.19 265)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Noto Serif SC, Source Han Serif SC, STZhongsong, SimSun, serif", "$type": "fontFamily" },
    "body": { "$value": "system-ui, Microsoft YaHei, PingFang SC, Noto Sans SC, sans-serif", "$type": "fontFamily" }
  },
  "spacing": {
    "sm": { "$value": { "value": 1, "unit": "rem" }, "$type": "dimension" },
    "md": { "$value": { "value": 1.5, "unit": "rem" }, "$type": "dimension" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: oklch(97.5% 0.014 86);
  --foreground: oklch(20% 0.012 80);
  --card: oklch(95% 0.019 86);
  --card-foreground: oklch(20% 0.012 80);
  --primary: oklch(38% 0.068 157);
  --primary-foreground: oklch(98% 0.009 86);
  --secondary: oklch(93% 0.025 157);
  --secondary-foreground: oklch(38% 0.068 157);
  --muted: oklch(92% 0.026 87);
  --muted-foreground: oklch(43% 0.018 80);
  --border: oklch(86% 0.018 86);
  --input: oklch(86% 0.018 86);
  --ring: oklch(45% 0.19 265);
  --destructive: oklch(44% 0.16 27);
  --radius: 10px;
}
```
