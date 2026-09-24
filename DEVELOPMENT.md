# 猫思之 · 项目开发文档

> 手绘风思维导图应用。本地优先、零依赖、IndexedDB 持久。
> 仓库：https://github.com/neutrino843/Cat-Thinking

---

## 目录

- [M1–M3：核心导图引擎](#m1m3核心导图引擎)
- [M4：甘特图视图](#m4甘特图视图)
- [M5：模板系统与代码审计](#m5模板系统与代码审计)
- [M6：数据安全与开放格式](#m6数据安全与开放格式)
- [M6 审计修复](#m6-审计修复)
- [M7：节点表达力（富内容）与结构扩展](#m7节点表达力富内容与结构扩展)
  - [P1：数据模型 v2 + 迁移 + 标签/图标](#p1数据模型-v2--迁移--标签图标)
  - [P2：备注富文本 + 多链接](#p2备注富文本--多链接)
  - [P3：图片 + 附件](#p3图片--附件)
  - [P4：新布局 + 大纲移动端](#p4新布局--大纲移动端)
  - [P5：模板预览与分享](#p5模板预览与分享)

---

## M1–M3：核心导图引擎

### 阶段目标
从零搭建手绘风思维导图应用的核心：画布渲染、节点编辑、撤销重做、大纲同步。

### 实现步骤
1. **M1 骨架**：Vite + React + TypeScript + Dexie；Canvas SVG 渲染 + 手绘抖动算法（sketch.ts）；logic 布局
2. **M2 编辑**：双击/Enter 编辑、Tab 加子、Enter 加兄、Delete 删除；撤销重做（past/future 栈）
3. **M3 大纲**：Outline 组件与画布双向同步（editSource 区分）；搜索高亮

### 关键技术
- 手绘风格：Bezier 曲线 + seed jitter（3 档：简洁/中等/很手绘）
- 布局：logic（放射式）+ tree（水平树）；computeLayout 输出 `{nodes: Map, edges, bounds}`
- 撤销重做：beginEdit 暗拍快照；commit:false 不入历史（连续文本输入）

### 测试
- 94 条单测；覆盖率 93.06%

---

## M4：甘特图视图

### 阶段目标
为有 task 字段的节点添加甘特图视图，支持依赖关系与进度。

### 实现
- TaskData：`{ start, end, progress, milestone, deps: [{from, type}] }`
- Gantt 组件：日/周/月三档缩放；拖拽改工期/移动；依赖箭头
- 布局切换保持节点层级

---

## M5：模板系统与代码审计

### 阶段目标
内置模板（book/project/meeting/swot 等）、自定义模板存删、全面代码审计。

### 实现
- 7 个内置模板；cloneFromTemplate 重映射 id
- 自定义模板存 Dexie templates 表（v2 schema）
- 33 项审计（F 功能/P 性能/S 安全/C 规范/L 逻辑）

---

## M6：数据安全与开放格式

### 阶段目标
回收站（软删/还原/清空）、JSON 开放导出导入、Markdown 双向、备份提醒。

### 实现步骤
1. 回收站：Dexie v3 trash 表；moveToTrash 事务内 docs→trash→docs.delete；30 天清扫
2. JSON 导出/导入：validateDoc 严格校验（parent↔children 双向一致、deps.type 枚举、sanitize 文件名）
3. Markdown：toMarkdown（缩进层级）/ parseMarkdown（缩进解析）
4. 备份提醒：14 天阈值横幅 + 3 天稍后（localStorage msz.lastBackupAt / backupSnoozeUntil）
5. E2E：4 个 Playwright spec

### 关键代码
- `src/store/db.ts`：moveToTrash/restoreDoc/sweepTrash
- `src/lib/openFormats.ts`：toMarkdown/parseMarkdown
- `src/lib/backup.ts`：shouldNagBackup
- `src/components/BackupBanner.tsx`：横幅 UI

### 验证
- tsc 0 错；94 单测全绿；覆盖率 93.06%；E2E 4/4；build 313.36KB/gzip 106.19KB

---

## M6 审计修复

### 问题清单（33 项 + 1 重大发现）

| 级别 | ID | 文件 | 问题 | 修复 |
|------|-----|------|------|------|
| **重大** | — | Canvas.tsx | onUp 先清空 hoverRef 再读取，reparent 永不触发 | 先取命中目标再清理 |
| F-1 | P1 | settings.ts | `Number(x) ?? 1 \|\| 1` 吞掉 0 | 显式判空函数 loadSketch |
| F-2 | P1 | Gantt.tsx | `new Date(d).getDay()` UTC 跨时区错位 | parseISO 本地解析 |
| F-3 | — | db.ts | loadDoc JSON.parse 无容错 | try-catch 返回 null |
| F-4 | — | exporters.ts | setTimeout(80) 不可靠 | 双 requestAnimationFrame |
| F-5 | — | Gantt.tsx | resize `Math.max(0, delta)` 无法缩短 | 允许负 delta 钳位 end≥start |
| F-6 | — | Canvas.tsx | additive 选择误触发编辑 | 区分 additive 不进 beginEdit |
| F-7 | — | docStore.ts | commit:false 清空 future | 保留 future 与契约一致 |
| F-8 | — | Canvas/Gantt | 拖拽监听卸载泄漏 | aliveRef 自我清理 |
| P-4 | — | measure.ts | 缓存无上限 | LRU 2000 上限 |
| P-5 | — | Gantt.tsx | 周末底纹每次渲染重算 | useMemo |
| S-2 | — | exporters.ts | SVG 未净化脚本 | sanitizeSVGMarkup |
| S-5 | — | Outline.tsx | 属性选择器 id 未转义 | 反斜杠转义 |
| C-1/2 | — | Gantt.tsx | 恒等三元 | 删除 |
| C-3 | — | Gantt.tsx | 类型用 ReturnType | 改 DocData |
| C-6 | — | docStore.ts | filter(Boolean) 类型 | 类型谓词 |
| C-7 | — | refs.ts | 缺 TSDoc | 补全 |
| L-2 | — | settings.ts | reduceMotion 设计不明 | 注释 |
| L-3 | — | exporters.ts | deps.type 无枚举校验 | FS/SS/FF/SF 校验 |
| L-4 | — | presentation.ts | preorder 无防环 | seen Set |
| L-5 | — | Canvas.tsx | renderDoc 优先级不清 | 注释 |

### 新增回归测试
- F-1：sketch=0 保留（settings.test.ts）
- F-7：commit:false 不清 future（docStore.test.ts）
- L-3：deps.type 非法拒绝（exporters.test.ts）
- S-2：SVG 净化 script/on*（exporters.test.ts）

### 验证
- tsc 0 错；101 单测全绿；覆盖率 94.53%；E2E 4/4；build 314.83KB/gzip 106.68KB

---

## M7：节点表达力（富内容）与结构扩展

### 里程碑定位
M6 交付后的下一阶段。方向 = 节点富内容 + 布局结构扩展 + 模板体验完善。

### P1：数据模型 v2 + 迁移 + 标签/图标

#### 阶段目标
一次性扩展文档模型（version 1→2），添加标签与图标功能，建立 Blob 存储基建。

#### 实现步骤
1. **types.ts**：新增 NodeTag/NodeLink/NodeImage/Attachment/RichNote 类型；DocData version 升至 2
2. **migrate.ts**：纯函数 v1→v2 迁移（href→links[0]、note→richNote.html 转义）
3. **migrate.test.ts**：13 个测试覆盖迁移规则
4. **db.ts**：Dexie v4 新增 blobs 表（id/docId/nodeId）；loadDoc 调用 migrateDoc 懒迁移
5. **icons.ts**：20 个自研手绘 SVG 图标（零依赖）
6. **NodePanel.tsx**：选中节点时侧栏展开标签/图标编辑面板
7. **Canvas.tsx**：节点渲染标签色点（右侧）和图标（文字左侧）
8. **styles.css**：NodePanel 完整样式
9. 全部 fixture/模板/创建文档更新到 version: 2

#### 关键代码
```ts
// types.ts - v2 模型扩展
export interface NodeTag { id: string; text: string; color: string }
export interface NodeLink { id: string; kind: 'url' | 'node'; url?: string; nodeId?: string }
// MindNodeData 新增：tags?/icons?/links?/images?/attachments?/richNote?

// migrate.ts - 纯函数迁移
export function migrateDoc(doc: DocDataV1 | DocData): DocData {
  if (doc.version === 2) return { ...doc }
  // href → links[0]，note → richNote.html（转义）
}
```

#### 遇到的问题及解决方案
- **PowerShell heredoc 不兼容**：git commit 用 `-F` 文件方式替代 bash heredoc
- **Defender 实时保护拦截 git 写对象**：间歇性 rename Permission denied；用户加排除项后恢复
- **Vite dev server 仅绑定 IPv6**：`--host 127.0.0.1` 强制 IPv4 绑定

#### 测试结果
- tsc 0 错
- 单测 114/114（新增 13 个迁移测试）
- 覆盖率 94.53%
- Playwright E2E 4/4
- build 321.03KB / gzip 109.03KB（增量 +2.35KB，在 +12KB 预算内）

---

### P2：备注富文本 + 多链接

> **状态：已完成**（commit 963fcdc，2026-09-24）

#### 阶段目标
为节点备注提供轻量富文本编辑（粗体/斜体/列表/链接/引用），并通过白名单净化防止 XSS；支持每节点多链接（外部 URL + 内部节点引用跳转）。

#### 实现步骤
1. **sanitizeHtml.ts 白名单净化器**：允许 b/i/u/strong/em/ul/ol/li/a/br/p/blockquote；两道防线——正则预剥离 script/style/iframe/object/embed 等危险子树（兼容 happy-dom DOMParser 对内嵌 script 的不稳定处理），DOMParser 递归属性剥离 + 协议白名单（http(s)/mailto/#node- 内部锚点）；A 标签外部链接自动补 target=_blank + rel=noopener noreferrer。
2. **sanitizeHtml.test.ts**：23 个注入样例测试（on* 事件、javascript:/data:/vbscript: 协议、script/style/iframe/svg 整树丢弃、非白名单 unwrap 保留文本、白名单内标签递归净化、最终输出绝不出现 javascript: 字面）。
3. **richNoteToText**：富备注 → 纯文本降级（BR/P→换行、LI→行首、A→文本+[链接](url)），供 toMarkdown 导出与搜索索引使用。
4. **NoteEditor.tsx**：contentEditable + document.execCommand 轻量编辑器（B/I/U/列表/链接/引用），Ctrl+B/I/L 快捷键；输出始终经 sanitizeHtml 净化后写回 store；链接插入校验 http(s) 或 #node- 锚点；零第三方依赖（不引 Quill/TipTap）。
5. **NodePanel.tsx 新增两分区**：
   - 链接区：外部 URL / 内部节点 tab 切换；内部链接点击复用 msz:center 事件居中跳转 + select；目标节点已删除时标灰禁用（gotoLink dead 处理）。
   - 备注区：NoteEditor 富文本；旧纯 note 自动转义为 `<p>...</p>` 作为初值，richNote 优先。
6. **Canvas.tsx**：节点右缘 ✎ 指示符现在识别 richNote.html（不仅 note）；新增 🔗 链接指示符（links.length > 0 时显示）。
7. **openFormats.ts toMarkdown 降级**：多链接输出 `[🔗](url)`（外部）与 `[节点→#nodeId]`（内部）；备注优先 richNote（经 richNoteToText）再回退纯 note。
8. **templateClone.ts**：克隆模板时内部节点链接 nodeId 重映射；目标不在模板内则丢弃该链接不悬空。

#### 关键代码
- sanitizeHtml 双防线（src/lib/sanitizeHtml.ts）：正则预剥离 + DOM 递归净化
- NoteEditor commit 净化回写（src/components/NoteEditor.tsx）：raw → sanitize → 若与 DOM 不同则回写避免脏数据停留
- NodePanel gotoLink 复用 msz:center（src/components/NodePanel.tsx）：内部链接跳转零新基建

#### 遇到的问题及解决方案
- **happy-dom DOMParser 对内嵌 `<script>` 处理不稳定**：直接解析 `<p>前<script>...</script>后</p>` 会导致整段内容丢失。解决：在 DOMParser 前加正则预剥离危险标签整棵子树，DOM 层再做属性/协议净化，双防线既兼容测试环境又防绕过。
- **happy-dom HTMLIFrameElement 解析时触发网络请求**：`<iframe src="x">` 会让 happy-dom 尝试 fetch。同样由正则预剥离解决。
- **PowerShell 不支持 heredoc**：git commit 多行消息用多个 `-m` 参数替代 `<<'EOF'`。
- **Vite dev server 默认绑 IPv6**：`--host 127.0.0.1` 强制 IPv4，Playwright baseURL 也改 127.0.0.1。
- **browser_use 代理 click 不触发 pointerdown**：Canvas 选中逻辑在 onPointerDown，浏览器代理只发 click 事件无法选中节点（非代码缺陷）；Playwright 的 click() 触发完整 pointer 序列所以 E2E 通过。

#### 测试结果
- tsc 0 错误
- 137/137 单测全绿（新增 23 个 sanitizeHtml 测试：20 sanitize + 3 richNoteToText）
- 覆盖率 94.44%（语句）/ 86.07%（分支）
- 4/4 Playwright E2E 全绿
- 生产构建 329.78KB / gzip 111.87KB（P2 较 P1 增量 +8.78KB / +2.87KB gzip，远低于 M7 总预算 +12KB gzip）

---

### P3：图片 + 附件

> **状态：待实施**

- Blob 存储 CRUD（P1 已建表）
- 图片插入/缩放/裁剪
- 附件上传/预览/下载
- 配额异常处理
- 新增 Playwright blob-persistence spec

---

### P4：新布局 + 大纲移动端

> **状态：待实施**

- org（组织架构图）/ fishbone（鱼骨图）/ timeline（时间轴）
- 统一布局切换，层级关系不变
- 大纲移动端层级升降/增删按钮

---

### P5：模板预览与分享

> **状态：待实施**

- 模板缩略图预览（静态 SVG 渲染）
- .msz-tpl 文件导入/导出
- 四类模板富内容化打磨
- 集成交付 + TEST_REPORT 追加 M7
