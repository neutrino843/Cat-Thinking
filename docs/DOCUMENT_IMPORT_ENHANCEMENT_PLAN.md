# 文档导入功能增强与性能优化技术方案

> 版本：v1.1（实施后校准）
> 日期：2026-10-14
> 状态：**PPTX、25MB 上限、OOXML Worker、队列与进度已实现并完成自动化验收**
> 当前限制：扫描版 PDF 暂无 OCR；PPTX 演讲者备注不提取

---

## 1. 背景与目标

对现有「从文档生成导图」导入功能做增强与性能优化：

| # | 需求 | 现状核实结论 |
|---|------|--------------|
| 1 | 新增 .pptx / .pdf 解析 | **PDF 已完整支持**（pdfjs-dist 4.8.69，含页锚点、扫描件检测、e2e 用例与 fixture）；**PPTX 为本次真实新增点** |
| 2 | 单文件 5MB→25MB、异步解析、进度反馈 | 本项目为**纯浏览器本地解析**架构，无上传环节；文件通过 `arrayBuffer()` 一次读取，OOXML 由 Worker 异步解压并回传进度；分析侧已有的分片上传协议（`uploadSourcePartSchema`）保持复用 |
| 3 | 参考飞书/腾讯文档/Notion，用生产验证的开源组件 | pdfjs-dist（Mozilla，Firefox 内嵌 PDF 引擎）保留；PPTX 选型见第 3 节 |
| 4 | 流式解析、导入队列、格式前置校验、损坏容错、友好提示 | 逐项落实，见第 5、7 节 |
| 5 | 交付完整技术方案并据此开发 | 方案已落地；本文档同步记录最终实现边界 |

---

## 2. 现状架构调研结论

### 2.1 导入链路（全浏览器本地，不经服务端）

```
入口 A：Sidebar「从文档生成导图」
  input[type=file] accept=".txt,.md,.markdown,.pdf,.docx,.pptx…"
  → 多文件导入队列 → prepareDocumentImport(file)
入口 B：学习首页「导入资料」
  input[type=file] accept=".txt,.md,.markdown,.docx,.pdf,.pptx"（支持多选）
  → 多文件导入队列 → prepareDocumentImport(file)
        ↓ 共用
prepareDocumentImport(file)
  → extractDocument(file)
      ① 大小硬限制：MAX_SOURCE_BYTES = 25MB
      ② detectSourceKind：扩展名+MIME 白名单与内容前置校验
      ③ 按 kind 分发（PDF/DOCX/PPTX 动态加载，OOXML 解压进入 Worker）
  → buildDraft()：文本 → 标题/段落条目 → 导图节点 + anchors + locators
      （MAX_DRAFT_NODES=400，locators 上限 20k，页锚点复用 PDF pageSpans 机制）
  → DocumentImportDialog 预览确认 → saveDocumentBundle → Dexie(IndexedDB 'maosizhi' .sources)
```

### 2.2 已有的关键能力（直接复用，不重复建设）

| 能力 | 位置 | 说明 |
|------|------|------|
| PDF 解析 | `src/lib/extractors/pdfExtractor.ts` | pdfjs-dist + Web Worker、`%PDF-` 魔数校验、逐页提取、页码锚点 pageSpans、200 页上限、扫描件友好报错 |
| OOXML zip 防护 | `src/lib/extractors/docxExtractor.ts` `inspectDocxArchive` | 中央目录检查：路径穿越、加密包、条目数、单条目 16MB、解压总量 32MB、压缩比 200:1（zip bomb） |
| XML 结构化 | 同上 `docxXmlToStructuredText` | DOMParser + 命名空间无关解析、DOCTYPE/ENTITY 拒绝、损坏检测 parsererror |
| 分片上传协议 | `packages/analysis-contracts/src/sources.ts` `uploadSourcePartSchema` | partIndex/partCount/部分哈希/512KB 分片 + sourceReceipt——分析侧大文本上传已有分片机制 |
| e2e 与 fixture | `e2e/document-import.spec.ts` + `scripts/generate_document_fixtures.py` | fixture 生成 + SHA-256 manifest 校验 + IndexedDB 持久化断言 |

### 2.3 契约层约束（本方案必须触达）

- `sourceKindSchema = z.enum(['text','markdown','pdf','docx','pptx'])`，已包含 PPTX
- `sourceSnapshotSchema`：`charCount ≤ ANALYSIS_LIMITS.maxSourceCharacters (2,000,000)`；PDF 与 PPTX 强制 `pageCount`
- Dexie 存储 `SourceDocument version 1` 无 schema 迁移问题；前端 `SourceKind`（`src/types.ts L133`）为 TS 联合类型

---

## 3. 技术选型

### 3.1 PDF —— 保留现有 pdfjs-dist，不更换

pdfjs-dist 是 Mozilla 维护的浏览器 PDF 解析事实标准（Firefox 内嵌 PDF 查看器同源代码），飞书/Notion 的浏览器端 PDF 文本提取同样基于它或同类方案。当前实现已覆盖魔数校验、页锚点、空页/扫描件告警，**本次仅增补进度回调，不更换组件**。

### 3.2 PPTX —— fflate + DOMParser 自建薄提取层（复用 DOCX 基建）

| 候选 | 结论 | 理由 |
|------|------|------|
| **fflate（已在依赖中）+ DOMParser（浏览器原生）** | **选用** | fflate 是生产验证最广的轻量 zip/inflate 库（速度为 JSZip 的 3-5 倍、零依赖），本项目 DOCX 解析已在用且带完整安全防护；PPTX 与 DOCX 同为 OOXML zip，提取层只需 ~200 行：解压 → 按 `sldIdLst` 顺序遍历 `ppt/slides/slideN.xml` → 提取 `a:t` 文本与占位符类型 |
| officeparser | 否决 | Node.js-only（依赖 Node 流/fs），无法在浏览器懒加载 |
| pptx2md | 否决 | Python 工具，非浏览器运行时 |
| JSZip | 否决 | 功能等价但性能低于 fflate，且会引入重复依赖 |
| pptxjs / pptx-preview | 否决 | 面向幻灯片「渲染预览」的 jQuery 系组件，非文本提取 |

不重复造轮子的界定：ZIP 解压、PDF 解析均采用成熟开源组件；`a:t` 文本提取无现成浏览器端纯库可用（现有库均为渲染向），自建提取层与现有 DOCX 提取层同一模式、同一防护标准，属于必要的薄胶水层。

### 3.3 解析运行时 —— Web Worker 化

- 改造前：pdfjs 已在自有 Worker 中运行；DOCX 的 fflate 解压位于主线程。
- 当前实现：共享 OOXML 解压 Worker（`src/lib/extractors/ooxmlWorker.ts`）承担 CPU 较重的解压，结构化 XML 解析回到主线程 DOMParser。DOCX 与 PPTX 均复用该 Worker。
- 内存控制：沿用既有防护（解压总量 ≤32MB、单条目 ≤16MB、压缩比 ≤200:1），25MB 文件解压后峰值内存约 60MB（原始 bytes + 解压产物），在浏览器合理阈值内；Worker 中途抛错即可整体释放。

---

## 4. 总体设计

### 4.1 新导入流水线

```
用户选择/拖入文件（支持多选）
  → importQueue.enqueue(files)                【新增：全局串行队列】
      队列逐个出队 → extractDocument(file, onProgress)
          phase reading  （File → ArrayBuffer，按 4MB 分块拼接，进度 0-20%）
          phase parsing  （PDF: 页 n/N；PPTX: 幻灯片 n/N；DOCX: 解压+XML）  进度 20-85%
          phase structuring（buildDraft：节点/锚点/定位器）                  进度 85-100%
      → 解析成功：draft 入草稿队列，逐个弹出 DocumentImportDialog 确认（交互结构不变）
      → 解析失败：不中断队列，收集错误逐条友好提示
```

### 4.2 PPTX 提取设计

- **识别与前置校验**：扩展名/`.pptx` MIME + ZIP 魔数 `PK\x03\x04` + 必须含 `[Content_Types].xml` 与 `ppt/presentation.xml`（与 DOCX 互斥区分，防伪装文件）。
- **幻灯片顺序**：解析 `ppt/presentation.xml` 的 `sldIdLst` + `ppt/_rels/presentation.xml.rels` 得到真实播放顺序；rels 缺失或不可解析时回退为文件名数字排序，并追加 warning。
- **文本提取**：每个 slide 提取 `a:t` 文本，`a:br` 转换行；`ph type="title|ctrTitle"` 占位符文本 → 一级标题（`# `），其余文本框 → 段落；输出 `structure:'markdown'`（复用 DOCX 的标题推断链路）。
- **备注页**：`notesSlides` 默认**不提取**（避免演讲备注污染导图结构），在支持文案中注明。
- **页锚点**：每张幻灯片产出 `pageSpans`（page=幻灯片序号），复用 PDF 的 page locator 机制；契约层对 pptx 同样要求 `pageCount`（=幻灯片数）。
- **防护**：泛化 `inspectDocxArchive` → `inspectOoxmlArchive(bytes, {requiredEntry})`，DOCX/PPTX 共用全部安全检查；空 PPTX（无任何文本）报「未提取到文本」友好错误。
- extractor 标识：`cat-pptx-ooxml-v1`。

### 4.3 容量与性能设计

| 项 | 现值 | 调整 | 依据 |
|----|------|------|------|
| 单文件上限 MAX_SOURCE_BYTES | 5MB | **25MB** | 对齐飞书文档（网页版导入单文件 ≤100MB 级）、Notion（单文件 100MB 级）与腾讯文档通用档位的中位保守值；25MB 在纯浏览器本地解析下内存可控 |
| 文本上限 MAX_SOURCE_CHARS | 2,000,000 | **保持** | 与 `ANALYSIS_LIMITS.maxSourceCharacters` 一致（分析服务硬约束），超限继续给「拆分后导入」提示；25MB 文本型文档正文通常 1-3M 字符，2M 上限覆盖绝大多数真实文档 |
| PDF 页数上限 | 200 页 | 保持 | 25MB 文本型 PDF 超 200 页时给截断 warning（现状行为），扫描件本就无文本层 |
| 解析线程 | 主线程（DOCX） | **Worker** | 见 3.3 |
| 读取方式 | file.arrayBuffer() 一次性 | 保持一次性（25MB Uint8Array 无压力）+ Worker 内解析 | File.slice 分块拼接反而增加拷贝；真正的内存风险点由既有解压防护兜底 |
| 导入并发 | 用户触发多次可并发 | **队列串行（并发=1）** | 防止多文件同时解析耗尽内存 |

---

## 5. 模块改造点清单

| # | 文件 | 变更 |
|---|------|------|
| 1 | `packages/analysis-contracts/src/sources.ts` | `sourceKindSchema` 增加 `'pptx'`；`superRefine` 增加规则：kind='pptx' 时 `pageCount` 必填（对齐 PDF 规则） |
| 2 | `src/types.ts` | `SourceKind` 联合类型增加 `'pptx'` |
| 3 | `src/lib/documentExtractors.ts` | `MAX_SOURCE_BYTES` → 25MB；`detectSourceKind` 增加 pptx 分支（扩展名 + MIME `application/vnd.openxmlformats-officedocument.presentationml.presentation`）；`extractors` 注册懒加载 pptx；`extractDocument(file, onProgress?)` 增加进度回调参数 |
| 4 | **新增** `src/lib/extractors/pptxExtractor.ts` | 第 4.2 节全部逻辑 + 单测 `pptxExtractor.test.ts` |
| 5 | **新增** `src/lib/extractors/ooxmlWorker.ts` | 共享解压 Worker（fflate unzip + 中央目录检查在 Worker 内执行）；`docxExtractor.ts` 改为经 Worker 解压（DOMParser 结构化留在主线程） |
| 6 | `src/lib/extractors/docxExtractor.ts` | 接入共享 Worker；`inspectDocxArchive` 泛化为 `inspectOoxmlArchive` 导出共用 |
| 7 | **新增** `src/lib/importQueue.ts` | 串行导入队列（并发=1；状态 queued/parsing/done/failed；可清空尚未开始的任务；进行中任务不可取消） |
| 8 | `src/components/Sidebar.tsx` | input 增加 `.pptx` 与对应 MIME、增加 `multiple`；接 importQueue；importing 态展示当前任务进度 |
| 9 | `src/components/learning/LearningHome.tsx` | 同上（accept、multiple、队列、进度） |
| 10 | `src/components/DocumentImportDialog.tsx` | `kindLabel` 增加 PPTX；对话框顶部展示解析进度/排队态（不改弹窗交互结构） |
| 11 | `src/i18n/zh-CN.ts` / `en-US.ts` | `import.currentSupport` 文案更新（加入 PPTX）；新增：超过 25MB、排队中、解析进度、PPTX 专属错误（加密/损坏/无文本/伪装文件）文案 |
| 12 | `styles.css` | 新增 `.import-progress*` 进度条样式（沿用 tokens 变量、受 prefers-reduced-motion 管控） |
| 13 | `src/lib/documentImport.test.ts` | 5MB 断言 → 25MB；补 pptx 拒绝场景 |
| 14 | `scripts/generate_document_fixtures.py` | 用 python-pptx 生成 `structured-course.pptx`（含标题占位符 + 多页正文）与 `corrupt.pptx`（截断文件） |
| 15 | `e2e/fixtures/documents/manifest.json` + `expected.json` | 登记 pptx fixtures（bytes + sha256） |
| 16 | `e2e/document-import.spec.ts` | 新增 PPTX 全链路用例 + 多文件队列用例（第 8 节） |

---

## 6. 接口变更说明

### 6.1 函数签名（前端内部）

```ts
// documentExtractors.ts
type ImportProgressPhase = 'reading' | 'parsing' | 'structuring'
type ImportProgress = { phase: ImportProgressPhase; ratio: number; detail?: string }
export async function extractDocument(file: File, onProgress?: (p: ImportProgress) => void): Promise<ExtractedDocument>
// ExtractedDocument 不变；pptx 返回 kind:'pptx'、structure:'markdown'、pageSpans=幻灯片锚点

// importQueue.ts（新增）
export const importQueue = {
  enqueue(files: File[]): void            // 入队，逐个串行解析
  cancelQueued(): void                     // 清空尚未开始任务，不中断当前解析
  subscribe(listener): () => void          // UI 订阅状态/进度
}
```

### 6.2 契约变更（analysis-contracts）

- `sourceKindSchema`：`['text','markdown','pdf','docx']` → 追加 `'pptx'`（枚举扩展，向后兼容）。
- `sourceSnapshotSchema.superRefine` 新增：`kind === 'pptx' && pageCount === undefined` → 校验错误（对齐 PDF 既有规则）。
- `ANALYSIS_CONTRACT_VERSION` 不变（无字段增删，仅枚举值扩展）。
- **部署顺序约束**：枚举扩展后，旧版服务端 zod strict 会拒绝 kind='pptx' 的快照；因此**先发布契约+服务端构建，再发布前端**。本项目桌面包（desktop:package）前后端一体打包，天然满足顺序；纯 Web 部署场景按上述顺序执行。

### 6.3 存储层（Dexie）

无 schema 迁移。`SourceDocument` 复用 version 1：pptx 来源的 `kind='pptx'`、`extractor='cat-pptx-ooxml-v1'`、anchors/locators 的 page 字段承载幻灯片序号。

### 6.4 i18n 新增 key（节选）

```
import.queue.pending / import.queue.current / import.progress.parsing
import.error.tooLarge（含 25MB）/ import.error.pptxEncrypted / import.error.pptxCorrupt
import.error.pptxNoText / import.error.disguisedFile
import.currentSupport（更新：加入 PPTX）
```

---

## 7. 边界场景处理矩阵

| 场景 | 行为 |
|------|------|
| >25MB 文件 | 选择后立即拒绝，提示上限与当前文件大小（不进入解析） |
| 伪装扩展名（docx→pptx 改名 / txt→pdf） | 魔数 + 必备条目校验拒绝，报「文件内容与格式不符」 |
| 加密 PPTX/DOCX | 既有 `不支持加密` 检查，文案按格式区分 |
| 损坏 ZIP / 截断文件 | 中央目录缺失/条目损坏既有报错；DOMParser parsererror → 「文件已损坏」 |
| zip bomb / 路径穿越 / 超压缩比 | 既有 inspectOoxmlArchive 防护，行为不变 |
| PPTX 全部幻灯片无文本 | 报「未提取到文本」+ 引导（可能是纯图片页） |
| 部分幻灯片无文本 | 正常导入，warning「n 页未提取到文本」（对齐 PDF 空页行为） |
| >200 页 PDF / 超大条目 | 既有截断 warning / 单条目 16MB 拒绝，不变 |
| 文本超 2M 字符 | 「请拆分后导入」友好提示（不变） |
| 清空排队项 | `cancelQueued` 清除尚未开始的任务；进行中的解析继续完成 |
| 批量多选混合成败 | 逐个解析逐个确认；失败项收集汇总，不阻塞后续 |
| Safari/Firefox 兼容 | DOMParser/File.slice/DedicatedWorker 均为基线 API；pdfjs worker 已验证 |

---

## 8. 兼容性测试用例

### 8.1 单元测试（vitest）

1. detectSourceKind：.pptx 正识别；.pptm/.ppt（旧二进制格式）拒绝并提示「请另存为 .pptx」
2. pptxExtractor：标题占位符→heading、正文框→段落、幻灯片顺序遵循 sldIdLst（含乱序命名 fixture）、rels 缺失回退数字排序 + warning、备注不提取、空 PPTX 报错
3. 安全：加密 PPTX、损坏中央目录、路径穿越条目、超压缩比、伪装 DOCX、`<!ENTITY` XML 全部拒绝
4. 大小边界：25MB 整通过、25MB+1B 拒绝（更新原 5MB 断言）
5. 进度回调：phase 序列 reading→parsing→structuring 单调递增且终值 1
6. 队列：3 任务串行（并发=1）、失败不阻塞、cancelQueued 只清理排队项
7. 契约：pptx 快照无 pageCount 被拒；有 pageCount 通过；旧四类 kind 回归不变

### 8.2 E2E（playwright，复用现有 fixture 体系）

1. PPTX 全链路：fixture 导入 → 对话框显示 PPTX/页数 → 创建 → 导图含两章标题 → IndexedDB sources.text 含关键文本、anchors.page 含幻灯片序号 → 刷新恢复
2. 多文件队列：一次选 TXT+PPTX，断言队列态文案与逐个弹窗确认次序
3. 损坏 PPTX fixture：报错文案断言且不创建草稿（对齐 scannedPdf 用例模式）
4. 25MB 边界已由单元测试覆盖；导入期间主线程响应探针尚未纳入本轮 E2E，列入发布前补充项
5. 回归：现有 TXT/DOCX/PDF/扫描 PDF 四用例原样通过

### 8.3 手动兼容矩阵

发布前仍需在 Chrome / Edge / Firefox / Safari 最新两个大版本及桌面包（Chromium WebView）分别导入 TXT/MD/PDF/DOCX/PPTX，验证进度、失败提示和持久化；当前自动化结果不能替代该兼容矩阵。

---

## 9. 实施阶段与完成状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 契约 | 改动点 #1、#2 + 契约单测 | ✅ 已完成 |
| P2 解析内核 | #3、#4、#5、#6 + 单测（Worker 化、pptx 提取、25MB） | ✅ 已完成 |
| P3 队列与进度 | #7 + #3 的 onProgress 接线 + 单测 | ✅ 已完成 |
| P4 UI 与文案 | #8-#12 | ✅ 已完成 |
| P5 测试与 fixture | #13-#16 + 自动化矩阵 | ✅ 已完成；跨浏览器与干净安装仍按发布门槛执行 |

每阶段完成即运行 `npm run typecheck` + `npm run test` + 相关 e2e，最后输出执行报告（独立文件夹）。

## 10. 上线与回滚预案

**上线顺序**：P1 契约构建通过 → 服务端/桌面包构建 → 前端构建 → 冒烟（fixtures 三格式 + pptx）→ 全量。Web 场景必须服务端先于前端（6.2 部署顺序约束）。

**回滚预案**：
- 按 P1-P5 独立提交逐段 `git revert` → `npm run build:contracts && npm run build && npm run build:service` 重新构建部署；无需数据迁移。
- 回滚后已导入的 PPTX 文档：导图与全文完整保留于 IndexedDB（前端运行时不做 kind 校验），仅「来源」徽标因旧 enum 无 pptx 映射显示为空——属可接受降级，报告附用户说明；如需彻底清理，提供手写删除指引。
- 风险监控建议：后续如加入本地 debug 统计，再观察导入成功率与解析耗时 p95；当前实现未加入 `console.time` 或网络上报。

## 11. 已落地的默认决策

| # | 问题 | 默认建议 |
|---|------|----------|
| 1 | 多文件导入交互：一次选多文件后**逐个弹窗确认**（交互结构不变），还是批量自动全部创建？ | 逐个确认（默认，零交互改动） |
| 2 | PPTX 演讲者备注是否提取？ | 不提取（默认，避免污染导图结构） |
| 3 | 25MB 与 2M 字符上限并存：超 2M 字符仍为硬错误 | 保持硬错误（与分析服务约束一致） |
