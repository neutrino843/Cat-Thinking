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
- [M9：关系表达（关系线/概要/边界框）](#m9关系表达关系线概要边界框)
- [M17：文档导入与内容提取基础](#m17文档导入与内容提取基础)

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

> **状态：已完成**（M7-P1 建 blobs 表时同步落地）

- Blob 存储 CRUD（P1 已建表）；NodePanel 支持上传图片/附件、删除、附件下载
- 画布 SVG `<image>` 渲染节点图片（layout 预留 imgH），支持裁剪 clip-path
- blobUrl.ts 缓存 objectURL，生命周期由 revokeBlobURL/revokeAllBlobURLs 管理
- 配额异常：saveBlob 失败时 alert 中文提示

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

---

## M9：关系表达（关系线/概要/边界框）

> **状态：已完成** | PRD 4.1.5 P1

### 阶段目标
实现 PRD 4.1.5 P1 的三种关系表达元素：关系线（箭头+文字，独立于 parent/children 层级）、概要（花括号框选兄弟组）、边界框（矩形框选任意节点）。数据模型升级到 v3。

### 实现内容

#### 1. 数据模型 v3（types.ts + migrate.ts）
- 新增 `Relation`（id/from/to/label?/color?）、`Summary`（id/members[]/label?/color?）、`BoundaryBox`（id/members[]/label?/color?）三个接口
- `DocData` version 2→3，新增可选字段 `relations?/summaries?/boundaryBoxes?`
- `migrateDoc` 纯函数支持 v1→v3、v2→v3、v3→v3（浅拷贝）三条迁移路径；`isV2` 更名为 `isV3`
- `validateDoc` 增加 overlay 字段校验（from/to/members 指向存在的节点）

#### 2. 布局几何（layout.ts）
- `LayoutResult` 扩展 `relations/summaries/boxes` 三个数组
- `computeRelations`：贝塞尔曲线 + 箭头角度 + 标签中点；跳过悬挂引用与自环
- `computeSummaries`：花括号位置（成员 bbox 外侧，side 由整体 x 决定）
- `computeBoxes`：成员 bbox + 12px padding 的圆角矩形
- `edgePoint`：节点矩形与中心连线的边交点计算

#### 3. Store 操作（docStore.ts）
- `addRelation/updateRelation/removeRelation`
- `addSummary/updateSummary/removeSummary`
- `addBoundaryBox/updateBoundaryBox/removeBoundaryBox`
- `setOverlay` 通用快照更新（与 upd 同语义，但改 doc 级 overlay 数组）
- `removeNodes` 增加悬挂引用清理（关系线/概要/边界框的成员引用）
- `undo/redo` 随快照恢复 overlay 字段
- `snap` 函数扩展捕获 relations/summaries/boundaryBoxes

#### 4. Canvas 渲染（Canvas.tsx）
- `RelationView`：虚线贝塞尔 + 箭头 + 标签文字
- `SummaryView`：手绘花括号路径 + 标签
- `BoxView`：虚线圆角矩形 + 标题
- 渲染层级：边界框（最底）→ 边线 → 节点 → 概要 → 关系线（最顶）

#### 5. 模板克隆（templateClone.ts）
- `cloneFromTemplate` 增加 overlay 字段 id 重映射（from/to/members 经 idMap 转换）
- 悬空引用过滤（成员不在模板内的条目移除）

### 测试覆盖
- `overlays.test.ts`：21 用例（几何计算 10 + store 操作 8 + 模板克隆 1 + 集成 2）
- `e2e/overlays.spec.ts`：4 E2E（v3 导出、画布不崩溃、布局切换、v2→v3 迁移）
- 全套：18 文件 202 用例全通过，E2E 12/12 全通过
- lint 0 errors / 37 warnings，build 358.45 KB / gzip 119.86 KB

---

## M10：数据互通（PDF 导出 / OPML 交换 / .msz 单文件）

> **状态：已完成** | PRD 4.3 P1 | 零第三方依赖

### 阶段目标
让文档「出得去、进得来、可直接当文件用」：
1. **OPML 导入/导出**——与 Workflowy/幕布/XMind 等大纲工具互通结构（标题+层级+备注降级）；
2. **PDF 导出**——导图/甘特都能产出真实可打开的 PDF；
3. **.msz 单文件模式**——基于 File System Access API 直接读写磁盘文件（Ctrl+S 原地保存），不支持时降级为导入/导出 JSON。

### 实现内容

#### 1. OPML（src/lib/openFormats.ts）
- `toOPML(doc)`：OPML 2.0；head/title 承载文档标题；body 下**单个顶层 outline 即根节点**（保证根文本往返）；嵌套 outline 表达层级；备注经 `richNoteToText` 降级写入 `_note` 属性；属性/文本统一经 `xmlEscape`（& 最先转义）。
- `parseOPML(xml, fallbackTitle)`：**自研极简 XML 解析器**（`XmlNode/parseXml/decodeXmlEntities`，支持自闭合、单双引号、`&amp;`/数字字符引用、CDATA 之外的常见子集）。body 下 0 个顶层→仅标题根；1 个→即根；多个→建标题包裹根。空内容 / XML 非法 / 缺 `<opml>` 抛带 cause 的中文 Error。
- `parseImported`（exporters.ts）新增 `.opml/.xml` 分流；所有导入仍强制经过 `validateDoc` 校验关口。

#### 2. PDF（src/lib/pdf.ts + exporters.ts）
- `jpegToPdf()`：~100 行自研 PDF 生成器，5 对象（Catalog/Pages/Page/Image/Content）+ xref 表 + %%EOF。JPEG 以 `/Filter /DCTDecode` 原样嵌入（零依赖、免图像编码库）。
- 导出管线重构：抽出 `svgToCanvas()`（2x 缩放，单边 >14000px 自动降档防 canvas 上限）、`rasterize()`（PNG）、`rasterizeToPdf()`（canvas JPEG q0.92 → PDF）；`exportPDF()` 导图/甘特双视图可用；`exportCurrent` 联合类型扩展 pdf/opml。
- 导出侧 `buildExportPayload(doc)`（含 ≤2MB 内嵌 blobs）与 `markBackupNow()` 从 exportJSON 拆出，供 .msz 复用。

#### 3. .msz 单文件模式（fsaTypes.ts / fileHandle.ts / db.ts）
- `fsaTypes.ts`：File System Access API 最小类型 + `getFSA()`（bind 到 window）。
- `fileHandle.ts`：模块级 `memoryBindings: Map<docId, handle>`（会话内快速路径）；
  - `saveMSZAs`（另存为，取消返回 null/不支持 undefined）、`saveMSZBound`（query/requestPermission 后原地覆写，返回 saved/unbound/unsupported）、`openMSZFile`（读盘→parseImported→saveDoc→还原 blobs→记住绑定）；
  - 句柄持久化走 Dexie **version(5)** 新增 `fileHandles` 表，`bind/get/touch/unbind` 四方法，全部 best-effort（结构化克隆失败仅 warn 不阻断内存绑定）。
- 降级：Firefox/Safari 无 picker 时 alert 中文提示，引导走侧栏导入/导出 JSON。

#### 4. UI 接线
- Toolbar 新增「文件 ▾」菜单（打开 .msz / 保存到文件 Ctrl+S / 另存为 .msz）；「导出 ▾」新增 OPML/PDF；保存成功 2.5s 轻提示 toast（`.file-toast`，支持 reduce-motion）。
- **菜单点击后自动收起**（原生 `<details>` 不会因内部按钮点击而关闭，冒泡 onClick 置 `open=false`）。
- App.tsx 注册 Ctrl/Cmd+S（在 INPUT 早退之前拦截）；Palette 加 5 条命令；Sidebar 导入 accept 加 `.msz,.opml,.xml`。
- 数据模型**不升版本**（.msz/OPML 均为文件层格式，DocData 保持 v3）。

### 遇到的问题及解决方案
- **happy-dom 的 application/xml DOMParser 会退化为 HTML 解析并执行内嵌 `<script>`（alert is not a function）**：OPML 导入改用自研 XML 解析器，顺便消除全部环境依赖；解析器缺陷在单测中暴露并修复。
- **多顶层 outline 时子节点被挂两次**：递归 `mk(el,parent)` 内部已负责 `parent.children.push(id)`，包裹根分支又 push 一遍 → 移除外层 push。
- **PDF xref 偏移格式**：每条必须精确 20 字节 `nnnnnnnnnn ggggg f/n\r\n`，自由头 gen=65535、对象 gen=00000，f/n 后无空格；用 latin1 TextDecoder 做字节级单测。
- **TS5.5 `new Blob([uint8])` 类型不兼容**：以 `new Blob([pdf.buffer as ArrayBuffer])` 构造。
- **Playwright 无法驱动系统文件选择器**：`page.addInitScript` 注入内存版 showSaveFilePicker/showOpenFilePicker + mock handle/writable，文件存 Map；句柄对象含函数无法结构化克隆，恰好验证 IDB 绑定的 best-effort 容错路径。
- **tmenu 选择器因新增「文件」菜单而歧义**：E2E 助手改为按菜单文本（hasText 导出/文件）定位。
- **甘特 tab 可访问名是「甘特」**（全称只在 title），E2E 用 `getByRole('tab', { name: '甘特' })`。

### 测试结果
- tsc 0 错；lint 0 errors（37 warnings 均为存量 no-non-null-assertion）
- 单测 **226/226**（新增 openFormats OPML 14、pdf 5、fileHandle 2、exporters 分流 3，M9 基线 202）
- E2E **18/18**（新增 opml 往返 1、pdf 导图/甘特 2、msz 全流程/取消/降级 3）
- build **369.11 KB / gzip 123.93 KB**（较 M9 +10.66KB / +4.07KB gzip；PDF 生成器与 XML 解析器均自研，零新依赖）

---

## M11：多文档标签页 / 批量操作 / 过滤 / 触控板捏合

> **状态：已完成** | PRD 4.4（多文档标签页 P1、批量操作 P1）、PRD 4.1.7（按标签/状态过滤 P1）、PRD 4.1.1（触控板捏合缩放 P1）| 零第三方依赖

### 阶段目标
1. 多文档标签页：同窗口多开、点击/中键切换关闭、每标签独立撤销栈、刷新后恢复；
2. 批量操作：多选节点批量配色（分支颜色）、批量加标签；
3. 过滤：按标签 / 按状态（未开始/进行中/已完成/里程碑）AND 组合过滤，命中节点+祖先链展示，过滤态为视图不改正文；
4. 触控板捏合：ctrlKey+wheel（Chrome/Edge/Firefox 标准）与 Safari gesturechange 双支持，以光标为锚点缩放。

### 实现内容

#### 1. 纯函数基础库
- **src/lib/viewport.ts**：`View {k,tx,ty}`；`MIN_K=0.15 / MAX_K=3`；`wheelFactor/pinchFactor` 指数映射（exp(-d·系数)）；`zoomAt(v,mx,my,factor)` 先钳制 k 再以缩放比 s=k/v.k 反算平移 `tx=mx-(mx-v.tx)·s`，保证光标下内容不漂移。
- **src/lib/filter.ts**：`NodeFilter {tag,status}`、`emptyFilter/isFilterActive`；`nodeStatus`（milestone 优先，progress≥1 done、>0 doing）；`computeFilter` 求「命中节点 ∪ 祖先链」（根恒在），路径折叠所需展开写入 expand 集合；`applyFilter(doc,f)` 输出裁剪后的视图文档（children/relations/summaries/boundaryBoxes 同步裁剪 + 临时展开），**不改原文**；`collectTagTexts` 去重保序供下拉。

#### 2. Store 多会话（src/store/docStore.ts）
- `Session {doc, past, future, clipboard}`：**doc 字段是关键**——切走标签时把当前活动文档（含 700ms 防抖窗口内未落盘的编辑）存进 session；切回时 `sess.doc ?? 磁盘文档` 优先，实现各标签独立撤销栈且不丢编辑。
- 新增 `tabs/sessions/openDoc(d,opts?)/closeTab(id)`；`filter/setFilter/clearFilter`（openDoc/loadDoc 均重置过滤）；`batchUpdate`（一次快照包裹批量改）、`batchColor`（写 color||undefined）、`batchAddTag`（trim 后按 text 去重 push `{id:uid(),text,color}`）。
- `EMPTY_DOC` 导出（version 3、id:''）；标签 id 持久化到 localStorage `msz.openTabs`（saveTabs/loadSavedTabs）。

#### 3. 标签编排（src/lib/tabs.ts）
- `DOCS_CHANGED_EVENT='msz:docs-changed'` + `emitDocsChanged()` 供侧栏/标签条刷新；
- `openDocById`（loadDoc→openDoc）、`createDocTab(tplId)`（buildDoc→saveDoc→openDoc）；
- `closeDocTab(id)`：**后台标签摘除不动工作区**；活动标签按「右邻居→左邻居」切换，邻居读盘失败或无邻居时兜底新建空白文档（保持工作区始终有一篇文档）；
- `restoreTabIds()`：启动时读 localStorage 并以 listDocs 校验存在性（失败/空均返回 []）。

#### 4. UI
- **Tabs.tsx**：标签条（role=tablist/tab）；活动标题取 store，后台标题取内存标题缓存（useState Record，订阅 store 实时写）→ 文档库 meta 兜底；点击切换、✕/中键关闭、键盘 Enter。
- **FilterBar.tsx**：标签/状态两个 select（AND），激活时显示命中数（不含根）+ 一键清除；绝对定位画布左上，演示模式隐藏；命令面板加「清除节点过滤」。
- **NodePanel.tsx**：多选（≥2）出现 BatchPanel（批量配色+批量加标签）；单选面板新增「分支颜色」6 色选择器（取当前主题 branch 色 +「默」清除，aria-pressed）。
- **Canvas.tsx**：wheel 按 `e.ctrlKey` 分流 pinch/wheel 系数走 zoomAt；Safari `gesturestart/gesturechange/gestureend`（非标准事件以 EventListener 挂接）；过滤视图在 applyFilter 结果上再叠加搜索临时展开，filter 变化双层 rAF 后 fitView；节点 `<g>` 加 data-node-id/data-color。
- **布局尊重 node.color（src/lib/layout.ts）**：逻辑图/树图/组织图/鱼骨图递归与一级分支均以「显式 node.color 优先、轮转色兜底」；时间轴 LaidNode 同步。数据模型不升版（color 字段 v1 起存在）。
- Sidebar/App/fileHandle/Palette 接线：启动 restoreTabIds→openDoc(active,{tabs})；侧栏打开/新建/还原/删除全部走标签编排；打开 .msz 同 id 重开走 loadDoc 完整替换（openDoc 对同 id 早返回，外部改动否则进不来）。

### 遇到的问题及解决方案
- **关后台标签误建空白文档（编排 bug）**：closeDocTab 初版用 `neighbor===null` 同时表示「关的是最后一个活动标签」和「关的是后台标签」，导致关 A(后台) 后异步冒出空白标签挤掉活动文档 B，E2E 表现为标题断言 flaky（计数断言先过、标题断言等到空白标签建成）。修法：显式区分 wasActive，仅关活动标签才选邻居/建空白；新增 src/lib/tabs.test.ts（vi.mock 隔离 Dexie）5 用例锁定三种路径与 restoreTabIds 过滤。
- **软删当前唯一文档后文档库为 0**：M11 把 Sidebar.remove 改为 closeDocTab 后，无邻居分支早返回漏建兜底空白，回收站还原计数因此少 1。兜底恢复 createDocTab('blank') 后修复。
- **.msz 同 id 重开内容不刷新**：openDoc 见到已打开 id 直接早返回；openMSZCurrent 改为同 id 走 loadDoc（整体替换+重置会话/选择/过滤）。
- **E2E 选择器歧义**：NodePanel 含 20+ 图标 svg，断言画布必须 `svg.canvas-svg`；doc-tab 也是 role=tab，视图切换改用 `getByRole('tab',{name:'甘特',exact:true})`。
- **React 编译器 lint「Cannot access refs during render」**：后台标题缓存初版用 useRef Map 在渲染期读取被判 error，改为 useState Record + 订阅里函数式更新。
- **未保存编辑跨标签丢失风险**：靠 Session.doc 在切走瞬间保存活动文档引用解决；标签持久化只存 id 列表，正文仍以 IndexedDB+防抖自动保存为准。

### 测试结果
- tsc 0 错；lint 0 errors（40 warnings 均为存量 no-non-null-assertion）
- 单测 **263/263，24 文件**（新增 viewport 6、filter 12、docStore.tabs 12、tabs 编排 5、layout 配色 2，共 +37；M10 基线 226）
- E2E **24/24**（新增 tabs 独立撤销/恢复 1、batch 批量配色加标签 1、filter 标签+状态+清除 1、pinch-zoom 1；修复 msz-file/pdf-export/trash 3 个存量回归）
- build **378.48 KB / gzip 126.75 KB**（较 M10 +9.37KB / +2.82KB gzip）

### 范围说明（留待审核确认）
- 思维导图四种布局已尊重 node.color；甘特视图的 `branchColors(doc)`（按 root 子级轮转色，Gantt.tsx）本批未改，批量分支色暂不影响甘特配色，M12 可评估。

---

## M12：国际化 / 大纲内拖拽 / 对齐吸附辅助线

> **状态：已完成** | PRD 4.4（对齐吸附/辅助线 P1、国际化 P1）、PRD 4.1.6（大纲内拖拽排序 P2）| 零第三方依赖

### 阶段目标
1. **国际化（P1）**：zh-CN 默认，文案集中管理，预留 en-US，工具栏可切换；
2. **大纲内拖拽排序（P2）**：HTML5 DnD，支持拖到节点内部（换父）、拖到节点前/后（兄弟排序）；
3. **对齐吸附/辅助线（P1）**：画布拖拽节点时，与其他节点的边/中心对齐（阈值 8px），绘制虚线辅助线。

### 实现内容

#### 1. 国际化（src/i18n/）
- **zh-CN.ts / en-US.ts**：字典对象，key 完全对称（单测 `Object.keys` 比对保证无遗漏）；en-US 为预留完整翻译。
- **index.ts**：`Lang = 'zh-CN'|'en-US'`；`useI18n` zustand store（持久化 `msz.lang`，切换时同步 `<html lang>`）；`t(key, vars?)` 纯函数（`{name}` 占位插值，缺失 key 原样返回便于渐进迁移）；`useT()` hook（订阅 lang 触发重渲染，返回 t）。
- 已接入：Toolbar（视图按钮/文档标题占位/语言切换下拉 `.lang-sel`）、Outline（标题/按钮 title/占位）、FilterBar（标签/状态下拉、命中计数、清除）、Tabs（未命名兜底/关闭 aria-label）。
- 设计取舍：不引入 i18next 等第三方；字典为普通对象 + `Record<keyof typeof zhCN, string>` 类型保证双语 key 对齐；`t` 读 `useI18n.getState().lang`，组件用 `useT()` 订阅即可。

#### 2. 大纲内拖拽（src/components/Outline.tsx + docStore.reparentAt）
- **docStore.reparentAt(id, targetParent, index)**：将节点移到 targetParent 的第 index 个孩子位；targetParent 为 null 表示同父内排序；拒绝移到自身后代、根不可移动；index 越界 clamp 到 `[0, children.length]`；一次快照。
- **Outline.tsx**：行级 `draggable`（根不可拖）；`onDragStart` 设 `application/x-msz-node` 数据；`onDragOver` 按指针 Y 分三段（上 1/4=before、中=inside、下 1/4=after），实时显示放置指示；`onDrop` 调 `reparentAt`（inside→目标父末尾，before/after→同父对应 index）；拖拽中加 `drop-before/drop-after/drop-inside` 样式（accent 色描边/内阴影）。

#### 3. 对齐吸附（src/lib/snap.ts + Canvas）
- **snap.ts 纯函数 computeSnap(dragged, others, dx, dy, threshold=8)**：水平/垂直两轴独立，各比对 left/center/right 三条基准线，取阈值内最近的吸附；返回 `{snapDx, snapDy, guides[]}`（guides 含水平/垂直虚线坐标）。
- **Canvas 集成**：拖拽 onMove 中以主拖节点 laid rect + 当前 dx/dy 调 computeSnap，snapDx/snapDy 叠加到 NodeView/EdgeView 的渲染偏移；辅助线以 `<line strokeDasharray="6 4">` 画在 world `<g>` 内（随视图变换）。仅视觉效果，不写数据模型（自动布局下节点无手动坐标）。

### 遇到的问题及解决方案
- **batch.spec.ts 回归：多选后批量面板不出现**：根因是测试的 `clickEmpty` 从 y=24 起扫空白点，M12 新增语言选择器把工具栏「Ctrl+K」按钮挤到最右，点击误中 Ctrl+K 打开命令面板，`palette-mask` 覆盖画布拦截后续节点点击（表现为 onNodeDown 不触发）。修法：`clickEmpty` 扫描起点改到 y=100（工具栏下方）。教训：E2E「点空白」必须避开工具栏交互区。
- **useT 的 lint「lang 未使用」**：初版 `const lang = useI18n(...)` 仅用于订阅触发重渲染、返回值未消费，被判 no-unused-vars；改为直接调用 `useI18n((s) => s.lang)` 不赋值（zustand 仍会订阅并重渲染）。
- **吸附测试轴歧义**：同高节点中心线对齐时顶/底也必然对齐（偏移量相同），导致辅助线 pos 断言不稳定；改用不同宽高的 rect 使只有目标基准线在阈值内。
- **i18n 字典类型**：`as const` 让 zhCN 值变字面量类型，en-US 无法赋值；改为 `Record<keyof typeof zhCN, string>`。

### 测试结果
- tsc 0 错；lint 0 errors（42 warnings 均为存量 no-non-null-assertion）
- 单测 **276/276，26 文件**（新增 snap 6、i18n 6、docStore.reparentAt 1，共 +13；M11 基线 263）
- E2E **27/27**（新增 m12：i18n 切换持久化 1、大纲拖入换父 1、大纲兄弟排序 1；修复 batch.spec clickEmpty 误触命令面板）
- build **386.49 KB / gzip 129.67 KB**（较 M11 +8.01KB / +2.92KB gzip）

### 范围说明
- i18n 已覆盖主框架（Toolbar/Outline/FilterBar/Tabs）的可见静态文案；节点面板细节、模板名称、错误提示等存量中文文案为渐进迁移预留，key 机制已就绪，后续可按需补字典。
- 甘特视图 `branchColors` 仍未改（同 M11 范围说明）。

---

## M13：甘特表格视图（就地编辑）

> **状态：已完成** | PRD 4.2（甘特表格视图 P1）| 零第三方依赖

### 阶段目标
将甘特左侧「节点/任务」单列扩展为多列表格，支持就地编辑任务字段（开始/结束日期、进度、里程碑、依赖入口），与导图节点 `task` 同源，数据实时写入并持久化。

### 实现内容

#### 1. 表格列结构（Gantt.tsx + styles.css）
- 左侧 `.gantt-left` 宽度由 250px 扩至 560px，采用 CSS Grid 六列：`任务名 | 开始 | 结束 | 进度 | 里程碑 | 依赖`
  - 模板：`minmax(120px, 1fr) 110px 110px 96px 60px 64px`
- 表头 `.gantt-corner.gantt-grid` 渲染 6 个 `.gantt-th`（里程碑/依赖居中）
- 行 `.gantt-row.gantt-grid` 渲染 6 个 `.gantt-cell`，保持行虚拟化（`visibleRows` + 顶/底占位）与滚动同步不变

#### 2. 单元格交互
- **任务名**：保留原有圆点 + 文本 + `＋/📅` 按钮（非任务点「＋」调 `makeTask`，任务点「📅」开 TaskEditor）
- **开始/结束**：`<input type="date">`，`onChange` 调 `setTask(id, {start/end})`；里程碑行结束列显示 `◆` 且禁用编辑；非任务行显示 `—`
- **进度**：`<input type="range" 0..100>` + 百分比文本，`onChange` 写 `progress = value/100`（setTask 内部 clamp 0..1）
- **里程碑**：`<input type="checkbox">`，`onChange` 调 `setTask(id, {milestone})`（setTask 规范化：里程碑仅保留 start）
- **依赖**：按钮显示 `N 项`，点击开 TaskEditor 编辑依赖（依赖编辑复用已有编辑器，不在表格内直接编辑以避循环引用复杂性）
- 所有 `<input>` 的 `onClick` 调 `stopPropagation`，防止触发行选中

#### 3. i18n
- 字典新增 `gantt.colName/colStart/colEnd/colProgress/colMilestone/colDeps/makeTask/editTask/depsCount`，zh-CN/en-US 完全对称
- 甘特原有「今天」「日/周/月」与表格列标题统一走 `useT()`

### 遇到的问题及解决方案
- **React 受控 range 的 E2E 赋值不生效**：直接 `el.value='50'` + dispatch `input/change` 后，React 因内部 value tracker 未更新而保持 0%。改用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` 原生 setter 赋值再 dispatch `input`，React 受控值才更新。
- **行虚拟化下的选择器**：`.gantt-row-name` 类名更名为 `.gantt-row`，同步更新 `perf-large-doc.spec.ts` 的可见行计数断言。

### 测试结果
- tsc 0 错；lint 0 errors（42 warnings 均为存量 no-non-null-assertion）
- 单测 **276/276，26 文件**（无新增单测，setTask 已由 docStore.test.ts 覆盖；表格交互由 E2E 覆盖）
- E2E **28/28**（新增 m13-gantt-table：变为任务→编辑开始日期→拖进度到 50%→勾里程碑→刷新持久化；perf-large-doc 选择器同步更新）
- build **389.18 KB / gzip 130.15 KB**（较 M12 +2.69KB / +0.48KB gzip）

### 范围说明
- 依赖编辑仍走 TaskEditor 弹窗（表格内仅显示数量+入口）；后续可评估在表格内直接编辑依赖链。
- 甘特 `branchColors` 仍未改（同 M11/M12 范围说明）。

---

## M14：甘特关键路径

> **状态：已完成** | PRD 4.2（关键路径 P2）| 零第三方依赖

### 阶段目标
在甘特视图中标注关键路径——依赖网络中工期最长的路径，其任务条以关键色高亮，帮助识别决定项目总工期的任务链。

### 实现内容

#### 1. 关键路径算法（src/lib/gantt.ts · criticalPath）
- 纯函数 `criticalPath(doc): Set<string>`，基于依赖图最长路径（按任务工期加权）：
  - 工期：里程碑 0 天；普通任务 `max(1, end-start)`。
  - `lp[v]` = 以 v 结尾的最长路径长度（含 v 自身工期），按 Kahn 拓扑序 DP。
  - `rp[v]` = 以 v 开头的最长路径长度（含 v 自身工期），按逆拓扑序 DP。
  - v 在某条关键路径上当且仅当 `lp[v] + rp[v] - dur[v] == 全局最长路径长度`。
- 含环时退化为 Kahn 拓扑能覆盖的节点子集（环上节点不参与）；全里程碑或无任务时返回空集。
- 复杂度 O(V+E)。

#### 2. 主题与渲染（theme.ts + Gantt.tsx + styles.css）
- Theme 新增 `critical` 色（light `#B03A2E` / dark `#E06050`），同步 CSS 变量 `--critical`。
- Gantt 组件 `useMemo(() => criticalPath(doc))` 计算关键节点集合；Bar 组件新增 `critical` prop，为真时用 `theme.critical` 覆盖分支色（普通条与里程碑菱形均生效）。
- 时间轴右上角浮动「关键路径」开关（`.gantt-critical-toggle`），默认开启；点击切换 `showCritical` 状态，关闭时所有条恢复分支色。

#### 3. i18n
- 新增 `gantt.criticalPath` key，zh-CN/en-US 对称。

### 遇到的问题及解决方案
- **E2E 条色断言大小写**：主题 critical 色为大写 `#B03A2E`，SVG `fill` 属性保留大写，初版用小写 `#b03a2e` 严格匹配得到 0。改为 `toLowerCase()` 比较。
- **多 E2E 串行时 selectNode 找不到节点**：m13 用例结束时停在甘特视图，m14 重置后新建空白文档，导图首次渲染略慢，`selectNode` 中 `svg g[role=button]` 尚未挂载。修法：新建文档后显式 `waitFor` 根节点再 selectNode（m13、m14 均补）。

### 测试结果
- tsc 0 错；lint 0 errors（50 warnings 均为存量 no-non-null-assertion，含 criticalPath 内部 8 处）
- 单测 **282/282，26 文件**（新增 criticalPath 6：空集/单任务/串行链/菱形选长支/里程碑零工期/双等长路径；M13 基线 276）
- E2E **29/29**（新增 m14-critical-path：建 A→B 依赖链→关键路径条为 critical 色→开关关闭恢复分支色→再开恢复；m13/m14 补 waitFor 修串行竞态）
- build **390.60 KB / gzip 130.65 KB**（较 M13 +1.42KB / +0.50KB gzip）

### 范围说明
- 关键路径高亮为纯视觉（不改数据模型）；后续可叠加「关键路径总工期」数值展示与基线对比。
- 依赖类型一律按 FS（完成后才开始）处理最长路径；SS/FF/SF 暂未区分。

## M15：版本历史 / 快照回滚

> **状态：已完成** | PRD 4.3（版本历史 P2）| 零第三方依赖

### 阶段目标
为每个文档自动保存历史快照，支持在侧边栏浏览版本列表并一键回滚到任意历史版本。

### 实现内容

#### 1. 数据层（src/store/db.ts）
- Dexie schema 升至 `version(6)`，新增 `docVersions: 'id, docId, createdAt'` 表。
- 新增接口 `StoredDocVersion`（id / docId / title / createdAt / payload）与 `DocVersionMeta`（不含 payload）。
- `saveDoc` 末尾 best-effort 调用 `snapshotVersion(doc)`：
  - **节流**：同文档两次快照最小间隔 `VERSION_MIN_INTERVAL_MS = 5 分钟`，内存 `lastVersionAt: Map<docId, ts>` 记录上次快照时间，避免每次保存都查库。
  - **保留上限**：每文档最多 `VERSION_MAX_PER_DOC = 50` 个版本，超限时 `bulkDelete` 最旧版本。
  - 失败仅 `console.warn`，不阻断主保存流程。
- 导出函数：
  - `listVersions(docId)`：返回版本元信息，按 `createdAt` 倒序。
  - `loadVersion(versionId)`：读取单版本 payload 并经 `migrateDoc` 迁移（保证向前兼容）。
  - `restoreVersion(versionId)`：用快照内容覆盖 docs 表、更新 `updatedAt`、刷新节流标记（防回滚后立即又产快照），返回迁移后的文档。
  - `deleteVersion(versionId)`：删除单个快照。
  - `__resetVersionThrottle()`：测试钩子，清空节流记忆。
- **级联清理**：`deleteDoc` / `purgeDoc` / `emptyTrash` / `sweepTrash` 事务内同步删除对应文档的全部 `docVersions`，杜绝孤儿快照。

#### 2. UI（src/components/VersionHistory.tsx + Sidebar.tsx + styles.css）
- 新增 `VersionHistory` 模态：列出某文档的版本（标题 + 格式化时间），支持「恢复」「删除」单个版本。
  - 恢复经 `window.confirm` 二次确认；成功后调用 `useDoc.getState().loadDoc(restored)` 用历史内容替换内存中的活动文档。
- Sidebar 文档列表项新增「⟳」历史按钮（`.sb-history`），点击打开对应文档的版本历史模态。
- 新增 CSS：`.modal-mask / .modal / .modal-head / .modal-body` 通用模态骨架，`.vh-*` 版本列表样式。

#### 3. i18n
- 新增 `history.title / empty / restore / restoreConfirm / restoreFailed / deleteConfirm`，zh-CN/en-US 对称。

### 遇到的问题及解决方案
- **单测 Dexie mock 被 `useDefineForClassFields` 覆盖**：db.ts 中 `docs!: Table` 等声明字段在 `useDefineForClassFields: true` 下会在构造时置 `undefined`，覆盖我在 FakeDexie 原型上定义的 getter。修法：`stores()` 中直接把表挂到实例自身属性（`this[name] = new FakeTable(name)`），不走原型 getter。
- **`no-this-alias` / `no-unused-vars` lint**：mock 内 `const self = this` 与 `_name`/`_n` 形参触发 lint。修法：用箭头函数捕获 `this`、移除未用形参。
- **`react-hooks` 规则禁止 effect 内同步 setState**：`refresh()` 在 effect 内调用并 `setLoading(true)` 被规则拦截。修法：初始 `loading=true`，effect 内用 `async load()` + `active` 标志，setState 全部放到 `await` 之后。
- **E2E 版本数非确定**：编辑触发 700ms 防抖自动持久化，会在两次显式 `saveDoc` 之间多产一个版本，导致 `toHaveCount(2)` 不稳定。修法：用 `expect.poll(count).toBeGreaterThanOrEqual(2)`，并在页面内遍历版本找到含 "Original" 节点的旧版本恢复，而非依赖固定索引。
- **E2E 编辑已有节点**：`selectNode` 仅选中不进入编辑；需额外 `F2` 才弹出 `textarea.node-editor`（与 crash-recovery.spec 一致）。

### 测试结果
- tsc 0 错；lint 0 errors（50 warnings 均为存量 no-non-null-assertion）
- 单测 **287/287，27 文件**（新增 versions.test.ts 5：首存产快照 / 5 分钟内节流 / reset 后产第二快照 / restoreVersion 覆盖 docs / deleteDoc 级联清版本）
- E2E **30/30**（新增 m15-history：建文档→加 "Original" 子节点→保存→改 "Modified"→保存→开历史面板≥2 条→恢复含 Original 的旧版本→画布节点回退为 Original）
- build **394.75 KB / gzip 131.81 KB**（较 M14 +4.15KB / +1.16KB gzip）

### 范围说明
- 版本快照存完整文档 JSON（含 nodes/relations 等），单文档上限 50 个；超大文档的版本体积后续可考虑增量 diff。
- 节流记忆为进程内 Map，刷新后首次保存必产快照（可接受）。
- 版本表与 docs 表独立；`moveToTrash` 保留版本（软删可还原），永久删除时级联清理。

## M16：甘特任务字段增强（优先级/负责人/备注）+ CSV 导出

> **状态：已完成** | PRD 4.2（任务字段 P1、CSV 导出 P1）| 零第三方依赖

### 阶段目标
扩展甘特任务字段：增加**优先级**（无/低/中/高）、**负责人**、**任务备注**，并在表格视图就地编辑；CSV 导出补齐新列并修正进度百分比。

### 实现内容

#### 1. 数据模型（src/types.ts · TaskData）
- 新增可选字段：`priority?: 0|1|2|3`（0=无 1=低 2=中 3=高）、`owner?: string`、`note?: string`。
- 不升文档版本号（task 为节点可选扩展字段，旧数据天然兼容）。

#### 2. Store（src/store/docStore.ts · setTask）
- **里程碑分支保留新字段**：原实现里程碑只保留 `{milestone,start,progress,deps}`，会丢弃 priority/owner/note；现显式保留三者。
- **空任务判定放宽**：原 `empty = !start && !milestone` 会把仅设置优先级/负责人的任务移除；现扩展为 `!start && !milestone && !priority && !owner && !note`。

#### 3. 表格视图（src/components/Gantt.tsx + styles.css）
- `.gantt-grid` 栅格由 6 列扩至 8 列：`任务名|开始|结束|进度|里程碑|依赖|优先级|负责人`。
- 优先级列：`<select>`（无/低/中/高），`onChange` 写 `setTask({priority})`。
- 负责人列：`<input type="text">`，`onChange` 写 `setTask({owner})`。
- 新增 `.gantt-priority` / `.gantt-owner` 样式（与 `.gantt-date` 一致的表格内控件风格）。

#### 4. 任务编辑器备注（src/components/TaskEditor.tsx + styles.css）
- 在依赖区下方新增「备注」`<textarea>`（`.te-note`），写 `setTask({note})`。

#### 5. CSV 导出（src/lib/openFormats.ts · toGanttCSV）
- 表头新增 `优先级 / 负责人 / 备注` 三列；进度由原值（0–1）改为 `Math.round(progress*100)` 输出百分比（修正旧 bug）。
- 依赖列分隔符由 `, ` 改为 `; `，避免与 CSV 列分隔符歧义。

#### 6. i18n
- 新增 `gantt.colPriority / colOwner / priorityNone / priorityLow / priorityMedium / priorityHigh / ownerPlaceholder`，zh-CN/en-US 对称。

### 遇到的问题及解决方案
- **setTask 里程碑分支丢字段**：原里程碑归一化硬编码字段白名单，新增 priority/owner/note 后被静默丢弃。修法：在里程碑对象字面量中显式列出三字段。
- **仅设优先级的任务被误删**：empty 判定只看 start/milestone，导致无日期但有优先级的任务被置 `undefined`。修法：把 priority/owner/note 纳入非空判定。
- **CSV 进度列输出 0–1 小数**：旧实现 `String(progress)` 直接输出 0.5 而非 50%。修法：`Math.round(progress*100)`，同步修正测试 fixture（`progress: 50` → `0.5`）。

### 测试结果
- tsc 0 错；lint 0 errors（50 warnings 均为存量 no-non-null-assertion）
- 单测 **288/288，27 文件**（docStore 新增「里程碑保留优先级/负责人/备注」「仅优先级保留 task」2 用例；openFormats.toGanttCSV 3 用例更新为 10 列表头）
- E2E **31/31**（新增 m16-gantt-fields：变任务→设优先级高→填负责人→写备注→导出 CSV 含三字段）
- build **396.58 KB / gzip 132.20 KB**（较 M15 +1.83KB / +0.39KB gzip）

### 范围说明
- 优先级/负责人仅用于展示与导出，暂未参与排序、筛选或关键路径计算；后续可叠加「按优先级/负责人排序与过滤」。
- 任务备注为纯文本（区别于节点富备注 richNote）；若需富文本可复用 NoteEditor。
- CSV 依赖列输出前置任务**文本**（非 id），重名不做消歧；如需精确对应可追加 id 列。

## M17：Cat-Thinking 原生文档导入与内容提取

> **状态：已完成** | 单体内建能力 | 支持 TXT、Markdown、文本型 PDF、DOCX

### 阶段目标

建立稳定的“来源文档”边界：用户导入普通文档后，先本地提取与预检，再创建可编辑导图；完整原文、节点出处和导图分开持久化，为后续一次分析生成摘要/大纲/导图/题目/知识拓展及节点 AI 提供统一输入。

### 实现内容

1. `SourceDocument` / `SourceAnchor`：保存规范化原文、提取器版本、文件元数据和节点到原文字符区间的引用。
2. `documentExtractors.ts`：统一格式检测和解析器注册；TXT/Markdown 直接解析，PDF/DOCX 动态加载，避免增加首屏依赖。
3. `pdfExtractor.ts`：基于 PDF.js 在浏览器内提取文本、恢复行、清理页边缘页码、限制 200 页，并把节点锚点关联到页码；扫描件给出明确 OCR 提示。
4. `docxExtractor.ts`：直接解析 OOXML；保留标题层级、段落和表格文本。解压前检查路径穿越、分卷、加密、压缩方式、条目数、展开体积和异常压缩比，并拒绝 XML 实体声明。
5. 安全与性能边界：源文件 5MB、提取文本 200 万字符、初始导图 400 节点；节点超限只截断草稿，完整原文仍保留。
6. Dexie schema v7 新增 `sources` 表；`saveDocumentBundle` 原子替换文档与完整来源集合；永久删除时与 blob、版本快照一并清理。
7. `DocumentImportDialog`：展示格式、文件、推断标题、字符/章节/段落/节点统计、一级结构和警告，确认后才落盘；提取期间禁用重复提交。
8. 原有“导入导图”与“从文档生成”分流；JSON/.msz 无损备份包含 `_sources`，导入时严格校验锚点和大小。
9. 修复同 ID 备份导入命中旧标签会话的问题；修复已有 E2E 中的 lint 与定位脆弱性。

### 为什么采用独立来源表

- 导图每次编辑不重复序列化大段原文，保持自动保存轻量。
- 文档解析、AI 分析和可编辑导图解耦；后续增加 OCR、图片或 Word 旧格式时，只需注册新提取器，不改编辑器。
- 摘要、题目、知识扩展和节点解释都可回指同一 `sourceId + anchor`，避免生成结果失去证据来源。
- JSON/.msz 仍能完整交付，软删除/永久删除/版本历史各自有清晰生命周期。

### 验收结果

- 单元测试覆盖文本规范化、Markdown/TXT 建图、PDF 行恢复与页码清理、DOCX 标题/段落/表格、压缩包路径穿越、XML 实体、来源导入校验、悬空锚点清理和生命周期。
- E2E 覆盖 TXT、DOCX、文本型 PDF 的“选择文件 → 本地提取 → 预检 → 创建导图 → 来源持久化”；PDF 额外校验页码锚点。
- PDF/DOCX 为独立异步 chunk；普通编辑和 TXT/Markdown 导入不加载解析器主体。
- 完整阶段规划见 `../reports/CAT_THINKING_NATIVE_KNOWLEDGE_WORKSPACE_PLAN_2026-10-09.md`，最终测试数字见同目录阶段实施测试报告。

### 当前范围

- PDF 仅支持自带文本层的文件；扫描件和图片 OCR 放在后续独立提取器阶段。
- DOCX 当前提取正文结构与表格文本，不处理批注、修订、页眉页脚和嵌入对象。
- 当前生成的是确定性结构草稿，不假装进行 AI 语义分析；统一分析任务在下一阶段实现。

