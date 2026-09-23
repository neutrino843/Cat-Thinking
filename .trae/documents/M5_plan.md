# M5 主题与演示 · 实施计划

## 一、仓库调研结论

### 当前阶段
M1–M4 已完成并通过验收（43/43 单测、build 通过、浏览器冒烟通过）。PRD §7 最后一个里程碑 **M5 = 手绘主题打磨 + 模板库 + 演示模式**，验收依据 §4.5（三档手绘几何不变；暗色无纯黑/低对比）。本次经用户确认，范围含四项：**演示模式、主题打磨、另存为模板（P1）、可访问性 aria（P1）**。

### 已具备的基础（不重复造）
- 6 个内置模板（blank/welcome/book/project/meeting/study/swot）已在 [templates.ts](file:///d:/猫思之/src/data/templates.ts)；`buildDoc(tpl)` 从 TplNode 构文档。
- 布局纯函数 [layout.ts](file:///d:/猫思之/src/lib/layout.ts) 返回 `{nodes: Map<id,{x,y,w,h}>, edges, bounds}`；Canvas 已有「居中节点」机制（`msz:center` 事件 + view 变换）和「折叠临时展开 viewDoc」的派生文档模式——演示模式可直接复用同一模式。
- 设置集中在 [settings.ts](file:///d:/猫思之/src/store/settings.ts)（Zustand + localStorage）；命令面板 [Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx) 加命令只需追加 Cmd。
- Dexie 1 版本 [db.ts](file:///d:/猫思之/src/store/db.ts)，仅 `docs` 表；加表用 version(2) 增量升级。
- CSS 已有 `@media (prefers-reduced-motion: reduce)` 占位（[styles.css:782](file:///d:/猫思之/src/styles.css#L782)）。

### 关键约束
- SVG 节点以节点 id 为 key，挂载即播、重渲染不重播的 CSS 动画可行。
- 导出走 `#world` 序列化——噪点纹理必须放在 `#world` **之外**的 DOM 层，避免污染导出。
- 演示派生文档**只做视图过滤**，绝不可写回 store（参照现有 viewDoc 写法）。
- 自定义模板若重映射节点 id，必须同步重映射 `task.deps[].from`，否则依赖悬空。

---

## 二、架构设计与技术选型确认

选型全部沿用 PRD §6.1，**不引入新依赖**：React 18 + TS + Vite + Zustand + Dexie + SVG。

### 演示模式架构（派生视图，零数据侵入）

```ts
// lib/presentation.ts 纯函数（可单测）
interface Slide { focusId: string; visible: string[]; index: number; total: number }
buildSlides(doc): Slide[]
// 规则：slide0 = 仅根节点；之后按 preorder DFS 每揭示一个节点一页
// visible = 截止当前页已揭示节点集合（preorder 保证父先于子）
presentDoc(doc, slide): DocData   // 克隆并裁剪 children 到 visible，供 computeLayout
```

- settings 新增内存态（不持久化）：`presenting:boolean, slide:number` + `startPresenting/exitPresenting/next/prev/setSlide`。
- Canvas 在 presenting 时用 `presentDoc(doc, slides[slide])` 替换 viewDoc 喂给 `computeLayout`；禁用平移/缩放/编辑；对当前焦点节点做居中+适配缩放；world `<g>` 加 200ms transform 过渡（减少动效时关闭）。
- 新增 `components/PresentOverlay.tsx`：纯 DOM 覆盖层（标题、进度条、n/total、上一页/下一页/退出、左右点击热区）。
- 启动时 best-effort 调 `requestFullscreen()`；失败不影响覆盖层演示。

### 自定义模板架构
- Dexie `version(2)` 新增 `templates` 表（`id, createdAt`），存 `{id,name,createdAt,payload: DocData JSON}`，与 docs 同构。
- 新增 `lib/templateClone.ts`：`cloneFromTemplate(doc): DocData`——新文档 id + 全节点 id 重映射（Map old→new），同步重映射 children/parent/task.deps[].from，时间戳刷新。
- Sidebar「新建」菜单分区：内置 / 我的模板（可删）；命令面板加「将当前文档存为模板」（`window.prompt` 取名，与现有 confirm 风格一致）。

### 主题打磨与 a11y
- settings 新增持久化 `reduceMotion`（初始值取 localStorage，缺省回退 `matchMedia('prefers-reduced-motion')`）；`<html data-reduce-motion>` 全局开关。
- 动效：NodeView 挂载动画（opacity+8px 上浮，180ms）、EdgeView 挂载描线（stroke-dashoffset 220ms）；仅挂载触发；`data-reduce-motion=1` 全局 `animation/transition: none`。
- 噪点：`.paper-noise` DOM 覆盖层（内联 feTurbulence SVG data-uri，亮 0.035/暗 0.05 透明度，pointer-events:none），置于 canvas-wrap 与甘特容器内、`#world` 外。
- aria：工具栏按钮 `aria-label`（复用 title）、视图切换 `role=tablist/tab`+`aria-selected`、Sidebar `role=navigation`、搜索框 label、SVG `role="application"`、节点 `<g role="button" aria-label aria-expanded>` + `:focus-visible` 焦点环、PresentOverlay `role="dialog" aria-modal` + `aria-live=polite` 页码。
- 对比度核查：核算 paper↔ink、nodeFill↔ink、rootFill↔rootText、暗/亮各分支色上文字；<4.5:1 的调 token（预计仅 inkSoft 装饰用法，不承载正文）。

---

## 三、文件与模块清单

| 文件 | 改动 |
| --- | --- |
| `src/lib/presentation.ts` | 新增：buildSlides / presentDoc 纯函数 |
| `src/lib/presentation.test.ts` | 新增：单测 |
| `src/lib/templateClone.ts` | 新增：模板克隆 + id/deps 重映射 |
| `src/lib/templateClone.test.ts` | 新增：单测 |
| `src/store/settings.ts` | 新增 presenting/slide/reduceMotion 及动作；data-reduce-motion 同步 |
| `src/store/db.ts` | Dexie version(2)：templates 表 + CRUD（listTemplates/saveTemplate/deleteTemplate） |
| `src/components/PresentOverlay.tsx` | 新增：演示覆盖层（控件/进度/热区） |
| `src/components/Canvas.tsx` | presenting 时派生 presentDoc、居中焦点、禁用交互、挂载动画类、SVG/节点 aria |
| `src/components/Toolbar.tsx` | 演示入口按钮（仅 mind）、aria-label、减少动效入口放命令面板 |
| `src/components/Palette.tsx` | 加 3 命令：开始演示/退出演示、存为模板、切换减少动效 |
| `src/components/Sidebar.tsx` | 新建菜单分区渲染自定义模板 + 删除；存模板动作 |
| `src/components/Gantt.tsx` | 容器内噪点层、aria-label |
| `src/App.tsx` | 渲染 PresentOverlay；presenting 时键盘拦截（←→/Space/Home/End/Esc） |
| `src/styles.css` | 挂载动画 keyframes、reduce-motion 全局开关、噪点层、焦点环、演示覆盖层样式 |
| `TEST_REPORT.md` | 末期追加 M5 验收段 |

---

## 四、实施步骤（依赖顺序）与阶段检查点

> 进度跟踪机制：每阶段一个 Todo 任务；检查点须满足「退出标准」才进入下一阶段；计划文件勾选进度。

### P1 基础设施与纯逻辑（无 UI，可全量单测）
1. settings.ts 扩展（presenting/slide/reduceMotion，仅 reduceMotion 持久化）。
2. db.ts 升级 version(2) 加 templates 表与 CRUD。
3. lib/presentation.ts + 单测；lib/templateClone.ts + 单测。
4. **检查点 C1**：新增单测全绿，既有 43 个无回归，tsc 通过。

### P2 演示模式
5. Canvas 接入 presentDoc + 焦点居中（复用 view 变换，加过渡）、交互禁用。
6. PresentOverlay 组件（进度/控件/热区/aria）。
7. App 键盘路由 + Toolbar 按钮 + Palette 2 条命令 + Fullscreen best-effort。
8. **检查点 C2**：浏览器实测 开始→逐页揭示→←/→/Space/Home/End→Esc 退出；页数=节点数；store 文档不被改写（退出后结构原状）。

### P3 主题打磨
9. settings.reduceMotion 与 `<html data-reduce-motion>` 同步 + Palette 开关命令。
10. NodeView/EdgeView 挂载动画；全局 reduce-motion 关闭。
11. `.paper-noise` 噪点层接入 Canvas/Gantt（导出 SVG/PNG 确认不含噪点）。
12. 对比度核算与 token 微调（如有不达标）。
13. **检查点 C3**：三档手绘切换几何不变（既有验收）；动效可一键/系统级关闭；导出产物无噪点；暗色无纯黑。

### P4 自定义模板 + a11y
14. Sidebar 模板菜单分区 + 自定义模板删除；「存为模板」命令（templateClone 落库）。
15. aria 标注与 :focus-visible 焦点环；PresentOverlay 对话框语义。
16. **检查点 C4**：存模板→新建文档结构/任务/依赖完整且 id 全新→删模板；全键盘走查（Tab 顺序、焦点可见）。

### P5 集成验证与报告
17. `npm run coverage` 全绿 + `npm run build`；按 maosizhi-test-runbook 浏览器冒烟（含 M5 新用例）；TEST_REPORT.md 追加 M5 章节（用例/结果/缺陷分级）。
18. **检查点 C5（交付）**：单测/构建/浏览器三层全绿，M5 验收项逐条闭环。

---

## 五、依赖与注意事项

- Dexie version(1→2) 为增量加表，老用户本地库打开即自动升级；需在真实浏览器（非仅单测）验证升级后旧文档仍可打开。
- happy-dom 无真实 IndexedDB：db CRUD 不单测，靠浏览器冒烟；可测的纯逻辑全部放 lib。
- 演示/搜索的派生文档模式不得混用：presenting 与 query 同时存在时，presenting 优先（演示中隐藏搜索 UI 或忽略 query）。
- 演示中节点揭示动画依赖「从隐藏变挂载」，天然复用挂载 keyframes，无需额外编排。
- requestFullscreen 返回 Promise 可能 reject（权限/iframe），catch 静默。
- Esc 在全屏下浏览器也会退出全屏——以「退出演示」为唯一处理，不阻止默认全屏退出，避免按键卡死。

## 六、验证方案

- 单测新增：presentation（页数=节点数、visible 单调、父先于子、裁剪后根仍连通）、templateClone（结构一致、id 全换新、deps 正确重映射、时间戳刷新）。
- 回归：既有 43 用例不允许失败；覆盖率核心 lib 仍 ≥95%。
- 浏览器冒烟（browser_evaluate 注入）：演示全链路、减少动效开关、噪点不进导出、自定义模板 CRUD、aria spot、console 零 error。
- 构建：tsc --noEmit + vite build。

## 七、风险与对策

| 风险 | 对策 |
| --- | --- |
| 挂载动画在大文档（1000 节点）卡顿 | 动画仅 transform/opacity（合成层）；reduce-motion 可关；性能冒烟保留 perf.test |
| 演示裁剪误伤原文档 | 纯函数返回克隆对象；单测断言输入 doc 引用不变；退出演示后 store 状态比对 |
| Dexie 升级失败导致文档库不可开 | 仅加表不改 docs schema；浏览器实测升级路径；异常时降级提示导出备份 |
| 焦点环/aria 影响手绘视觉 | focus-visible 仅键盘聚焦时显示，鼠标点击不出环；配色用 accent 不抢眼 |
| 范围蔓延（PDF/关系线等 Backlog） | 一律不纳入，M5 冻结为本计划四项 |
