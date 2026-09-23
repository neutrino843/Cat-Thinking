---
name: maosizhi-test-runbook
description: 执行猫思之项目的完整测试流程并产出 TEST_REPORT.md。当用户要求测试本项目、跑覆盖率、验收某个里程碑或出测试报告时使用。不适用于其它仓库。
---

# 猫思之测试手册

## 何时使用
本工作区（猫思之 React 18 + TS + Vite + Zustand + Dexie）的测试、覆盖率采集、里程碑验收、测试报告产出。

## 技术栈与资产
- Vitest 2.1 + happy-dom（环境），v8 覆盖率
- 单测位置：`src/**/*.test.ts`；共享 fixture：`src/test/fixture.ts`（buildFixture / simpleFixture，节点 id 约定 n0=root, n1=a, n2=a1, n3=b）
- 配置：`vitest.config.ts`（environment happy-dom，exclude measure.ts，coverage.include 为 `src/lib/**` + `src/store/docStore.ts`）
- 脚本：`npm test` / `npm run test:watch` / `npm run coverage`

## 标准流程

### 1. 准备
- 启动 dev server：`npm run dev`（http://localhost:5173），建议后台运行
- 确认依赖已装（happy-dom 15+）

### 2. 单测 + 覆盖率
```powershell
npm run coverage
```
读取终端输出与 `coverage/coverage-summary.json`。**全绿才进入下一步**；任一失败必须先定位修复，不得跳过。

### 3. 构建校验
```powershell
npm run build
```
确认 tsc 无错、产物大小合理（基线：M4 ~293 KB / gzip 100 KB；M5 ~302 KB / gzip 102.7 KB，CSS ~13.3 KB）。

### 4. 浏览器冒烟
调用 browser_use agent。**所有 DOM 操作必须用 `browser_evaluate` 注入 IIFE `(()=>{ ... })()` 并 return 数值**——SVG 节点无法被普通 click 命中。常用注入脚本见 [references/smoke-scripts.md](references/smoke-scripts.md)。必测点：
- 页面加载成功、`browser_console_messages` 零 error
- 导图 / 甘特视图切换
- 建任务 + FS 依赖箭头 + 撤销（工具栏按钮 + 键盘 Ctrl+Z / Ctrl+Shift+Z；派发键盘事件前先 `document.activeElement.blur()`）
- 里程碑菱形切换、日 / 周 / 月缩放
- 搜索高亮 + Enter 跳转、Ctrl+K 命令面板、深浅主题切换
- **M5 增量必测点**：演示模式（开始→ArrowRight 翻页 n/total 递增→Esc 退出恢复）、减少动效开关（html[data-reduce-motion] 与 computed animation-name）、噪点层在 #world 外且序列化导出不含 feTurbulence、自定义模板存/建/删全链路、aria 角色属性（tablist/tab/dialog/navigation/节点 role=button）。M5 专用脚本见 [references/smoke-scripts.md](references/smoke-scripts.md) §10–14

### 4.1 browser_use 预算纪律（重要）

- 单个 browser agent 约 60 步预算，一轮全量冒烟（10+ 检查点 × 多步）必然超预算被截断。**主动拆成 2–3 个短 agent**（如 A 甘特交互 / B 导图+演示 / C 模板+aria），每个只负责 5–7 个检查点。
- 每个 `browser_evaluate` 只放**同步代码并立即 return 普通值**；等待交给 browser_wait_for，不要在注入脚本里返回 Promise（该桥接常吞掉 Promise 结果得到 undefined）。
- 脚本被截断在某步时，新 agent 从该步继续，不要从头重跑（会在本地 IndexedDB 残留测试任务/模板；模板残留用 references §13 的清理脚本处理）。

若 `browser_navigate` 连续返回「No URL loaded」，先用 `Invoke-WebRequest http://localhost:5173/` 确认 HTTP 200；若 200 则判定为浏览器工具基础设施故障，停止冒烟并在报告如实标注，**不得伪造通过**。

### 5. 产出报告
写入 `d:\猫思之\TEST_REPORT.md`，必须包含：
1. 测试范围（层 / 类型 / 工具表）
2. 用例明细（文件 / 数量 / 通过情况）
3. 覆盖率表（按文件，来自 coverage-summary.json）
4. 性能实测（若跑了 perf.test.ts，贴真实耗时）
5. PRD 验收对照（逐项 ✅/⚠️/❌）
6. 缺陷单：ID、严重级（Major/Minor/Trivial）、模块、描述、发现方式、状态
7. 残余风险（编号 + 影响 + 建议）
8. 结论
所有文件引用用 `file:///` 绝对路径链接。

## 已知坑（必须遵守）
1. **docStore 测试不能持有状态快照**：每次 `const get = () => useDoc.getState()` 取新鲜状态；持有 `st` 后变更再读 `st.doc` 是旧引用，会大面积假失败。
2. **happy-dom 下 `getContext('2d')` 返回 null**：`measure.ts` 走 fallback，测试不要断言真实字体度量。
3. **SVG 元素 click 无效**：浏览器冒烟一律 `browser_evaluate` 注入脚本操作 DOM。
4. **键盘快捷键需先 blur**：焦点在 INPUT 时 App 键盘处理器提前 return；派发 `KeyboardEvent` 前先 `document.activeElement.blur()`。
5. **Ctrl+Z 方向**：源码为 `e.shiftKey ? s.redo() : s.undo()`，无修饰 = 撤销。
6. **npm audit 告警全在 devDeps**（happy-dom / esbuild / vitest），勿用 `npm audit fix --force`（会破坏 Vite5 兼容）。
7. **浏览器工具偶发「No URL loaded」故障**与应用无关，HTTP 200 可证。
8. **React 受控输入（命令面板 .palette input、搜索框 input.tsearch）程序化赋值必须用原生 value setter**：`const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(el,'文本'); el.dispatchEvent(new Event('input',{bubbles:true}))`。直接 `el.value='x'` 不触发 React onChange，过滤/搜索不生效。
9. **手绘三档几何一致性只能测 `<text>` 锚点 bbox，不能测节点 path**——path 的 d 本身就是抖动生成的，三档必然不同；节点 x/y/w/h 与 text 位置三档完全一致。
10. **里程碑复选框选择器**是 `.task-editor label.te-row input[type=checkbox]`（不存在 `.te-milestone` 类）；时间轴缩放 select 是 `.gantt select.tsel`（不是 `.gantt-scale`）；主题切换按钮按 `aria-label` 含「深色/浅色」找（不是 `.theme-toggle`）；视图按钮是 `.view-switch [role=tab]`。
11. **window.prompt / window.confirm 必须在触发命令前预先替换**为 `() => '名称'` / `() => true`，否则浏览器原生对话框会阻塞自动化。
12. **模板菜单/命令面板等 React 条件渲染**，点击打开后必须 wait 250–400ms 再查询内部元素；动作之间一律留等待（建议建任务 700–900ms、普通切换 300–500ms）。

## 缺陷分级
- **Major**：主功能错误 / 数据错误 / 视觉断裂（如根连接线缺失、撤销语义反转、环检测漏检）
- **Minor**：体验 / 边界（如候选过滤过严、空焦点打历史）
- **Trivial**：文案 / 样式微调

每个缺陷必须：定位根因 → 修复 → 加回归断言 → 记录发现方式（单测/E2E/代码复审）。
