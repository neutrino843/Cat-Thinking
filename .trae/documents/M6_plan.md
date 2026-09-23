# M6 实施计划 · 数据安全与开放（含 Playwright E2E 基建）

> 里程碑定位：MVP（M1–M5）后第一阶段。用户已确认范围方向＝**数据安全与开放**，并确认 **M6 引入 Playwright 正式 E2E**。
> 执行方式：按 P1→P6 顺序实施，每个检查点 C1–C5 实测通过后才进入下一阶段；TodoWrite 跟踪进度。

## 一、仓库调研结论

### 当前阶段
- M1–M5 全部交付（v0.3.0）：55/55 单测、覆盖率 92.56%、构建 301.93KB/gzip102.66KB，浏览器实测零 error。
- PRD §7 列明的 MVP 后 Backlog 中，本阶段兑现 §4.3 的 **回收站（P1）、备份提醒（P1）** 与 §4.2/§4.3 的 **Markdown / CSV 开放格式（P1）**，并落实 §6.1 已定选型的 **Playwright E2E**，结清测试报告 R-1（导出产物未校验）、R-4（崩溃恢复无端到端验证）。

### 现状关键事实
- [db.ts](file:///d:/猫思之/src/store/db.ts)：Dexie `maosizhi`，当前 schema version(2)＝docs + templates；`deleteDoc` 为**硬删除**（无恢复路径）。
- [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx)：删除走 `window.confirm` + `deleteDoc`；删完加载其余文档或新建 blank。
- [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts)：json/svg/png 三种；`download()` 文件名**未做非法字符清洗**（M6 顺带修）；`parseImported` 仅认 JSON。
- [persist.ts](file:///d:/猫思之/src/store/persist.ts)：700ms 防抖 + beforeunload/visibilitychange flush，写 `msz.lastDoc`；崩溃恢复链路代码就绪但从未有 E2E 证明。
- [App.tsx](file:///d:/猫思之/src/App.tsx#L28-L44)：启动按 lastDoc→最新文档→welcome 兜底；lastDoc 失效时已能 fallback。
- [types.ts](file:///d:/猫思之/src/types.ts)：DocData version=1，节点含 note/href/task（deps 四类型）；M6 不改文档模型（开放格式是外部表示）。
- 无任何 E2E 设施；happy-dom 无 IndexedDB，db 操作按项目铁律**不写 Vitest 单测**，由 Playwright 覆盖。
- dev server 5173 运行中；Playwright 需独立端口避免互斥。

## 二、范围定义

### 纳入（In Scope）
1. **回收站**：删除文档软删除→回收站；恢复；单个永久删除；清空；30 天保留期启动清扫。
2. **备份提醒**：距上次完整 JSON 导出超 14 天且存在文档时，温和横幅提醒（可「立即导出 / 3 天后提醒」）。
3. **Markdown 导出＋导入**：树结构/备注/任务日期进度/超链接的严格子集往返。
4. **甘特 CSV 导出**：层级、任务名、开始/结束、进度、里程碑、前置依赖（仅导出）。
5. **Playwright E2E 基建**：配置 + 4 条关键链路（崩溃恢复、JSON 导出产物、回收站往返、Markdown 往返）。

### 不纳入（Out of Scope，进 Backlog）
- OPML/PDF/XMind 导出、版本历史快照、本地加密、单文件模式（FS Access API）、Tauri。
- 节点备注编辑 UI、超链接编辑、标签体系（属「节点表达力」方向，留待 M7 候选）。
- 甘特 SS/FF/SF 绘制与冲突提示（甘特增强方向）。
- 真机 FPS 采样/视口裁剪（R-3，性能方向）。

## 三、架构设计与模块划分

### 3.1 Dexie schema v3（增量升级，docs/templates 不动）
```ts
// db.ts
interface StoredTrash { id; title; createdAt; updatedAt; deletedAt; payload }
// version(3): { docs: 'id, updatedAt', templates: 'id, createdAt', trash: 'id, deletedAt' }
```
新增 API（全部薄封装，真实浏览器由 E2E 覆盖）：
- `moveToTrash(id)`：Dexie 事务内 docs.get → trash.put(deletedAt=now) → docs.delete，保证不丢数据。
- `listTrash()`：按 deletedAt 降序，返回 meta + deletedAt。
- `restoreDoc(id)`：trash.get → docs.put → trash.delete；id 冲突时用 `cloneFromTemplate` 重映射 id 后入库（uuid 实践中不冲突，仅防御）。
- `purgeDoc(id)` / `emptyTrash()`：永久删除。
- `sweepTrash(retentionDays=30)`：启动时调用，清掉 deletedAt 超期项。

### 3.2 开放格式纯逻辑（新文件，Vitest 100% 覆盖）
`src/lib/openFormats.ts`：
- `toMarkdown(doc): string`：H1 标题；先序遍历输出缩进 `- ` 列表；note 转为缩进 `> ` 引用行；href 拼为 `[文本](url)`；任务行尾追加 `` `2026-09-01 → 2026-09-05 · 40%` ``；里程碑标 `◇`；折叠状态不影响导出（完整树）。
- `parseMarkdown(md): DocData`：解析 ATX 标题与 `- `/`* ` 列表缩进（2/4 空格或 Tab 统一处理），重建 parent/children；首个 H1 为文档标题（缺省用文件名/「未命名导图」）；无法识别的行按文本兜底，不抛裸错——非法输入给中文 Error。
- `toGanttCSV(doc): string`：列＝层级,任务,开始,结束,进度%,里程碑,前置任务；先序行；deps 的 from 解析为对应节点文本（重名加层级消歧不需要，逗号 join 即可）；CSV 字段做标准引号转义；带 BOM 保证 Excel 中文。
- `sanitizeFileName(name): string`：去除 `\\ / : * ? " < > |` 及控制字符，空名回退「未命名导图」；新老导出统一使用。

`src/lib/backup.ts`（纯判定，可单测）：
- `shouldRemindBackup({lastBackupAt, snoozeUntil, hasDocs, now, gapDays=14}): boolean`

### 3.3 UI 变更
- [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx)：
  - 删除流程由硬删改为 `moveToTrash`（文案「移入回收站，30 天后自动清除」）。
  - 底部加「🗑 回收站 (n)」切换钮，侧栏在 `文档库 / 回收站` 两个本地视图间切换（不污染全局 settings）；回收站行显示标题＋删除日期（`MM-DD`），操作「还原 / 永久删除」；底部「清空回收站」（二次 confirm）。
- `src/components/BackupBanner.tsx`（新）：App 启动时读 `msz.lastBackupAt`（JSON 导出成功后写入）与 `msz.backupSnoozeUntil`，命中 `shouldRemindBackup` 则在画布顶部显示可关闭横幅：「上次完整备份已超过 14 天」＋[导出 JSON 备份]（走现有 exportJSON 后写时间戳并关闭）[3 天后提醒]（写 snooze）。
- [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts)：`exportCurrent` kind 扩展 `'md' | 'csv'`；`exportJSON` 成功后 localStorage 写 `msz.lastBackupAt`（download 无失败回调，点击即记）；全部文件名走 sanitize。
- [Toolbar.tsx](file:///d:/猫思之/src/components/Toolbar.tsx) 导出菜单：加「Markdown（.md）」「甘特任务表（.csv）」；[Sidebar.tsx 导入 accept 加 `.md,.markdown`，按扩展名分流 parseMarkdown（产出 DocData 后 saveDoc，title 去重后缀由现有导入流程承担）。
- [Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx)：加命令 `exp-md`、`exp-csv`、`trash-open`、`trash-empty`。

### 3.4 Playwright 架构（PRD §6.1 选型落地）
- 新增 devDep：`@playwright/test`（仅此一个，无运行时依赖）。
- `playwright.config.ts`：仅 chromium；`webServer: { command: 'npm run dev', port: 5174, reuseExistingServer: false }`（用 `vite --port 5174 --strictPort`，与日常 5173 隔离）；`testDir: e2e`；每个测试用独立 localStorage/IndexedDB 靠启动时清理（`indexedDB.deleteDatabase('maosizhi')` in beforeEach）。
- `e2e/` 用例：
  1. `crash-recovery.spec.ts`：新建文档→输入节点文本→等 1s 自动保存→`page.reload()`→标题/节点仍在（R-4）。
  2. `export-json.spec.ts`：等待 download 事件，断言文件落盘且 JSON.parse 后 title/rootId 与当前文档一致（R-1）。
  3. `trash.spec.ts`：删除→回收站出现（含计数）→恢复→文档列表回归；再删→永久删除→列表与回收站均空；刷新后回收站持久。
  4. `markdown.spec.ts`：导出 .md 断言下载内容含标题/层级/任务行；通过「导入 JSON」旁的入口导入该 .md，断言节点数与层级关系恢复（往返）。
- package.json scripts：`"e2e": "playwright test"`、`"e2e:install": "playwright install chromium"`；**不**把 e2e 并入 `npm test`（Vitest 保持秒级），在测试手册定义完整门禁序列 `coverage → build → e2e`。

## 四、实施步骤（依赖序）

- **P1 数据与纯逻辑底座**
  1. db.ts version(3) + trash API + sweepTrash；App 启动调 sweepTrash（fire-and-forget）。
  2. openFormats.ts（toMarkdown/parseMarkdown/toGanttCSV/sanitizeFileName）+ openFormats.test.ts。
  3. backup.ts 判定 + backup.test.ts。
  4. 检查点 **C1**：全量 Vitest 绿、tsc 干净；新纯库行覆盖 100%（db 操作明确不单测）。
- **P2 回收站 UI**：Sidebar 双视图 + 删除/恢复/永久删/清空；Palette 命令；C2 用 browser_use 实测 v2→v3 老库升级与完整往返。
- **P3 开放格式**：exporters 接线 md/csv + 文件名清洗 + lastBackupAt 写入；Toolbar 菜单、Sidebar .md 导入；**C3** 浏览器实测导出内容与 MD 往返、备份时间戳。
- **P4 备份提醒**：BackupBanner + 关闭/稍后逻辑；纯逻辑已在 C1 覆盖，UI 在 C3 顺带实测（可临时改 localStorage 造超期）。
- **P5 Playwright**：安装（含 `playwright install chromium`）→ 配置 5174 端口 → 4 条 spec；**C4**＝`npx playwright test` 全绿。
- **P6 集成交付（C5）**：`npm run coverage` + `npm run build`；按 runbook 浏览器冒烟（同步把 M6 新场景补进 smoke-scripts 与 TEST_REPORT）；更新项目记忆；包体/依赖审计结论记录。

## 五、依赖与注意事项

- Playwright chromium 二进制需联网下载；若默认源慢/失败，用 `$env:PLAYWRIGHT_DOWNLOAD_HOST='https://cdn.npmmirror.com/binaries/playwright'` 重试；仍失败则 C4 如实标注受阻，不得伪造。
- Markdown 往返只保证**本应用导出格式**的严格子集；外部任意 .md 按 best-effort 解析（缩进列表→树），测试覆盖标准 2/4 空格与 Tab 缩进、备注引用、任务行、无标题文件。
- 回收站中文档的 deps/模板克隆复用 M5 的 cloneFromTemplate（恢复冲突防御）；恢复后若 lastDoc 指向旧 id，App 现有 fallback 已覆盖，无需额外处理。
- Dexie 升级必须在真实浏览器用**现有 v2 库**验证（与 M5 升 v2 同纪律），确认旧文档/模板无损。
- 回收站容量策略：MVP 不设条数上限，仅 30 天清扫；IndexedDB 配额异常由现有 console.error 暴露，M6 不做配额 UI。
- E2E 操作 SVG 仍走 evaluate/键盘/工具栏按钮；文件选择用 `page.waitForEvent('filechooser')` + `setInputFiles()`；下载用 `page.waitForEvent('download')`。
- 不主动创建文档文件（计划/报告除外）；不提交 git。

## 六、验证方案

| 门禁 | 内容 | 通过标准 |
| --- | --- | --- |
| C1 | 单测 + 类型 | 既有 55 用例无回归 + 新增 openFormats/backup 用例全绿；tsc 0 错；新纯库行覆盖 100% |
| C2 | 回收站浏览器实测 | v2→v3 升级旧数据无损；删→恢复→永久删→清空全链路；30 天清扫（改 deletedAt 造数验证） |
| C3 | 格式与提醒实测 | MD 导出/导入往返一致、CSV 列与转义正确、文件名非法字符被清洗、JSON 导出写 lastBackupAt、横幅超期出现/延后消失 |
| C4 | Playwright | 4 条 spec 在 chromium 全绿（含 reload 崩溃恢复、真实下载文件断言） |
| C5 | 集成 | coverage ≥ 现有基线（92.56%，剔除不可测 db 层后新增覆盖率持平）、build 通过、runbook 冒烟零 error、TEST_REPORT 追加 M6 章节、smoke-scripts 增补 §16–18 |

## 七、风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Playwright 浏览器下载失败 | C4 受阻 | npmmirror 镜像重试；仍失败则报告中如实标注，不阻断 C1–C3/C5 交付 |
| Dexie v3 升级异常 | 用户数据风险 | 仅增量加索引不改老表；先在现有库浏览器实测；moveToTrash 用事务保证原子 |
| MD 解析二义性（任意外部文件） | 导入结构不符预期 | 限定支持子集 + 容错兜底；错误中文提示；JSON 仍是唯一无损格式，文案明确说明 |
| E2E flaky（自动保存 700ms 时序） | 随机红 | 断言用 `expect(locator).toHaveText` 自动等待 + 固定 1s 保存窗口，禁用重试魔法（retries 0，失败即真问题） |
| 范围蔓延（想顺带做备注 UI/OPML） | 工期膨胀 | Out-of-Scope 清单已冻结；新想法一律写进 TEST_REPORT Backlog |

## 八、进度跟踪机制

- TodoWrite 维护 P1–P6 六阶段任务，每阶段完成带 summary 记录实测证据。
- 每道检查点（C1–C5）必须有可复现命令/浏览器实测输出，证据写入 TEST_REPORT M6 章节。
- 任何对本计划的实质性范围变更，暂停执行并重新征得确认后再继续。
