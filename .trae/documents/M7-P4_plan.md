# M7-P4 实施计划 · 布局扩展（org / fishbone / timeline）+ 大纲移动端按钮

## Context

M7 阶段 P1–P3 已交付节点富内容（标签/图标/富备注/多链接/图片/附件）。P4 是 M7_plan.md 规定的下一检查点：在现有 `logic` / `tree` 两种布局基础上，新增 `org`（组织架构图）、`fishbone`（鱼骨图）、`timeline`（时间轴）三种布局，并把大纲的层级调整从「仅键盘」扩到「移动端按钮可触达」。

驱动来源：用户 2026-09-23 新增需求「组织架构图、鱼骨图、时间轴」+ 大纲移动端入口缺失（PRD §一 现状差距表）。验收检查点 C4：三布局切换节点数不变 / bounds 合理 / timeline 无日期兜底 / 浏览器零 error / 大纲按钮全链路。

预期结果：用户在 Toolbar 布局 select 与 Palette 命令里可切 5 种布局；同一文档切换后节点数与层级关系不变；大纲每行有 `←/→` 升降级按钮，复用现有 `.ob.act` 样式，无新增 store action。

## 范围（In Scope）

1. `LayoutKind` 扩展 `'org' | 'fishbone' | 'timeline'`。
2. `src/lib/layout.ts` 重构为策略分发：保留 `computeLayout` 单入口，内部分发到 5 个分支函数（layoutLogic / layoutTree / layoutOrg / layoutFishbone / layoutTimeline），共享 `measure` / `build` / `boundsOf` / `rootEdge`。
3. 三种新布局算法（伪代码见下）。
4. `Outline.tsx` 新增升级（←）/ 降级（→）按钮，复用 `reparent`，根节点与首子节点分别禁用。
5. `Toolbar.tsx` select 加 3 项；`Palette.tsx` 加 3 个命令。
6. `layout.test.ts` 扩展 5 个 `it`（org/fishbone/timeline 几何 + 节点数守恒 + bounds）。

## 不纳入（Out of Scope）

- 布局微调参数（fishbone 角度 / timeline 行高）暴露到 settings：M7_plan.md 表述为「可」非「必」，首版固化常量；如验收后需要再补。
- 脊线显式绘制：fishbone 的脊线由一级分支几何排列暗示，避免改 Canvas 渲染层。
- 新增 E2E spec：大纲按钮靠浏览器冒烟覆盖；现有 Playwright spec 不扩。

## 关键文件

| 路径 | 性质 | 关键改动 |
|---|---|---|
| [src/types.ts](file:///d:/猫思之/src/types.ts) | 修改 | `LayoutKind` 加 `'org' \| 'fishbone' \| 'timeline'`；删第 1 行「M7-P4 将扩展」注释 |
| [src/lib/layout.ts](file:///d:/猫思之/src/lib/layout.ts) | 修改 | WT 加 `subW`；新增 `layoutOrg/layoutFishbone/layoutTimeline`；`computeLayout` 改 switch 分发；常量 `GY_TOP=28`/`LEVEL1_GAP=70`/`COL_GAP=120`/`FISH_ANG=30°` |
| [src/lib/layout.test.ts](file:///d:/猫思之/src/lib/layout.test.ts) | 修改 | 新增 5 个 `it`：org 根在顶 / fishbone 根在右 / timeline DFS 兜底 / 节点数守恒 / bounds 含全部 |
| [src/components/Outline.tsx](file:///d:/猫思之/src/components/Outline.tsx) | 修改 | `＋` 与 `✕` 之间插入 `‹`(升级) `›`(降级) 两按钮；onClick 调 `reparent`；首子/根禁用 |
| [src/components/Toolbar.tsx](file:///d:/猫思之/src/components/Toolbar.tsx#L90-L99) | 修改 | select 加 3 个 `<option>` |
| [src/components/Palette.tsx](file:///d:/猫思之/src/components/Palette.tsx#L45-L46) | 修改 | 加 3 个 `layout-org/fishbone/timeline` 命令 |

预估总改动 ≈ +317 行；layout.ts 单文件最大。

## 复用的现有基建（不重写）

- `measure(text, level, hasNote, images?)` → [layout.ts:88](file:///d:/猫思之/src/lib/layout.ts#L88) ：5 种布局共用尺寸函数，含 M7-P3 的 `imgH`。
- `build(doc, id, level)` → [layout.ts:97](file:///d:/猫思之/src/lib/layout.ts#L97) ：递归建 WT 树，已有 `subH`/`hidden`；org 增 `subW`（叶子=w，父=max(Σkids.subW + GY*(n-1), w)）。
- `boundsOf(out)` ：现内联在 [layout.ts:218-227](file:///d:/猫思之/src/lib/layout.ts#L218-L227) ，重构为独立函数 5 个分支共用。
- `rootEdge(k, kx, ky, side, color)` → [layout.ts:168](file:///d:/猫思之/src/lib/layout.ts#L168) ：logic/tree 用；新布局各写自己的 edge push，但 points 仍 8 数字三次贝塞尔格式。
- `docStore.setLayout(kind)` → [docStore.ts:119](file:///d:/猫思之/src/store/docStore.ts#L119) ：不进历史栈，沿用。
- `docStore.reparent(id, newParentId)` → [docStore.ts:199](file:///d:/猫思之/src/store/docStore.ts#L199) ：Outline 升降级复用，拒绝自环与挂到后代。
- `EdgeView` cubicPts → [Canvas.tsx:62](file:///d:/猫思之/src/components/Canvas.tsx#L62) ：硬解码 8 数字贝塞尔，所有新布局 edge 必须沿用此格式；直线退化为 c1=c2=midpoint。
- `NodeView` badgeX → [Canvas.tsx:204](file:///d:/猫思之/src/components/Canvas.tsx#L204) ：角标基于 `n.side`，新布局给 side 合理值即可。
- `buildSVG` viewBox → [exporters.ts:121](file:///d:/猫思之/src/lib/exporters.ts#L121) ：用 `computeLayout(doc).bounds` 自动适配，零改动。
- `buildSlides` → [presentation.ts](file:///d:/猫思之/src/lib/presentation.ts) ：先序 DFS 与 layout 无关，演示模式自动套用当前布局。

## 三种布局算法（伪代码）

### org（组织架构图）

根在顶部居中，子节点向下展开，同层水平排布居中。

```
build 增 subW：叶子 subW=w；父 subW=max(Σkids.subW + GY*(n-1), w)
layoutOrg(doc, rootWt, out, edges):
  placeOrg(rootWt, cx=0, top=0, level=0, color='')
placeOrg(wt, cx, top, level, color):
  out.set(wt.id, {x: cx-wt.w/2, y: top, side:1, level, color, ...wt})
  if !wt.kids: return
  totalW = Σkids.subW + GY*(n-1)
  x = cx - totalW/2
  for k in kids:
    kcx = x + k.subW/2
    ky = top + wt.h + GY_TOP   # GY_TOP=28
    edge: [cx, top+wt.h, cx, top+wt.h+GY_TOP/2, kcx, top+wt.h+GY_TOP/2, kcx, ky+k.h/2]
    placeOrg(k, kcx, ky, level+1, color)
    x += k.subW + GY
```

### fishbone（鱼骨图）

根=鱼头在最右，脊线水平向左延伸；一级分支斜向上/下交替。

```
SPINE_Y = rootY + rootH/2
LEVEL1_GAP = max(70, max(kid.subW)+20)
layoutFishbone(doc, rootWt, out, edges):
  out.set(rootId, {x:0, y:0, side:1, level:0, color:''})
  for i,k in kids:
    dir = i%2==0 ? +1 : -1    # +1 上斜 / -1 下斜
    branchX = rootWt.w + GX + (i+1)*LEVEL1_GAP
    branchY = SPINE_Y
    # root → 分支起点的边（直角折线贝塞尔）
    edge: [rootWt.w, SPINE_Y, rootWt.w+GX/2, SPINE_Y, rootWt.w+GX/2, branchY+dir*k.h/2, branchX, branchY+dir*k.h/2]
    placeFish(k, branchX, branchY, dir, level=1, color='b'+i%6, out, edges)
placeFish(wt, bx, by, dir, level, color, out, edges):
  # 子节点沿分支线水平排列（保持斜率视觉由边体现）
  out.set(wt.id, {x: bx, y: by + dir*level*8, side: dir>0?1:-1, level, color, ...wt})
  cur = 0
  for c in wt.kids:
    step = c.w + 20
    nx = bx + cur + step
    ny = by + dir*level*8
    edge: [bx+wt.w, by+wt.h/2, (bx+wt.w+nx)/2, by+wt.h/2, (bx+wt.w+nx)/2, ny+c.h/2, nx, ny+c.h/2]
    placeFish(c, nx, ny, dir, level+1, color, out, edges)
    cur += step
# 脊线不显式绘制：靠一级分支边几何排列暗示（避免 from==to 被 EdgeView 跳过）
```

### timeline（时间轴）

水平主轴，节点按 `task.start` 排序（无则按 DFS 序兜底），上下交错。

```
flatList = 先序 DFS 收集所有可见非根节点
key(n) = n.task?.start ? Date.parse(start) : -(DFS index)   # 无 start 兜底用负序号
flatList.sort((a,b) => key(a) - key(b))   # 稳定排序
AXIS_Y = 0; ROW_H = 28; COL_GAP = 120
layoutTimeline(doc, rootWt, out, edges):
  out.set(rootId, {x: 0, y: AXIS_Y - rootWt.h/2, side:1, level:0, color:''})
  stack = new Map<dateStr, count>()   # 同日期堆叠计数
  baseX = rootWt.w + GX
  for i, n in flatList:
    side = i%2==0 ? 1 : -1
    dateKey = n.task?.start ?? '__dfs__'+i
    stackCount = stack.get(dateKey) ?? 0
    stack.set(dateKey, stackCount+1)
    x = baseX + i*COL_GAP
    y = AXIS_Y + side*(ROW_H*(stackCount+1))
    out.set(n.id, {x, y:y-n.h/2, side, level:1, color:'', ...wt(n)})
    # parent → n 的边：直角折线贝塞尔
    p = out.get(n.parent)!
    edge: [p.x+p.w/2, p.y+p.h/2, p.x+p.w/2, y, x, y, x, y-n.h/2]
```

## LaidNode / LaidEdge 字段

**零扩展**。`side: 1|-1` 已够：org/timeline 全 1；fishbone 一级分支 +1/-1 区分上下。EdgeView (Canvas.tsx:62) 硬解码 8 数字贝塞尔，新增字段需改渲染层，违反「渲染层不动」约束。WT 内部新增 `subW`（org 用），不外泄到 LaidNode。

## Outline.tsx 升降级按钮

按钮顺序：`fold | input | ‹(升级) | ＋(建子) | ›(降级) | ✕(删除)`，紧凑且语义相邻。

```tsx
// 升级：当前节点提升为父节点的兄弟（挂到祖父 children 末尾）
const onOutdent = () => {
  const p = n.parent!
  if (!p || p === st.doc.rootId) return   // 根或父是根时禁用
  const grandpa = st.doc.nodes[p].parent
  if (grandpa) st.reparent(id, grandpa)
}
// 降级：当前节点降为前一兄弟的子节点
const onIndent = () => {
  const p = n.parent!
  if (!p) return                          // 根禁用
  const sibs = st.doc.nodes[p].children
  const idx = sibs.indexOf(id)
  if (idx <= 0) return                    // 首子禁用
  const prev = sibs[idx - 1]
  // 若 prev 折叠，先展开以保证视觉反馈
  if (st.doc.nodes[prev].collapsed) st.toggleCollapse(prev)
  st.reparent(id, prev)
}
```

样式复用 `.ob.act`（hover 显隐已设好），新增修饰类 `.ob.act.indent` / `.outdent` 仅作 `title` 区分，不新增 CSS 规则。

## 验证（C4 对照）

| 验收条 | 验证方式 | 工具 |
|---|---|---|
| 三布局切换节点数不变、bounds 合理 | layout.test.ts `节点数守恒` + `bounds 含全部` | Vitest |
| timeline 无日期按 DFS 序兜底 | layout.test.ts `timeline DFS 兜底` | Vitest |
| 浏览器零 error | 手动冒烟：5 种 layout 各切一遍，开 devtools console | browser_use |
| 大纲按钮全链路 | 手测：升降级禁用态、操作后 parent/children 正确、折叠角标更新 | browser_use |

完整流程（按 maosizhi-test-runbook）：
1. `npm run dev` 后台
2. `npm run coverage` → 全绿才进下一步
3. `npm run build` → tsc 0 + 体积 gzip 增量 ≤ +12KB（C5 门禁，P4 预算 ~3KB）
4. browser_use 冒烟：5 布局切换 + 大纲升降级 + 演示模式 + 导出 SVG viewBox 正确
5. 产出 `TEST_REPORT.md` 追加 M7-P4 章节
6. 中文 conventional commit `feat(M7-P4): org/fishbone/timeline 三布局 + 大纲升降级按钮` + push origin/main

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| org 子树过宽兄弟重叠 | 视觉错乱 | `subW` 精确累积 + 单测断言「兄弟 x 区间不重叠」 |
| fishbone 分支节点贴边 | 视觉拥挤 | `LEVEL1_GAP = max(70, max(kid.subW)+20)` |
| fishbone 脊线不显示 | 鱼骨感弱 | 靠一级分支边几何排列暗示；首版接受，必要时 M7-P5 补 |
| timeline 同日期堆叠溢出主轴 | 节点跨度过大 | `stack` Map 按日期分组，组内垂直堆叠；COL_GAP=120 留足水平间距 |
| Outline 降级到折叠节点后不可见 | 用户困惑 | 降级 onClick 先 `toggleCollapse(prev)` 展开 |
| 演示模式 buildSlides 与新布局不兼容 | 演示错乱 | buildSlides 是先序 DFS，与 layout 无关；presentDoc 保留 layout 字段，自动套用 |
| 导出 viewBox 错位 | 导出 SVG 切角 | buildSVG 用 computeLayout(doc).bounds 自动适配，零改动 |

## 与 PRD/M7_plan 对照

- M7_plan §三 3.3：org/fishbone/timeline 三种、统一布局切换、层级关系不变 — ✅ 全覆盖
- M7_plan §四 C4：三布局切换节点数不变 / bounds 合理 / timeline 兜底 / 浏览器零 error / 大纲按钮全链路 — ✅ 全对照
- M7_plan §五 文件级 P4：layout.ts 策略重构 + org/fishbone/timeline + 单测；Outline.tsx 按钮组 + styles.css — ✅ 全对齐
