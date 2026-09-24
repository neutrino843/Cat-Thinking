# M5 已完成代码审核清单

> 审核时间：2026-09-23
> 审核范围：`src/` 下 M1–M5 全部交付代码（v0.3.0，55 单测基线）
> 审核维度：功能性 / 性能 / 安全 / 规范 / 逻辑
> 已知历史缺陷 BUG-001~006、IMP-001 已修并在库回归，不计入本清单

## 一、问题汇总

| 等级 | 计数 | 处置原则 |
|---|---|---|
| P0（阻断/数据丢失） | 0 | — |
| P1（用户可见/明显退化） | 8 | M6 期间优先修或立卡 |
| P2（边界/潜在） | 16 | M6 顺带修或入 Backlog |
| P3（规范/微小） | 9 | 后续迭代收敛 |
| **合计** | **33** | |

## 二、功能性缺陷

| ID | 等级 | 位置 | 问题 | 整改建议 |
|---|---|---|---|---|
| F-1 | P1 | [settings.ts:76](file:///d:/猫思之/src/store/settings.ts#L76) | `sketch` 持久化值 `0`（简洁档）被 `Number(...) || 1` 回退为 1，重启后用户设置丢失 | 改 `?? 1` 或显式判空 |
| F-2 | P1 | [Gantt.tsx:41](file:///d:/猫思之/src/components/Gantt.tsx#L41) | `'日一二三四五六'[new Date(d).getDay()]` 用 `new Date('YYYY-MM-DD')` 解析为 UTC 午夜，跨时区星期错位 | 改用 `parseISO(d).getDay()`（已有 [date.ts](file:///d:/猫思之/src/lib/date.ts) 工具） |
| F-3 | P2 | [db.ts:70](file:///d:/猫思之/src/store/db.ts#L70) | `loadDoc` 内 `JSON.parse(s.payload)` 无 try-catch；[Sidebar.tsx:42](file:///d:/猫思之/src/components/Sidebar.tsx#L42) 与 [App.tsx:37](file:///d:/猫思之/src/App.tsx#L37) 调用未 catch，payload 损坏即抛未处理 rejection | 包 try-catch + 中文提示 |
| F-4 | P2 | [exporters.ts:74-81](file:///d:/猫思之/src/lib/exporters.ts#L74-L81) | `exportCurrent` 用 `setTimeout(80ms)` 等 React 重渲染后取 `innerHTML`；慢机/大文档可能仍含选中虚线框 | 改 `requestAnimationFrame` 双帧或 `flushSync` |
| F-5 | P2 | [Gantt.tsx:129](file:///d:/猫思之/src/components/Gantt.tsx#L129) | resize 拖拽 `Math.max(0, delta)` 使 `delta<0`（向左缩）被钳为 0，无法缩短 end | 改为允许负 delta 或对称处理 |
| F-6 | P2 | [Canvas.tsx:351-403](file:///d:/猫思之/src/components/Canvas.tsx#L351-L403) | shift/ctrl+click 单选后 `selection.length===1` 仍触发 `beginEditAt`，与多选语义冲突 | 单选与 additive 区分 |
| F-7 | P2 | [docStore.ts:173](file:///d:/猫思之/src/store/docStore.ts#L173) | `setText` 用 `commit:false` 但 `upd` 仍清空 `future`；撤销后输入任意字符即丢 redo 链 | 文本编辑态不清 future |
| F-8 | P2 | [Gantt.tsx:106-139](file:///d:/猫思之/src/components/Gantt.tsx#L106-L139) / [Canvas.tsx:325-342](file:///d:/猫思之/src/components/Canvas.tsx#L325-L342) | `startDrag`/`startPan` 在 window 挂 pointermove/up，拖拽中切视图卸载组件监听不清理 | effect 统一管理或 cleanup |
| F-9 | P3 | [persist.ts:26](file:///d:/猫思之/src/store/persist.ts#L26) | `beforeunload` 内 `flush()` 调 `saveDoc`（async），浏览器不等待；极端情况最后 700ms 未落盘 | 已有 visibilitychange 兜底，影响有限 |

## 三、性能问题

| ID | 等级 | 位置 | 问题 | 整改建议 |
|---|---|---|---|---|
| P-1 | P1 | [docStore.ts:173](file:///d:/猫思之/src/store/docStore.ts#L173) | `setText` 每次按键整表浅拷贝 `{ ...s.doc.nodes, [id]: {...n, text} }`；千节点每键 O(n) 卡顿 | 局部更新或 immer |
| P-2 | P1 | [Canvas.tsx:378-389](file:///d:/猫思之/src/components/Canvas.tsx#L378-L389) | 节点拖拽 `onMove` 每次 pointermove 遍历 `layoutRef.nodes.values()` 找命中 O(n) | 空间索引或 bounds 预筛 |
| P-3 | P1 | [gantt.ts:111-114](file:///d:/猫思之/src/lib/gantt.ts#L111-L114) | `wouldCreateCycle` 每次 `addDep` 对全表 `Object.entries(nodes)` 反向边扫描 O(n²) | 预建 from→[to] 邻接表 |
| P-4 | P2 | [measure.ts:4](file:///d:/猫思之/src/lib/measure.ts#L4) | `cache` Map 无上限，长会话+大量文本持续增长内存 | LRU 或 size 阈值清理 |
| P-5 | P2 | [Gantt.tsx:218-223](file:///d:/猫思之/src/components/Gantt.tsx#L218-L223) | 周末底纹 `Array.from().filter().map()` 未 `useMemo`，每次重渲染重算 | useMemo 缓存 |
| P-6 | P3 | [TaskEditor.tsx:8](file:///d:/猫思之/src/components/TaskEditor.tsx#L8) | `useDoc((s)=>s.doc.nodes)` 订阅整个 nodes map，任意节点变更重渲染候选列表 | 缩窄 selector |

## 四、安全漏洞

| ID | 等级 | 位置 | 问题 | 整改建议 |
|---|---|---|---|---|
| S-1 | P2 | [exporters.ts:17,43,62,85,87](file:///d:/猫思之/src/lib/exporters.ts#L17) | 文件名 `猫思之-${doc.title}.xxx` 直接拼用户输入 title，未过滤 `\\ / : * ? " < > |`；部分浏览器下载失败或路径穿越 | **M6 P3 已纳入**：统一 `sanitizeFileName` |
| S-2 | P2 | [exporters.ts:34,36](file:///d:/猫思之/src/lib/exporters.ts#L34) | `buildSVG` 直接拼 `worldHTML`（`worldHolder.innerHTML`）；含 `foreignObject`/`<a href>` 时打开 SVG 可执行脚本 | 导出前白名单过滤或收敛 xlink |
| S-3 | P2 | [exporters.ts:65-71](file:///d:/猫思之/src/lib/exporters.ts#L65) | `parseImported` 仅校验 `rootId` 与 `nodes[rootId]` 存在，不校验 parent/children 一致性、`deps.from` 指向、字段类型 | 补 zod 模式校验 |
| S-4 | P3 | [db.ts:70](file:///d:/猫思之/src/store/db.ts#L70) | `JSON.parse(s.payload) as DocData` 类型断言无运行时校验 | 同 S-3 |
| S-5 | P3 | [Outline.tsx:65](file:///d:/猫思之/src/components/Outline.tsx#L65) | `querySelector(input[data-oid="${editing.id}"])` 拼 id；id 均为 uuid 安全，但导入外部 id 需防注入 | 属性选择器转义或改 ref |

## 五、代码规范

| ID | 等级 | 位置 | 问题 | 整改建议 |
|---|---|---|---|---|
| C-1 | P3 | [Gantt.tsx:246](file:///d:/猫思之/src/components/Gantt.tsx#L246) | `fontSize={scale === 'day' ? 10 : 10}` 三元两支同值冗余 | 删三元 |
| C-2 | P3 | [Gantt.tsx:287](file:///d:/猫思之/src/components/Gantt.tsx#L287) | `const ex = tg.milestone ? tg.x : tg.x` 同上 | 删三元 |
| C-3 | P3 | [Gantt.tsx:25](file:///d:/猫思之/src/components/Gantt.tsx#L25) | `branchColors(doc: ReturnType<typeof useDoc.getState>['doc'])` 反查类型 | 直接 `DocData` |
| C-4 | P3 | [Canvas.tsx:11-12](file:///d:/猫思之/src/components/Canvas.tsx#L11-L12) | `JT=[0,1.4,2.6]` `PS=[1,2,2]` 魔法数字数组 | 命名常量+注释 |
| C-5 | P3 | [exporters.ts:58,108](file:///d:/猫思之/src/lib/exporters.ts#L58) | `canvas.getContext('2d')!` 非空断言；getContext 极端返回 null | fallback |
| C-6 | P3 | [docStore.ts:297](file:///d:/猫思之/src/store/docStore.ts#L297) | `.filter(Boolean)` 不收窄 TS 类型（对比 [templateClone.ts:26,34](file:///d:/猫思之/src/lib/templateClone.ts#L26) 已用类型谓词） | 统一类型谓词 |
| C-7 | P3 | [refs.ts](file:///d:/猫思之/src/store/refs.ts) | 三个共享 ref 无 TSDoc，与其他文件风格不一致 | 补注释 |

## 六、潜在逻辑错误

| ID | 等级 | 位置 | 问题 | 整改建议 |
|---|---|---|---|---|
| L-1 | P1 | [gantt.ts:97-116](file:///d:/猫思之/src/lib/gantt.ts#L97-L116) | `wouldCreateCycle` 方向正确（从 `to` 沿前向边 `x→y` 即 `y.deps[].from===x` 传播，能达 `from` 则成环），但注释"依赖存的是反向指针"易误导 | 澄清注释 |
| L-2 | P2 | [settings.ts:53-65,118-128](file:///d:/猫思之/src/store/settings.ts#L53) | `initReduceMotion` 优先读 localStorage，用户手动切换后持久化，系统 `prefers-reduced-motion` 变化不再跟随；与"缺省跟随系统"PRD 表面矛盾 | 若为设计取舍补注释 |
| L-3 | P2 | [templateClone.ts:33-34](file:///d:/猫思之/src/lib/templateClone.ts#L33-L34) | `deps.from` 重映射过滤不在 idMap 的项正确；但 `type` 字段保留任意值未做枚举校验，导入模板含非法 type 留隐患 | 枚举校验 |
| L-4 | P2 | [presentation.ts:17-27](file:///d:/猫思之/src/lib/presentation.ts#L17-L27) | `preorder` 递归无环/深度保护；导入 bug 形成 children 环会栈溢出 | 加 seen 集合 |
| L-5 | P2 | [Canvas.tsx:222-227](file:///d:/猫思之/src/components/Canvas.tsx#L222-L227) | 演示 `renderDoc` 用 `presentDoc` 派生未污染 store（已确认浅拷贝）；但 `viewDoc`（搜索展开）非演示时直接覆盖 `doc` 引用传 layout，`msz:fit` 时 layoutRef 是 renderDoc 布局 | 显式注释优先级 |
| L-6 | P3 | [settings.ts:116](file:///d:/猫思之/src/store/settings.ts#L116) | `nextSlide` 无上限，`slide` 可超 `total-1`；PresentOverlay/Canvas/App 都做了 `Math.min` 钳制 | setter 内钳制 |

## 七、M6 期间处置计划

| 问题 | M6 阶段 | 处置 |
|---|---|---|
| S-1 文件名未清洗 | P3 | 统一 `sanitizeFileName`，新老导出都用 |
| S-3/S-4 导入校验不足 | P3 | `parseImported` + `parseMarkdown` 补结构校验 |
| F-3 loadDoc 无 catch | P2/P3 | Sidebar/App 调用补 catch + 中文提示 |
| 其余 P1（F-1/F-2/P-1/P-2/P-3） | Backlog | M6 不扩范围，立卡入 M7 候选 |
| P2/P3 多数 | Backlog | 后续迭代收敛 |

## 八、结论

M5 交付质量稳健：无 P0 数据丢失/阻断缺陷；P1 集中在用户可见的状态丢失（F-1）、跨时区显示（F-2）与大文档性能（P-1/P-2/P-3）。M6 在数据安全与开放格式方向上自然覆盖 S-1（文件名清洗）与 F-3（导入容错）两项；其余 P1 建议在 M6 完成后立即立卡入下一迭代。P2/P3 不影响 M6 推进，纳入长期 Backlog。
