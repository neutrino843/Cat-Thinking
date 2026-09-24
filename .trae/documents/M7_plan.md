# M7 实施计划 · 节点表达力（富内容）与结构扩展

> 里程碑定位：M6（数据安全与开放）交付后的下一阶段。方向＝**节点富内容 + 布局结构扩展 + 模板体验完善**，直接对应用户 2026-09-23 新增需求。
> 执行方式：按 P1→P5 顺序实施，检查点 C1–C5 实测通过才进入下一阶段；TodoWrite 跟踪。
> 立项日期：2026-09-23（规划，待用户确认启动日期）。

## 一、仓库调研结论

### 起点基线（M6 完成态）
- 94/94 单测全绿；覆盖率语句 93.06%；构建 313.36KB / gzip 106.19KB。
- Playwright 4 spec（crash-recovery/export-json/trash/markdown）在 5174 端口两遍全绿。
- Dexie schema version(3)：docs / templates / trash；文档模型 [DocData version=1](file:///d:/猫思之/src/types.ts)。
- 节点现有字段：text / note（纯字符串）/ href（单链接）/ color / collapsed / task。
- 布局仅 logic / tree 两种（[layout.ts](file:///d:/猫思之/src/lib/layout.ts)）。
- 大纲（[Outline.tsx](file:///d:/猫思之/src/components/Outline.tsx)）与画布双向同步（editSource 区分），M3 已交付；但层级调整仅靠键盘（Tab/Shift+Tab），移动端无按钮入口。
- **内置模板已含用户点名的四类**：[读书笔记 book / 项目规划 project / 会议纪要 meeting / SWOT swot](file:///d:/猫思之/src/data/templates.ts)（另有 blank/welcome/study）；自定义模板可存可删（M5），但**无预览、无文件分享**。

### 用户新增需求与现状差距
| 需求 | 现状 | M7 差距 |
|---|---|---|
| 大纲双向同步 | ✅ 已有 | 移动端层级/增删按钮、快速录入 |
| 布局：逻辑图/树形图 | ✅ 已有 | 组织架构图、鱼骨图、时间轴 |
| 布局动态切换保持层级 | ✅ logic↔tree 已支持 | 新布局接入同一切换 |
| 备注（富文本） | 仅纯字符串 note | 富文本模型 + 编辑器 |
| 超链接（外部+内部节点） | 仅单 href、无编辑 UI | 多链接、内部节点链接与跳转 |
| 图片（插/缩放/裁剪） | 无 | Blob 存储 + 渲染 + 操作 |
| 标签（自定义颜色） | 无 | 模型 + 渲染 + 编辑 |
| 图标（图标库） | 无 | 内置图标集 + 渲染 |
| 附件（上传/预览） | 无 | Blob 存储 + 元信息 + 预览 |
| 模板预览/一键应用/分享 | 一键应用✅，无预览/分享 | 缩略图预览、模板文件导入导出 |

## 二、范围定义

### 纳入（In Scope）
1. **文档模型升级 version 2**：节点富内容字段一次性扩展；旧 v1 文档加载时 normalize（不改盘直到首次编辑保存）。
2. **标签 + 图标**：标签（文本+颜色）、内置手绘风图标库；画布/大纲/导出三处渲染。
3. **备注富文本 + 超链接**：备注支持简单富文本（粗体/斜体/列表/链接）；每节点多链接，支持内部节点链接（点击选中+居中目标）。
4. **图片 + 附件**：IndexedDB Blob 新表；图片插入/缩放/裁剪；附件上传、元信息、预览下载；配额异常处理。
5. **新布局**：组织架构图、鱼骨图、时间轴（横向）三种；统一布局切换，层级关系不变。
6. **模板体验**：模板缩略图预览；模板文件（.msz-tpl JSON）导出/导入分享；四类既有模板富内容化打磨。
7. **大纲移动端**：层级升降/增删的按钮入口。

### 不纳入（Out of Scope，进 Backlog）
- 协同/云同步、实时评论；节点内嵌入视频/音频播放器（仅作附件）。
- 自由布局（手动任意摆位）、关系线（跨层级连线）。
- OPML/PDF/XMind 导出（M6 已冻结）；版本历史快照。
- 备注所见即所得重型编辑器（仅轻量自研，不引入 Quill/TipTap 等重依赖——体积纪律）。
- M5 审核遗留性能项 P-1/P-2/P-3（大文档视口裁剪/索引化）与 F-1（sketch=0 几何丢失）、F-2（跨时区星期）：性能项立卡，若 M7 富内容引发性能退化则提前处置，否则留 M8。

## 三、架构设计

### 3.1 文档模型 v2（一次性扩展，避免反复迁移）
```ts
// types.ts
export type NodeColor = string
export interface NodeTag { id: string; text: string; color: string }   // color 用色板 key
export interface NodeLink {
  id: string
  kind: 'url' | 'node'
  url?: string       // kind=url
  nodeId?: string    // kind=node
}
export interface NodeImage {
  id: string
  blobId: string     // → blobs 表
  w: number; h: number
  crop?: { x: number; y: number; w: number; h: number } // 归一化 0..1
}
export interface Attachment {
  id: string; blobId: string; name: string; size: number; mime: string
}
export interface RichNote { html: string }   // 严格白名单子集

interface MindNodeData {
  // 既有字段保留
  tags?: NodeTag[]
  icons?: string[]         // 内置图标 id 集合
  links?: NodeLink[]       // 旧 href 迁移为 links[0]
  images?: NodeImage[]
  attachments?: Attachment[]
  richNote?: RichNote      // 旧 note 纯串保留；富文本与纯串导出互转
}
interface DocData { version: 2 /* 其余不变 */ }
```
- **v1→v2 normalize**（新 `src/lib/migrate.ts`，纯函数、100% 单测）：version 抬升；href 存在→links；note 纯串→richNote.html（转义）；空补字段；uuid 新生成。
- Dexie docs/templates/trash schema 不变（payload 仍是 JSON 字符串）；**新增 blobs 表需 Dexie version(4)**：
```ts
// version(4): { docs, templates, trash, blobs: 'id, nodeId' }
// blobs: { id; nodeId?; docId; blob: Blob; createdAt }
```

### 3.2 富内容编辑 UI
- `src/components/NodePanel.tsx`（新，右侧/弹层）：选中节点后的富内容编辑面板（标签/图标/链接/图片/附件/备注分区），替代分散入口；Palette 加对应命令。
- 图标库 `src/data/icons.ts`：自研 SVG path 手绘小图标 20–30 个（优先级/人/旗/星/对勾/疑问等），按 id 渲染，零依赖。
- 备注编辑器：轻量 contentEditable + `document.execCommand` 兜底（bold/italic/insertUnorderedList/createLink）；输出经白名单 sanitize（新 `src/lib/sanitizeHtml.ts`）。
- 图片：`<image href={blobURL}>` 在 #world 内渲染；角点缩放/裁剪浮层走鼠标交互（复用拖拽基建 beginEdit/commit:false 单步历史）。
- Blob URL 缓存：按 blobId 内存 Map + revoke 纪律；导出 SVG（外链 Blob 无法离机）时图片**内嵌 dataURL**（≤阈值）或标注占位。
- 内部节点链接点击：`msz:center` 事件 + select（复用现有机制）；目标删除时链接标灰。

### 3.3 新布局（layout.ts 扩展为策略集）
- `LayoutKind` 扩 `'org' | 'fishbone' | 'timeline'`；computeLayout 按 kind 分发，**统一输出 {nodes: Map, edges, bounds}**，Canvas 渲染层不动。
  - org（组织架构图）：根在顶部，向下层级，水平居中排布（同层水平排列）。
  - fishbone（鱼骨图）：根＝鱼头（右侧脊线），一级分支斜上下交替，子节点平铺。
  - timeline（时间轴）：一条水平主轴，节点按 task.start（无则按 DFS 序）落位，上下交错避免重叠。
- 手绘样式：各布局默认参数（间距/角度）可在 settings 微调（仅暴露 2–3 个参数）。
- 大纲/甘特不受影响；timeline 复用 task 日期但不与甘特视图混淆（仍是导图形态）。

### 3.4 模板预览与分享
- 预览：Sidebar 新建菜单悬停/点按模板 → 弹小卡片，用 computeLayout 结果渲染**静态缩略 SVG**（scale to fit，不挂事件）。
- 分享：模板行「导出」→ 下载 `.msz-tpl`（模板 JSON，sanitize 文件名）；「导入模板」文件入口 → 校验后存 templates 表；msz:templates-changed 刷新。
- 四类既有模板内容升级：加标签色/图标示范（book 标签、SWOT 四象限标签色、project 里程碑、meeting 行动项）。

### 3.5 大纲移动端
- Outline 每行加 `＋/－/→/←` 小按钮（增子/删本节点/升级/降级），窄屏常显、宽屏可隐；快速录入：输入后 Enter 建下一条（现有行为）。

## 四、实施步骤（P1–P5）

| 阶段 | 内容 | 检查点 | 任务/时间 |
|---|---|---|---|
| **P1** | 模型 v2 + migrate + Dexie v4 blobs 表 + 标签/图标（模型/编辑面板/画布/大纲/导出渲染） | C1 | 1 个阶段窗口 |
| **P2** | 备注富文本编辑器 + sanitizeHtml + 多超链接（外部/内部节点链接与跳转） | C2 | 1 个阶段窗口 |
| **P3** | 图片（插入/缩放/裁剪/dataURL 导出）+ 附件（上传/预览/下载）+ 配额处理 | C3 | 1–2 个阶段窗口（Blob 风险高） |
| **P4** | org/fishbone/timeline 三布局 + 布局参数 + 大纲移动端按钮 | C4 | 1–2 个阶段窗口 |
| **P5** | 模板预览 + .msz-tpl 导入导出 + 四类模板富内容化；集成交付 | C5 | 1 个阶段窗口 |

时间节点：以阶段窗口为单位推进（每窗口 1–2 个工作日），每检查点实测后更新 M7 进度报告；启动日期待用户确认。

### 各检查点标准
- **C1**：migrate/sanitize 纯函数单测 100% 覆盖；旧 v1 文档浏览器实测无损升级；标签/图标三端（画布/大纲/导出）可见；tsc 0、全量单测绿。
- **C2**：富文本粗斜体/列表/链接往返；白名单拦截脚本/事件属性；内部链接点击定位；导出 MD 含富内容降级。
- **C3**：图片插入→reload 仍在（Blob 持久）；缩放/裁剪撤销重做正确；附件预览/下载；配额异常中文提示不崩溃；**新增 Playwright spec：blob-persistence**。
- **C4**：三布局对同一文档切换节点数不变、bounds 合理；timeline 无日期节点兜底；浏览器零 error；大纲按钮全链路。
- **C5**：模板预览缩略图正确；.msz-tpl 往返一致；coverage 不低于 93.06%（剔除 blobs db 层）；build 体积增量 **gzip ≤ +12KB**（富 UI 增量预算，blob 不进包）；TEST_REPORT 追加 M7；更新项目记忆。

## 五、模块/任务分配（文件级）

| 模块 | 文件 | 阶段 |
|---|---|---|
| 模型与迁移 | types.ts、src/lib/migrate.ts(新)、src/lib/migrate.test.ts | P1 |
| Blob 存储 | db.ts（v4 + blob API） | P1 建、P3 用 |
| 标签/图标 | src/data/icons.ts(新)、NodePanel.tsx(新)、Canvas/Outline 渲染、openFormats 降级 | P1 |
| 富文本 | src/components/NoteEditor.tsx(新)、src/lib/sanitizeHtml.ts(新)+测试 | P2 |
| 链接 | NodePanel 链接区、Canvas 内部链接跳转 | P2 |
| 图片/附件 | src/components/ImageEdit.tsx(新)、exporters dataURL 内嵌、Playwright blob spec | P3 |
| 布局 | layout.ts 策略重构 + org/fishbone/timeline + 单测（几何锚点） | P4 |
| 大纲移动 | Outline.tsx 按钮组 + styles.css | P4 |
| 模板 | Sidebar 预览卡片、模板导入导出、templates.ts 富内容化 | P5 |

## 六、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Blob/图片撑爆 IndexedDB 配额 | 保存失败、数据风险 | blobs 独立表、大小上限与压缩、配额异常中文提示；文档删除联动清 blob |
| contentEditable / execCommand 兼容与 XSS | 脏数据/脚本注入 | 白名单 sanitizeHtml、不存可执行属性；单测覆盖注入样例 |
| 富内容致包体膨胀 | gzip 超标 | 自研轻编辑、不引重型依赖；预算硬门 +12KB |
| 新布局几何 bug（重叠/越界） | 视觉错乱 | text 锚点几何单测 + 浏览器截图；bounds 钳制 |
| v1→v2 迁移问题 | 用户数据风险 | 纯函数迁移 100% 单测；真实旧库浏览器实测（沿 M5/M6 升级纪律）；旧库自动备份提醒已在 M6 就位 |
| 内部节点链接悬挂（目标删/改 id） | 死链 | 删除节点时清理链接或标灰；迁移/克隆时重映射（templateClone 同步加 links/refs） |
| 范围蔓延 | 工期膨胀 | Out-of-Scope 冻结；新想法进 TEST_REPORT Backlog；性能项单独立卡 |

## 七、验证矩阵

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯逻辑 | Vitest（happy-dom） | migrate、sanitizeHtml、布局几何、openFormats 富内容降级、图标/标签纯函数 |
| 数据端到端 | Playwright（5174） | 旧库升级、blob 持久化、模板 .msz-tpl 往返、布局切换节点不变 |
| 交互 | 浏览器冒烟（runbook） | NodePanel 全分区、内部链接跳转、图片缩放裁剪、大纲移动按钮、零 console error |
| 门禁 | coverage/build | ≥93.06%、gzip 增量 ≤+12KB |

## 八、跟踪机制

- TodoWrite 维护 P1–P5，每阶段完成带 summary 与实测证据。
- 每检查点证据写入 TEST_REPORT M7 章节；另建 M7_progress_report.md（P1 启动时）。
- 任何实质性范围变更暂停并重新征得确认。
