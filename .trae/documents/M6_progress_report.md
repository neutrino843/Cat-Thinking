# M6 工作进度报告

> 阶段：数据安全与开放（含 Playwright E2E 基建）
> 起算日期：2026-09-23
> 计划依据：[M6_plan.md](file:///d:/猫思之/.trae/documents/M6_plan.md)
> 跟踪机制：TodoWrite 维护 P1–P6，每检查点 C1–C5 必须有可复现命令/浏览器实测证据

## 一、阶段总览

| 阶段 | 内容 | 检查点 | 状态 | 时间节点 |
|---|---|---|---|---|
| P1 | 数据与纯逻辑底座（db trash API + openFormats + backup + 单测） | C1 | ✅ 完成 | 2026-09-23 |
| P2 | 回收站 UI（Sidebar 双视图 + 删除/恢复/永久删/清空 + Palette 命令） | C2 | ✅ 完成 | 2026-09-23 |
| P3 | 开放格式（exporters md/csv + 文件名清洗 + lastBackupAt + Toolbar 菜单 + Sidebar .md 导入） | C3 | ✅ 完成 | 2026-09-24 |
| P4 | 备份提醒（BackupBanner + 超期/稍后逻辑） | C3 | ✅ 完成 | 2026-09-24 |
| P5 | Playwright E2E 基建（配置 + 4 条 spec） | C4 | ✅ 完成 | 2026-09-23 |
| P6 | 集成交付（coverage/build/冒烟/TEST_REPORT M6 章节/smoke-scripts §16-18） | C5 | ✅ 完成 | 2026-09-23 |

进度跟踪机制：每阶段完成带 summary 记录实测证据；检查点必须有可复现命令/浏览器输出，证据写入 [TEST_REPORT.md](file:///d:/猫思之/TEST_REPORT.md) M6 章节。

## 二、P1 完成证据（C1 通过）

### 交付物
1. [db.ts](file:///d:/猫思之/src/store/db.ts) 新增 6 个回收站 API：
   - `moveToTrash(id)`：Dexie 事务内 docs.get → trash.put(deletedAt=now) → docs.delete，原子保证
   - `listTrash()`：按 deletedAt 降序返回 meta
   - `restoreDoc(id)`：trash.get → docs.put → trash.delete；id 冲突用 [cloneFromTemplate](file:///d:/猫思之/src/lib/templateClone.ts) 重映射（uuid 实践不冲突，仅防御），保留原标题/原时间戳，返回还原后 id
   - `purgeDoc(id)` / `emptyTrash()`：永久删除
   - `sweepTrash(retentionDays=30)`：启动清扫超期项
   - Dexie `version(3)` schema 已增量加 `trash: 'id, deletedAt'`，docs/templates 不动
2. [openFormats.ts](file:///d:/猫思之/src/lib/openFormats.ts) 新建（纯逻辑，4 函数）：
   - `sanitizeFileName(name)`：去 `\\ / : * ? " < > |` + 控制字符，空名回退「未命名导图」
   - `toMarkdown(doc)`：H1 标题 + 先序缩进列表；note 转 `> ` 引用；href 行尾 ` [🔗](url)`；任务行尾反引号块 `start → end · progress%`；里程碑 `◇` 前缀；根节点不输出（H1 承载标题，root.text 归一为 title，保证往返层级一致）
   - `parseMarkdown(md, fallbackTitle)`：解析 ATX H1 与 `- ` / `* ` / `+ ` 列表，缩进支持 2/4 空格与 Tab；里程碑/href/任务行尾解析；引用行追加到最近列表项 note；无法识别行跳过不报错；空内容抛中文 Error
   - `toGanttCSV(doc)`：列＝层级,任务,开始,结束,进度%,里程碑,前置任务；带 BOM 保证 Excel 中文；CSV 标准引号转义；deps.from 解析为节点文本
3. [backup.ts](file:///d:/猫思之/src/lib/backup.ts) 新建：`shouldRemindBackup(state)` 纯函数（无文档/snooze 期内/从未备份/超 gapDays 四判定）
4. [App.tsx](file:///d:/猫思之/src/App.tsx) 启动 fire-and-forget 调 `sweepTrash()`，失败仅记日志
5. [fixture.ts](file:///d:/猫思之/src/test/fixture.ts) `TreeDef` 扩展 `note`/`href` 字段（M6 测试必需）

### 验证结果
- **单测**：`npx vitest run` → **83/83 全绿**（原 55 + 新增 openFormats 19 + backup 9 = 83）
- **类型**：`npx tsc --noEmit` → 0 错
- **新纯库覆盖**：openFormats/backup 行覆盖目标 100%（19/9 用例覆盖所有分支，含往返、缩进变体、空内容、转义、BOM、snooze 优先级）
- **db 层**：按项目铁律不写 Vitest 单测（happy-dom 无 IndexedDB），由 P5 Playwright 覆盖
- **性能**：perf.test.ts 千节点布局 9.0ms、5 次连续 1.8–5.3ms、甘特 150 任务 1.6ms，无回归

### 关键设计决策
- **Markdown 往返层级一致性**：toMarkdown 不把根节点输出为列表项（H1 已承载文档标题），仅输出 root.children 作为顶层列表项；parseMarkdown 用简单栈（根占位 indent=-1）。这样 `# title\n\n- 子1\n  - 孙1` 往返后层级不变；代价是 root.text 与 title 的差异不保留（root.text 归一为 title），可接受（Markdown 仅一个 H1）。
- **Dexie v3 升级**：仅增量加 trash 表与 `deletedAt` 索引，docs/templates schema 完全不变；moveToTrash 用事务保证 docs→trash 原子，不丢数据；P2 C2 已在真实浏览器用 v2 库验证升级无损（与 M5 升 v2 同纪律）。

## 三、P2 完成证据（C2 通过）

### 交付物
1. [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx) 改造完成：
   - 新增本地 `view` state（`'library' | 'trash'`），不污染全局 settings
   - 删除流程由 `deleteDoc`（硬删）改为 `moveToTrash`（软删），confirm 文案改为「移入回收站，30 天后自动清除；在此之前可随时还原」
   - 回收站行：标题 + 删除日期 `MM-DD`（title 提示完整时间），操作 `↺ 还原`（restoreDoc，还原后 loadDoc 切换激活）+ `✕ 永久删除`（purgeDoc，二次 confirm）
   - 底部「🗑 回收站 (n)」切换钮（计数实时刷新）；回收站视图底部「清空回收站」（emptyTrash，二次 confirm，空时按钮 disabled）
   - 监听 `msz:trash-open` / `msz:trash-empty` 窗口事件，供 Palette 触发
2. [Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx) 新增 2 命令：
   - `trash-open` → 派发 `msz:trash-open` 事件（Sidebar 切到回收站视图）
   - `trash-empty` → 派发 `msz:trash-empty` 事件（Sidebar 执行 emptyTrash + 二次 confirm + 刷新）
3. [styles.css](file:///d:/猫思之/src/styles.css) 新增样式：`.sb-trash-list` / `.sb-trash-empty` / `.sb-trash-item`（点状边框、弱化文字色，与文档库视觉区分）/ `.sb-act`（还原按钮 hover 显色）/ `.sb-trash-btn`（底部切换钮，dashed 边框）/ `.tbtn.danger`（清空按钮红色 + disabled 灰化，含深色主题适配）

### 验证结果（C2 浏览器实测，2026-09-23）
| 项 | 结论 | 证据 |
|---|---|---|
| v2→v3 老库升级 | ✅ 无损 | 清空库后注入 v2 schema + 1 篇旧文档「老库遗留文档」；reload 后应用以 v3 schema 打开，文档库正常显示该文档，trash 表自动创建且 count=0 |
| 删除→回收站 | ✅ | 文档库 ✕ 删除 → 文档消失；切到回收站看到该条，计数 `(1)` |
| 还原 | ✅ | 回收站 ↺ → 文档回归文档库，回收站清空 |
| 永久删除 | ✅ | 再删 → 回收站 ✕ → confirm → 文档库与回收站均空 |
| 清空回收站 | ✅ | trash 表注入 2 条 → 切回收站视图看到 2 条 → 点「清空回收站」 → snapshot 显示「回收站为空」+ 按钮变 disabled；snapshot 同步证 trash=0 |
| 30 天清扫 | ✅ | trash 表注入 1 条过期（deletedAt=now-32d）+ 1 条近期（deletedAt=now）→ reload 触发 App 启动 `sweepTrash()` → 等 2s 后读 trash 表：`count=1, titles=['fresh-item']`，过期条目被清扫、近期条目保留 |
| Palette trash-open | ✅ | Ctrl+K 打开命令面板 → 输入「回收站」过滤 → 列表显示「打开回收站」「清空回收站」2 项 → 点「打开回收站」 → 侧栏标题变「回收站」、显示「回收站为空」+「清空回收站」按钮 disabled，视图切换生效 |

### 关键设计决策
- **view 状态本地化**：Sidebar 用 `useState<View>('library')` 管理视图切换，不污染全局 settings store；Palette 通过窗口事件 `msz:trash-open` / `msz:trash-empty` 触发，避免跨组件状态耦合
- **restoreDoc 后自动切换激活**：还原后调用 `loadDoc(newId)` + `useDoc.getState().loadDoc(d)`，让用户立即看到还原的文档
- **空状态视觉反馈**：回收站空时显示「回收站为空」占位 + 按钮变 disabled，避免误操作
- **浏览器基础设施故障应急**：测试中途因上一轮遗留的 confirm dialog 死锁导致 navigate 反复 60s 超时；用 `browser_tabs close index:0` + `navigate newTab:true` 重开新 tab 恢复，与应用无关（HTTP 200 已证）

## 四、P3–P6 任务分配

### P2 回收站 UI（C2 浏览器实测）
- [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx)：删除流程由硬删改 `moveToTrash`（文案「移入回收站，30 天后自动清除」）；底部加「🗑 回收站 (n)」切换钮，侧栏文档库/回收站双视图（不污染全局 settings，本地 useState）；回收站行显示标题 + 删除日期 `MM-DD`，操作「还原 / 永久删除」；底部「清空回收站」二次 confirm
- [Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx)：加命令 `trash-open`、`trash-empty`
- **C2 验证**：browser_use 实测 v2→v3 老库升级旧数据无损；删→恢复→永久删→清空全链路；30 天清扫（改 deletedAt 造数验证）

### P3 开放格式（C3 浏览器实测）
- [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts)：`exportCurrent` kind 扩展 `'md' | 'csv'`；`exportJSON` 成功后 localStorage 写 `msz.lastBackupAt`；全部文件名走 `sanitizeFileName`（顺带修审核 S-1）；`parseImported` 按扩展名分流（.md 走 parseMarkdown，顺带加强校验修审核 S-3）
- [Toolbar.tsx](file:///d:/猫思之/src/components/Toolbar.tsx)：导出菜单加「Markdown（.md）」「甘特任务表（.csv）」
- [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx)：导入 accept 加 `.md,.markdown`，按扩展名分流 parseMarkdown
- **C3 验证**：MD 导出/导入往返一致、CSV 列与转义正确、文件名非法字符被清洗、JSON 导出写 lastBackupAt

### P4 备份提醒（C3 顺带实测）
- 新建 [BackupBanner.tsx](file:///d:/猫思之/src/components/BackupBanner.tsx)：App 启动读 `msz.lastBackupAt` 与 `msz.backupSnoozeUntil`，命中 `shouldRemindBackup` 则画布顶部显示横幅「上次完整备份已超过 14 天」+ [导出 JSON 备份]（走现有 exportJSON 后写时间戳并关闭）+ [3 天后提醒]（写 snooze）
- 纯逻辑已在 C1 覆盖，UI 在 C3 顺带实测（可临时改 localStorage 造超期）

### P5 Playwright E2E 基建（C4）
- 新增 devDep `@playwright/test`；[playwright.config.ts](file:///d:/猫思之/playwright.config.ts)：仅 chromium；`webServer: { command: 'npm run dev', port: 5174, reuseExistingServer: false }`（`vite --port 5174 --strictPort`，与日常 5173 隔离）；`testDir: e2e`；beforeEach 用 `indexedDB.deleteDatabase('maosizhi')` 清库
- 4 条 spec：
  1. `crash-recovery.spec.ts`：新建→输入→等 1s 自动保存→`page.reload()`→标题/节点仍在（R-4）
  2. `export-json.spec.ts`：等 download 事件，断言文件落盘且 JSON.parse 后 title/rootId 一致（R-1）
  3. `trash.spec.ts`：删→回收站出现（含计数）→恢复→列表回归；再删→永久删→列表与回收站均空；刷新后回收站持久
  4. `markdown.spec.ts`：导出 .md 断言含标题/层级/任务行；导入该 .md 断言节点数与层级关系恢复
- package.json scripts：`"e2e": "playwright test"`、`"e2e:install": "playwright install chromium"`；不并入 `npm test`（Vitest 保持秒级）
- **风险**：chromium 二进制需联网；失败用 `$env:PLAYWRIGHT_DOWNLOAD_HOST='https://cdn.npmmirror.com/binaries/playwright'` 重试；仍失败则 C4 如实标注，不阻断 C1–C3/C5

### P6 集成交付（C5）
- `npm run coverage` ≥ 现有基线 92.56%（剔除不可测 db 层后新增覆盖率持平）
- `npm run build` 通过
- 按 runbook 浏览器冒烟零 error；同步把 M6 新场景补进 [smoke-scripts.md](file:///d:/猫思之/.trae/skills/maosizhi-test-runbook/references/smoke-scripts.md) §16–18
- [TEST_REPORT.md](file:///d:/猫思之/TEST_REPORT.md) 追加 M6 章节
- 包体/依赖审计结论记录；更新项目记忆

## 四、上一阶段代码审核结论摘要

详见 [M5_code_review.md](file:///d:/猫思之/.trae/documents/M5_code_review.md)。33 项问题（P0=0/P1=8/P2=16/P3=9）。M6 期间自然覆盖 2 项（S-1 文件名清洗、S-3/S-4 导入校验，均在 P3 处置）；P1 中的 F-1（sketch=0 丢失）、F-2（跨时区星期错位）、P-1/P-2/P-3（大文档性能）立卡入 M7 候选，M6 不扩范围；P2/P3 多数纳入长期 Backlog。

## 五、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Playwright chromium 下载失败 | C4 受阻 | npmmirror 镜像重试；仍失败则如实标注，不阻断 C1–C3/C5 |
| Dexie v3 升级异常 | 用户数据风险 | 仅增量加索引不改老表；P2 C2 先在现有库浏览器实测；moveToTrash 用事务保证原子 |
| MD 解析二义性（外部任意 .md） | 导入结构不符预期 | 限定支持子集 + 容错兜底；错误中文提示；JSON 仍是唯一无损格式，文案明确 |
| E2E flaky（自动保存 700ms 时序） | 随机红 | `expect(locator).toHaveText` 自动等待 + 固定 1s 保存窗口，retries 0 |
| 范围蔓延（备注 UI/OPML） | 工期膨胀 | Out-of-Scope 已冻结；新想法写进 TEST_REPORT Backlog |

## 六、P3 完成证据（C3 通过）

### 交付物
1. [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts) 改造完成：
   - `exportCurrent` kind 扩展 `'md' | 'csv'`：md 走 `toMarkdown`、csv 走 `toGanttCSV`
   - `exportJSON` 成功后同步写 `localStorage['msz.lastBackupAt']`（BackupBanner 读取）
   - 全部文件名统一走 `sanitizeFileName`（修审核 S-1）：json/svg/png/md/csv/甘特导出均清洗 `\\ / : * ? " < > |` 与控制字符
   - `parseImported(text, filename?)` 按扩展名分流：`.md/.markdown` 走 `parseMarkdown`（fallback 标题取文件名），其余按 JSON
   - 新增 `validateDoc(d)` 结构校验（修审核 S-3）：顶层字段类型、rootId 指向、每节点 id/parent/children/text 类型、parent↔children 双向一致、根节点 parent 必须 null、deps.from 指向存在、task 字段类型枚举校验；非法输入抛中文 Error
   - `exportPNG`/`rasterize` 的 `getContext('2d')!` 非空断言改为 fallback throw（修审核 C-5）
2. [Toolbar.tsx](file:///d:/猫思之/src/components/Toolbar.tsx)：导出菜单加「Markdown（.md）」「甘特任务表（.csv）」两项
3. [Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx)：导入按钮文案「导入 JSON」→「导入文件」；`importJSON`→`importFile`；accept 加 `.md,.markdown,text/markdown,text/plain`；`parseImported` 传入 `file.name` 做扩展名分流
4. [Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx)：新增 `exp-md`（导出 Markdown）、`exp-csv`（导出甘特任务表 CSV）2 命令
5. [exporters.test.ts](file:///d:/猫思之/src/lib/exporters.test.ts) 扩展 10 用例（3→13）：.md/.markdown 分流、缺省文件名走 JSON、.md 文件名兜底标题、deps.from 指向校验、parent↔children 不一致、children 含幽灵节点、根 parent 非 null、task.progress 类型错误、JSON 解析失败中文错误

### C3 浏览器实测（2026-09-24）
| 项 | 结论 | 证据 |
|---|---|---|
| 文件名清洗 | ✅ | 标题设 `测试/文件:名*字?`，导出 JSON 捕获文件名 `猫思之-测试文件名字.json`，`/` `:` `*` `?` 已剔除 |
| MD 导出 | ✅ | 捕获 `.md` 文件，内容首行 `# 测试...`（H1 标题） |
| CSV 导出 | ✅ | 捕获 `.csv` 文件，内容首行 `层级,任务,开始,结束,进度%,里程碑,前置任务`，带 BOM |
| JSON 导出写 lastBackupAt | ✅ | 导出 JSON 后 `localStorage.getItem('msz.lastBackupAt')` = `"1790155881925"`（非 null 数字时间戳） |
| MD 往返 / CSV 逗号转义 | ✅ 单测覆盖 | openFormats.test.ts 19 用例覆盖 toMarkdown/parseMarkdown 往返、csvCell 转义；exporters.test.ts 13 用例覆盖 validateDoc 全分支 |

### 审核项处置
- **S-1 文件名未清洗**：✅ 已修（全部导出统一 sanitizeFileName）
- **S-3 导入校验不足**：✅ 已修（validateDoc 全面结构校验 + 扩展名分流）
- **C-5 getContext 非空断言**：✅ 已修（fallback throw）

## 七、P4 完成证据（C3 顺带）

### 交付物
1. [BackupBanner.tsx](file:///d:/猫思之/src/components/BackupBanner.tsx) 新建：
   - 读 `msz.lastBackupAt` + `msz.backupSnoozeUntil`，命中 `shouldRemindBackup` 显示横幅
   - 「导出 JSON 备份」→ `exportCurrent('json')`（内部已写 lastBackupAt）后关闭
   - 「3 天后提醒」→ 写 `snoozeUntil = now + 3d` 后关闭
   - 60s 定时复查（snooze 到期自动重现）；纯逻辑 backup.ts 已在 C1 覆盖
2. [App.tsx](file:///d:/猫思之/src/App.tsx) 挂载：`{!presenting && <BackupBanner />}`（演示模式不显示）
3. [styles.css](file:///d:/猫思之/src/styles.css) 新增 `.backup-banner`/`.bbtn` 样式（暖色背景、深色主题适配）

### 验证
- tsc 0 错；94/94 单测全绿；构建 312.25KB/gzip 105.79KB
- 横幅超期出现/延后消失的浏览器实测留待 P6 集成冒烟时顺带验证（可临时改 localStorage 造超期）

## 八、下一阶段（P5）即时行动

1. `npm i -D @playwright/test`；`npx playwright install chromium`（失败用 `$env:PLAYWRIGHT_DOWNLOAD_HOST='https://cdn.npmmirror.com/binaries/playwright'` 重试）
2. [playwright.config.ts](file:///d:/猫思之/playwright.config.ts)：仅 chromium；`webServer: { command: 'npm run dev', port: 5174, reuseExistingServer: false }`；`testDir: e2e`；beforeEach `indexedDB.deleteDatabase('maosizhi')` 清库
3. 4 条 spec：crash-recovery（reload 后数据在）、export-json（下载断言 title/rootId）、trash（删→还原→永久删→刷新持久）、markdown（导出 .md 断言内容 + 导入往返）
4. package.json scripts：`"e2e": "playwright test"`、`"e2e:install": "playwright install chromium"`
5. **C4**：`npx playwright test` 4 spec 全绿

## 九、P5 完成证据（C4 通过）

### 交付物
1. devDep `@playwright/test@1.63.0`；chromium v1243（含 chrome-headless-shell）已下载。
2. [playwright.config.ts](file:///d:/猫思之/playwright.config.ts)：仅 chromium；`vite --port 5174 --strictPort` 独立端口、reuseExistingServer:false；workers=1、retries=0（失败即真问题）。
3. [e2e/helpers.ts](file:///d:/猫思之/e2e/helpers.ts)：
   - `resetStore`：直接 goto 同源静态页 `/src/main.tsx`（不启动 App）清 localStorage + `indexedDB.deleteDatabase`，再 goto('/')。**两个坑**：App 连接打开时删库会 blocked；先 goto('/') 再导航走，App async 初始化有竞态（listDocs 被 catch 成 [] 后仍 saveDoc）。
   - `selectNode`：真实鼠标（isTrusted）「微拖拽」——down 节点中心 → move 到扫描出的空白点（>4px、hover=null）→ up，使 Canvas onUp 走 moved 分支不 reparent、不 beginEditAt，仅保留 selection。
4. 4 spec：[crash-recovery](file:///d:/猫思之/e2e/crash-recovery.spec.ts)（R-4）、[export-json](file:///d:/猫思之/e2e/export-json.spec.ts)（R-1，createReadStream 解析产物）、[trash](file:///d:/猫思之/e2e/trash.spec.ts)、[markdown](file:///d:/猫思之/e2e/markdown.spec.ts)。
5. package.json 加 `e2e` / `e2e:install`，不并入 npm test。

### 新发现并修复的真实缺陷
- **BUG-M6-1**：StrictMode（dev）effect 双调用，App 初始化「空库建 welcome」check-then-act 竞态 → 空库首启建两篇文档。[App.tsx](file:///d:/猫思之/src/App.tsx) 改模块级单飞 `initPromise`，init 幂等；trash.spec 初始计数即回归断言。

### 验证结果
- `npx playwright test` 连续两遍：**4/4 全绿**（8.7s / 8.8s），无 flaky。
- tsc 0 错；94/94 单测全绿（App.tsx 改动无回归）。

## 十、P6 完成证据（C5 通过）

| 门禁 | 结果 |
|---|---|
| 覆盖率 `npx vitest run --coverage` | 语句 **93.06%**（基线 92.56% ↑0.50pp）、分支 86.19%；openFormats/backup 行覆盖 100% |
| 构建 `npm run build` | 通过：JS 313.36KB/gzip 106.19KB、CSS 15.17KB；73 modules |
| 浏览器冒烟 | **9/9 PASS、console error=0**；BackupBanner 超期出现/稍后(snooze 1790425342440)/导出(lastBackupAt 更新)全链路；导出菜单 5 项齐全 |
| smoke-scripts | 增补 §16 回收站 / §17 MD-CSV 入口 / §18 BackupBanner |
| TEST_REPORT | 追加 M6 章节（M6-1 ~ M6-7） |

**M6 全部交付，R-1 / R-4 挂账结清。进入 M7 立项。**
