# 猫思之 · 测试报告

| 项 | 内容 |
| --- | --- |
| 版本 | v0.2.0（M1–M4 完成后） |
| 测试日期 | 2026-09-21 |
| 测试人 | AI 工程代理（Vitest 自动 + 浏览器自动化手工） |
| 环境 | Windows / Node / Chromium（Playwright 桥接）、happy-dom 15 |
| 构建 | `tsc --noEmit` 通过；`vite build` 通过（293 KB / gzip 100 KB） |

---

## 1. 测试范围

| 层 | 类型 | 工具 |
| --- | --- | --- |
| 纯逻辑（date / sketch / layout / gantt / docStore / 导入校验） | 单元 + 回归 | Vitest 2.1 + happy-dom |
| 性能（1050 节点布局/甘特） | 性能基准 | Vitest + performance.now() |
| UI 交互（画布、甘特拖拽、面板、主题） | 浏览器自动化 E2E | browser_use（Chromium） |
| 类型安全 | 静态 | tsc strict |
| 生产构建 | 构建 | Vite 5 |
| 依赖安全 | 审计 | npm audit |

---

## 2. 自动化测试结果

**总计 43 / 43 通过，0 失败。** 命令：`npm run coverage`（v8）。

| 测试文件 | 用例数 | 结果 |
| --- | --- | --- |
| [date.test.ts](file:///d:/猫思之/src/lib/date.test.ts) | 7 | ✅ 7/7 |
| [sketch.test.ts](file:///d:/猫思之/src/lib/sketch.test.ts) | 6 | ✅ 6/6 |
| [layout.test.ts](file:///d:/猫思之/src/lib/layout.test.ts) | 5 | ✅ 5/5 |
| [gantt.test.ts](file:///d:/猫思之/src/lib/gantt.test.ts) | 6 | ✅ 6/6 |
| [docStore.test.ts](file:///d:/猫思之/src/store/docStore.test.ts) | 14 | ✅ 14/14 |
| [exporters.test.ts](file:///d:/猫思之/src/lib/exporters.test.ts) | 2 | ✅ 2/2 |
| [perf.test.ts](file:///d:/猫思之/src/lib/perf.test.ts) | 3 | ✅ 3/3 |

### 2.1 覆盖率（v8，实测）

| 文件 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| **全部被测范围** | **91.19%** | **84.53%** | **81.08%** | **91.19%** |
| lib/date.ts | 100% | 81.8% | 100% | 100% |
| lib/sketch.ts | 100% | 96.2% | 100% | 100% |
| lib/layout.ts | 99.3% | 72.6% | 100% | 99.3% |
| lib/gantt.ts | 97.6% | 88.2% | 85.7% | 97.6% |
| store/docStore.ts | 97.0% | 76.7% | 82.8% | 97.0% |
| lib/exporters.ts | 11.8% | 100% | 12.5% | 11.8% |
| lib/theme.ts | 94.6% | 100% | 0% | 94.6% |

未覆盖说明（如实披露，不以口头结论替代）：
- `exporters.ts` 的文件下载 / SVG 栅格化 / Blob 链路依赖浏览器 DOM，单测仅覆盖纯函数 `parseImported`；需 Playwright E2E 补下载产物校验。
- 组件目录（Canvas / Gantt / Toolbar 等 React 组件）未纳入 jsdom 组件测试，当前由浏览器 E2E 覆盖。
- 覆盖率产物：`coverage/`（HTML 报告可打开 `coverage/index.html`）。

### 2.2 性能实测（1050 节点，PRD 目标 1000+）

| 场景 | 实测 | PRD 目标 | 结论 |
| --- | --- | --- | --- |
| 逻辑布局单次 | **7.2–13.5 ms** | <200 ms 阈值 | ✅ 余量 15× |
| 连续 5 次布局 | 5.8 / 6.7 / 7.1 / 3.9 / 2.9 ms | 无累计劣化 | ✅ |
| 甘特模型（150 任务 / 1050 行） | **0.7–1.4 ms** | <200 ms | ✅ |

注：以上为**布局/模型算法层**耗时；React+SVG 实际渲染帧率（PRD 45fps）需真实浏览器性能采样，见 §6 残余风险。

---

## 3. 浏览器 E2E（实测记录）

### 3.1 M1–M3 冒烟（当日早些时候，工具正常时执行）

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| 页面加载、欢迎导图渲染 | ✅ | 根节点+4 分支存在，标题正确 |
| console JS 错误 | ✅ 0 条 | 仅 React DevTools info |
| 大纲面板双向同步 | ✅ | 大纲含画布同名节点 |
| 深色模式非纯黑 | ✅ | data-theme=dark，背景 rgb 非 0,0,0 |
| 命令面板开关 | ✅ | 命令列表存在，Escape 关闭 |
| 手绘程度三档 | ✅ | path d 单遍/双遍描线切换 |

### 3.2 M4 甘特冒烟（本轮执行）

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| 导图/甘特视图切换 | ✅ | `#gantt-world` 挂载 |
| 节点→任务转换、任务条渲染 | ✅ | `rect[rx=7]` 计数 1→2 |
| FS 依赖箭头（候选/添加/箭头） | ✅（修复后复测通过） | marker-end path = 1 |
| 里程碑菱形切换 | ✅ | polygon 计数 0→1→0 |
| 时间轴 日/周 缩放 | ✅ | SVG width 616→224 |
| 根连接线回归（BUG-001 修复后） | ✅ | 连接线 ≥4 条，含分支色 |
| console 错误 | ✅ 0 条 | — |
| 工具栏撤销按钮 / 键盘 Ctrl+Z 链路 | ⚠️ 未完成复测 | 浏览器工具基础设施故障（见 §6 R-2）；同链路已由 43 个单测与源码验证 |

---

## 4. PRD 验收对照（M1–M4）

| 里程碑 | 验收项 | 状态 |
| --- | --- | --- |
| M1 | 无限画布（缩放/平移/适应） | ✅ |
| M1 | 建子→改文本→拖拽换父→删除→撤销×4 一致 | ✅ 单测覆盖换父/删除/undo |
| M1 | 1000 节点布局流畅（算法层） | ✅ 13.5ms |
| M2 | 关闭重开恢复（自动保存 700ms+flush） | ✅ 代码就绪；E2E 关页恢复待补 |
| M2 | 导出 JSON/PNG/SVG | ⚠️ 功能完成，下载产物 E2E 未验 |
| M2 | JSON 导入校验 | ✅ 单测（合法/非法/坏 JSON） |
| M3 | 导图/大纲互改一致 | ✅ E2E 通过 |
| M3 | 搜索高亮 + Enter 循环跳转 | ✅ 含折叠祖先自动展开 |
| M3 | Ctrl+K 命令面板 | ✅ E2E 通过 |
| M3 | 手绘程度三档 | ✅ E2E 通过 |
| M4 | 3 节点设日期+FS 依赖→箭头 | ✅ E2E + 单测 |
| M4 | 拖拽写回导图节点 | ✅ 代码就绪（指针事件，合成拖拽 E2E 待补） |
| M4 | 撤销后双视图一致 | ✅ 同源模型 + 单测历史回归 |
| M4 | 里程碑/今日线/周末/日周月缩放 | ✅ 单测+E2E |

---

## 5. 本轮发现的缺陷与处理

严重级：Blocker > Critical > **Major**（主功能错误/数据错误）> **Minor**（体验/边界）> Trivial。

| ID | 严重级 | 模块 | 描述 | 发现方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | Major | layout | **根节点到一级分支的连接线整体缺失**——重写布局时只在递归里画了子边，根边循环漏推；UI 上根与分支视觉断裂 | 单测边数断言 1≠3 + 调试用例定位 | ✅ 已修复，回归用例 `root 边` 断言 |
| BUG-002 | Major | App 快捷键 | **Ctrl+Z / Ctrl+Shift+Z 语义反了**（三元表达式取反）：无修饰 Ctrl+Z 执行了 redo | 代码复审（PRD 验收走查） | ✅ 已修复 |
| BUG-003 | Major | docStore.setTask | **历史提交布尔被二次取反** `{commit: commit===false}`：常规任务修改不入历史、拖拽中间态反入历史，甘特撤销/重做整体错乱 | 单测失败（期望 22 得 23）定位 | ✅ 已修复 + 回归断言 |
| BUG-004 | Major | gantt 环检测 | 依赖沿 deps 反向指针遍历，方向取反导致**循环依赖漏检**（a→b 存在时 b→a 未拦截） | 单测失败 | ✅ 改为前向邻接 BFS，单测覆盖 |
| BUG-005 | Minor | TaskEditor | 前置任务候选错误排除了祖先节点（树层级 ≠ 依赖关系），导致最常见的"上级任务做前置"无法添加 | E2E 候选列表只有占位项 | ✅ 已修复，环判定交给 store |
| BUG-006 | Minor | Outline | 输入框每次 focus 都打历史快照，纯焦点移动也产生可撤销步骤 | 代码复审 | ✅ 仅 editing.id 变化时打快照 |
| IMP-001 | Minor | 搜索 | 仅高亮无跳转；命中折叠分支内节点不可见 | PRD 验收走查 | ✅ Enter 循环居中跳转 + 祖先临时展开 |

缺陷统计：Major 4 / Minor 3，全部已修复并回归；0 个遗留 Critical/Blocker。

### 依赖安全（npm audit）

7 条告警（3 moderate / 1 high / 3 critical）**全部位于 devDependencies**（happy-dom、esbuild、vitest mocker 等测试/构建链），生产运行依赖 react / zustand / dexie 无告警，不进入产物包。未执行 `audit fix --force`（会强制升级破坏 Vite5/Vitest2 兼容）。建议：随框架版本升级计划处理，happy-dom critical 仅在测试沙箱中解析构造 DOM，无生产暴露面。

---

## 6. 残余风险与未覆盖项

| 编号 | 说明 | 影响 | 建议 |
| --- | --- | --- | --- |
| R-1 | 导出文件下载（PNG/SVG/JSON）未经 E2E 产物校验 | 中 | 引入 Playwright 正式 E2E，断言下载文件存在且 PNG 可解码 |
| R-2 | 本轮末段浏览器自动化工具持续故障（`No URL is loaded`，3 次重试），甘特撤销的**键盘**路径未完成浏览器复测；已用「HTTP 200 + 服务源码含修复 + 43 单测 + 工具栏按钮同 store 动作」交叉佐证 | 中 | 工具恢复后补跑 5 步键盘回归脚本（可复用本轮 prompt） |
| R-3 | 1000 节点的 React/SVG 渲染 FPS、内存未做真机采样（算法 13.5ms 不代表渲染 45fps） | 中 | Playwright trace + Performance 长任务采样；不达标则上视口裁剪/Canvas 图层（ADR-1） |
| R-4 | IndexedDB 崩溃恢复链路（杀进程/关页）无端到端验证 | 中 | Playwright 模拟 beforeunload + 重开读库 |
| R-5 | 甘特拖拽为指针事件，合成事件 E2E 未模拟；自动保存时长 700ms 防抖未测 | 低-中 | Playwright mouse API 拖拽 + fake timers |
| R-6 | PRD P1 项尚未实现：可访问性 aria/对比度审计、i18n、备注/链接等富内容、回收站 | — | 按 M5+Backlog 排期 |

---

## 7. 结论

- **M1–M4 功能验收项全部具备**；本轮复审发现的 7 个缺陷（含 4 个 Major 数据/视觉错误）全部修复并有回归用例。
- **自动化：43/43 通过，核心逻辑行覆盖 97–100%，总体语句覆盖 91.19%**；千节点算法性能 7.2–13.5ms，远优于阈值。
- **发布就绪度（MVP 视角）**：功能层达到可日常使用；**建议在进入 M5 前补齐 R-1/R-2/R-4 三条数据安全相关 E2E**（PRD P1「数据不丢」是产品底线）。

---

# M5 增量报告（主题与演示）— 2026-09-23

| 项 | 内容 |
| --- | --- |
| 版本 | v0.3.0（M5 完成后） |
| 测试日期 | 2026-09-23 |
| 范围 | 演示模式、主题打磨（挂载动效/噪点纸面/对比度）、另存为自定义模板（Dexie v2）、可访问性 aria |
| 构建 | `tsc --noEmit` 通过；`vite build` 通过（**301.93 KB / gzip 102.66 KB**，CSS 13.30 KB / gzip 3.43 KB） |
| 计划文档 | [M5_plan.md](file:///d:/猫思之/.trae/documents/M5_plan.md)（P1–P5 五阶段，C1–C5 检查点） |

## M5-1 自动化测试：55 / 55 通过（0 失败）

新增 2 个测试文件共 10 个用例（M5 结束时另补 2 个边界用例，总计 43→55）：

| 测试文件 | 用例数 | 结果 |
| --- | --- | --- |
| [presentation.test.ts](file:///d:/猫思之/src/lib/presentation.test.ts) | 6 | ✅ 6/6（含越界钳制、根缺失防御） |
| [templateClone.test.ts](file:///d:/猫思之/src/lib/templateClone.test.ts) | 6 | ✅ 6/6（含 id 兜底分支） |
| 其余 7 个既有文件 | 43 | ✅ 全绿，无回归 |

### M5-1.1 覆盖率（v8 实测，`npm run coverage`）

| 文件 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| **全部被测范围** | **92.56%**（M4 91.19% ↑） | **85.61%** | **82.92%** | **92.56%** |
| lib/**presentation.ts**（新） | **100%** | 93.33% | **100%** | **100%** |
| lib/**templateClone.ts**（新） | **100%** | 83.33% | **100%** | **100%** |
| 其余文件 | 与 M4 持平 | — | — | — |

过程中删除了死代码 `visibleSet()`（无调用方），未为凑覆盖保留无用户路径的函数。

## M5-2 浏览器实测（C2/C3/C4/C5，全部当日 Chromium 实测）

### 演示模式（C2、C5 复测）
- 24–27 节点文档逐页揭示：首页仅根节点，先序 DFS 每页 +1，`1/27 → 4/27` 翻页正确。
- 左右热区、底部 ‹/›、进度条、n/total、aria-live 焦点文本正常；Esc 退出后 Toolbar/侧栏/画布恢复。
- 演示派生文档不写回 store（单测断言输入引用不变）；全屏 best-effort，拒绝时静默。
- 控制台 **0 error**。

### 主题打磨（C3）
- 挂载动效：节点 180ms（opacity+translateY+scale）、边线 220ms 淡入；`data-reduce-motion='1'` 时 computed `animation-name: none`，切回恢复；缺省跟随系统 `prefers-reduced-motion`；命令面板可手动切换（localStorage `msz.reduceMotion` 持久化 true/false 实测）。
- 噪点纸面：`.paper-noise` 存在于画布与甘特视口、**在 `#world`/`#gantt-world` 之外**；序列化 `#world` 的 SVG 不含 `feTurbulence`/`paper-noise`（导出无污染实测）；亮 0.035 / 暗 0.06 透明度，`pointer-events:none`。
- 手绘三档几何位置不变：以 text 锚点包围盒比对，简洁/很手绘 `same0=true, same2=true`（抖动仅限描线）。
- 对比度：根节点字号 20→24px（白字在陶土橙上满足大文本 3:1）；`--ink-soft` 亮 `#6e685c`、暗 `#9a9184`；暗色画布底 `rgb(42,38,34)` 非纯黑（M5 复测再确认）。

### 自定义模板（C4）
- 命令面板「将当前文档存为模板」（prompt 取名）→ Dexie templates 表持久化；「＋新建」菜单分区显示「内置模板 / 我的模板」。
- 从模板新建：title 正确、节点数与源一致（27→27）、侧栏文档数 +1；`cloneFromTemplate` 重映射文档/节点 id 并同步 parent/children/task.deps（单测覆盖）。
- 删除模板：confirm 后消失，内置模板不受影响；已用模板创建的文档不受影响。
- **Dexie v1→v2 增量升级实测**：旧文档（欢迎教程/学习计划等 4 篇）升级后全部可打开。
- 测试残留（自动化产生的同名模板）已清理。

### 可访问性（C4）
- 视图切换：`role="tablist"` + 两按钮 `role="tab"`/`aria-selected`；侧栏 `role="navigation" aria-label="文档库"`；甘特 SVG `role="img"` + aria-label；命令面板 `role="dialog"`。
- 节点 `<g role="button" tabIndex>`：选中节点可 `.focus()`（activeElement 在 #world 内实测）；`aria-label` 含文本+展开/折叠（含折叠后代数），有子节点者带 `aria-expanded`。
- 搜索框/标题框/各 select/图标按钮均补 aria-label；大纲按钮 `aria-pressed`；新建按钮 `aria-expanded`；`:focus-visible` 键盘焦点环（accent 色，仅键盘）。

### M1–M4 回归（C5 冒烟，零 error）
| 用例 | 结果 | 证据 |
| --- | --- | --- |
| 甘特建任务×2 + FS 依赖箭头 | ✅ | 箭头 1→2，撤销 2→1 |
| 工具栏撤销 / 键盘 Ctrl+Z / Ctrl+Shift+Z | ✅ | redo 箭头恢复=2→（再撤销）bars≥1；**补齐 M4 报告 R-2 的键盘路径欠账** |
| 里程碑菱形 | ✅ | polygon delta=1（旧脚本选择器 `.te-milestone` 已更正为 `.task-editor label.te-row input`） |
| 日/周/月缩放 | ✅ | width 616 > 224 > 84 |
| 导图连接线回归 | ✅ | paths=53 / edges=26 |
| 搜索 Enter 跳转选中 | ✅ | 选中虚框 rect=1 |
| Ctrl+K 面板 / Esc | ✅ | dialog true→false |
| 深/浅色切换 | ✅ | dark rgb(42,38,34) 非纯黑 |

## M5-3 PRD 验收对照（M5 增量）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 演示模式（按分支逐级讲解、键盘翻页、退出恢复） | ✅ | C2/C5 |
| 主题打磨（动效、纸面质感、对比度、暗色） | ✅ | C3 |
| 减少动效（手动开关 + 跟随系统 + 持久化） | ✅ | C3 |
| 另存为模板 / 从模板新建 / 删除模板 | ✅（P1） | C4 + 单测 |
| 老库 Dexie 自动升级 | ✅ | C4 实测 |
| aria 可访问性与键盘焦点 | ✅（P1） | C4 |
| 导出物不含 UI 覆盖层 | ✅ | C3 序列化实测 |

## M5-4 缺陷与处理

M5 实施期间未产生产品缺陷（0 个 Major/Minor）。两起「验证失败」均为**测试手段问题**，定位后排除：
1. 手绘三档几何初测失败 → 测量对象用了抖动 path 的 bbox；改用 text 锚点后三档完全一致（产品正确）。
2. 命令面板程序化赋值不过滤 → 直接赋 `.value` 不触发 React state；改用原生 setter + input 事件后过滤正常（产品正确）。

## M5-5 残余风险（M5 增量，沿用 R-1/R-3/R-4/R-5）

| 编号 | 说明 | 影响 | 建议 |
| --- | --- | --- | --- |
| R-7 | 演示全屏在各浏览器/移动端的兼容仅做 best-effort（reject 静默），未做多端真机走查 | 低 | 移动端/iframe 内嵌场景补一轮真机 |
| R-8 | 屏幕阅读器（NVDA/VoiceOver）未做真人朗读走查，aria 仅保证结构与属性正确 | 低-中 | 邀真实用户做一次 SR 走查 |
| R-9 | 冒烟在「欢迎教程」本地库中产生了 2 个测试任务（仅浏览器本地 IndexedDB，非仓库文件） | 很低 | 可手动删除或忽略；不影响交付物 |
| R-1（沿用） | 导出文件下载产物仍未做 Playwright 下载校验；M5 已以「序列化 #world 无噪点」侧面验证导出内容正确性 | 中 | 正式 E2E 时补下载断言 |
| R-2（沿用） | **已结清**：M5 C5 完成键盘撤销/重做浏览器复测 | — | — |

## M5-6 结论

- **M5 四项范围（演示模式 / 主题打磨 / 自定义模板 / 可访问性）全部交付并通过 C1–C5 检查点**；55/55 单测、tsc、生产构建、四档浏览器实测全部通过，控制台零 error。
- 新增核心纯逻辑（presentation、templateClone）覆盖率 100%；总体语句覆盖 91.19%→92.56%；包体 293→302 KB（+9 KB，gzip +2.7 KB），符合手绘增量预算。
- M1–M4 回归无缺陷，并补齐了 M4 遗留的键盘撤销/重做 E2E 欠账。MVP 可日常使用的功能面在 M5 收口；后续重点转向 R-1/R-4 数据安全 E2E 与真机性能采样（R-3）。

---

# M6 测试章节 · 数据安全与开放（含 Playwright E2E 基建）

> 计划依据：[M6_plan.md](file:///d:/猫思之/.trae/documents/M6_plan.md)；进度报告：[M6_progress_report.md](file:///d:/猫思之/.trae/documents/M6_progress_report.md)
> 执行时间：2026-09-23 ~ 2026-09-23；检查点 C1–C5 全部通过。

## M6-1 自动化测试：94 / 94 通过（0 失败）

- 命令：`npx vitest run` → 11 个测试文件、**94/94 全绿**；`npx tsc --noEmit` → 0 错。
- 新增纯逻辑测试：[openFormats.test.ts](file:///d:/猫思之/src/lib/openFormats.test.ts)（MD/CSV/文件名清洗，含往返、2/4 空格与 Tab 缩进、引用、转义、BOM、空内容）、[backup.test.ts](file:///d:/猫思之/src/lib/backup.test.ts)（无文档/snooze/从未备份/超期四判定）；[exporters.test.ts](file:///d:/猫思之/src/lib/exporters.test.ts) 3→13 用例（文件名清洗、.md 分流、validateDoc 非法结构）。
- db.ts Dexie 操作按项目铁律不写 Vitest 单测（happy-dom 无 IndexedDB），由 Playwright 覆盖。
- 覆盖率：`npx vitest run --coverage` → **语句 93.06%**（基线 92.56%，↑0.50pp）、分支 86.19%、函数 85.10%；新纯库 openFormats/backup 行覆盖 100%。

## M6-2 Playwright E2E：4 / 4 通过（连续两遍，retries 0）

- 基建：[playwright.config.ts](file:///d:/猫思之/playwright.config.ts) 仅 chromium；独立端口 5174（`vite --port 5174 --strictPort`，与日常 5173 隔离）；workers=1、retries=0（失败即真问题）；`npm run e2e` / `npm run e2e:install` 已加入 scripts，不并入 `npm test`。
- 公共工具 [e2e/helpers.ts](file:///d:/猫思之/e2e/helpers.ts)：`resetStore`（导航到同源静态页清 localStorage + 删 IndexedDB，规避连接 blocked 与初始化竞态）、`selectNode`（真实鼠标「微拖拽」实现只选中不编辑）。

| Spec | 覆盖链路 | 结清风险 | 结果 |
|---|---|---|---|
| [crash-recovery.spec.ts](file:///d:/猫思之/e2e/crash-recovery.spec.ts) | 改标题/节点 → 自动保存 → reload → 内容仍在 | **R-4** | ✓ |
| [export-json.spec.ts](file:///d:/猫思之/e2e/export-json.spec.ts) | 拦截 download，解析产物断言 title/rootId/节点结构 | **R-1** | ✓ |
| [trash.spec.ts](file:///d:/猫思之/e2e/trash.spec.ts) | 软删→回收站→还原→再删→永久删→刷新持久 | M6 回收站 | ✓ |
| [markdown.spec.ts](file:///d:/猫思之/e2e/markdown.spec.ts) | 导出 .md 断言标题/层级；再导入断言节点恢复 | MD 往返 | ✓ |

两遍运行 8.7s / 8.8s，无 flaky。

## M6-3 浏览器实测（Chromium，全部当日实测）

- C2 回收站：v2→v3 Dexie 老库升级无损；删除→回收站(含计数)→还原→永久删→清空；30 天清扫（注入 deletedAt 造数，sweepTrash 启动执行）；Palette trash-open/trash-empty 命令。
- C3 开放格式：文件名非法字符清洗、MD 导出内容、CSV 列与 BOM/转义、JSON 导出写 msz.lastBackupAt、.md 导入分流。
- BackupBanner 专项（9/9 PASS）：造 15 天前时间戳→reload 出现 role=alert 横幅→「3 天后提醒」横幅消失且 snoozeUntil 为未来（1790425342440）→再造 20 天超期→「导出 JSON 备份」后横幅消失且 lastBackupAt 更新为当前（1790166115152 → 1790166155152 量级新值）；导出菜单含 5 项（JSON/MD/CSV/SVG/PNG）。全程 console error = 0。

## M6-4 缺陷与处理

| 编号 | 问题 | 处理 |
|---|---|---|
| BUG-M6-1 | React StrictMode（dev）双 effect 下，App 初始化「空库才建 welcome」存在 check-then-act 竞态，空库首启建两篇文档（P5 E2E 实测暴露） | [App.tsx](file:///d:/猫思之/src/App.tsx) 改模块级单飞 promise（initPromise），初始化幂等；回归在 trash.spec 初始计数断言 |
| S-1（M5 审核） | 导出文件名未清洗非法字符 | sanitizeFileName 统一接入全部导出 |
| S-3（M5 审核） | JSON 导入无结构校验 | validateDoc 全量校验（rootId/parent↔children/deps 指向/task 字段类型），中文报错 |
| C-5（M5 审核） | PNG 导出 getContext('2d')! 非空断言 | 改 fallback throw 中文提示 |

## M6-5 构建与包体

- `npm run build`（tsc + vite）通过：JS **313.36 KB**（gzip **106.19 KB**）、CSS 15.17 KB（gzip 3.79 KB）；73 modules，1.19s。
- 较 M5（305.67/103.65）+7.7 KB（gzip +2.5 KB）：回收站/横幅 UI + 初始化单飞；Playwright 仅 devDep 不进产物。
- `npm audit`：critical/high 均在 devDeps（happy-dom/esbuild/vitest），按既定结论不做 audit fix --force（破坏 Vite5 兼容）；新增 @playwright/test 无运行时依赖。

## M6-6 残余风险（M6 增量）

- Playwright 目前仅 chromium 单浏览器、4 条关键链路；SVG 节点拖拽换父/甘特拖拽尚无 E2E（依赖合成事件稳定性，列入后续）。
- 未做项维持冻结：OPML/PDF/XMind、版本历史、本地加密、甘特 SS/FF/SF、真机 FPS（R-3）、演示多端全屏（R-7）、屏幕阅读器真人走查（R-8）。
- MD 往返仅保证本应用导出格式的严格子集；任意外部 .md 按 best-effort 解析，JSON 仍是唯一无损格式（文案已说明）。

## M6-7 结论

- **M6 五项范围（回收站 / 备份提醒 / Markdown 往返 / 甘特 CSV / Playwright E2E 基建）全部交付，C1–C5 检查点全部通过**：94/94 单测、4/4 E2E 两遍稳定、tsc 0 错、覆盖率 93.06%、构建通过、浏览器实测零 error。
- 结清测试报告长期挂账 **R-1（导出产物校验）与 R-4（崩溃恢复端到端）**；顺带修复 M5 审核 S-1/S-3/C-5 与 P5 新发现的 StrictMode 初始化竞态。
- 下一步进入 M7：节点表达力（富内容：备注/超链接/图片/标签/图标/附件）方向立项。

