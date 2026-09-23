# 猫思之浏览器冒烟脚本库

所有脚本通过 `browser_evaluate` 注入，用 IIFE 包裹并 `return` 数值。
操作前先确保已 `browser_navigate` 到 http://localhost:5173/ 并 `browser_wait_for` 2–3 秒。

## 通用约定（M5 起必须遵守）

- **每个 evaluate 只放同步代码、立即返回普通值**；等待用 browser_wait_for（建任务等 700–900ms，普通切换 300–500ms）。不要在注入脚本里 return Promise。
- **React 受控输入用原生 setter**：
  ```js
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, '文本');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  ```
- 派发键盘事件前 `document.activeElement.blur()`（焦点在 INPUT 时 App 快捷键处理器提前 return）。
- 涉及 prompt/confirm 的操作，先 evaluate `window.prompt=()=>'名称';window.confirm=()=>true;'ok'`。
- 一轮全量冒烟会超 browser agent 60 步预算，拆成多个短 agent（甘特 / 导图+演示 / 模板+aria）。

---

## 0. 存活与切换到甘特
```js
(() => {
  const g = [...document.querySelectorAll('.view-switch [role=tab]')].find(b => b.textContent.includes('甘特'));
  g && g.click();
  return { title: document.title, hasGantt: !!document.querySelector('#gantt-world') };
})()
```
预期：title 含「猫思之」，hasGantt true。

## 1. 建两个任务并加 FS 依赖
```js
// 1a. 建第一个任务（只点真正的 ＋，不要点到 📅）
(() => {
  [...document.querySelectorAll('.gantt-add')].find(b => b.textContent.trim() === '＋')?.click();
  return 'add1';
})()
// wait 800；若 .task-editor 出现，点 .te-head button 收起，wait 300

// 1b. 建第二个任务
(() => {
  [...document.querySelectorAll('.gantt-add')].filter(b => b.textContent.trim() === '＋')[0]?.click();
  return 'add2';
})()
// wait 800

// 1c. 在任务编辑面板选前置任务
(() => {
  const sel = document.querySelector('.te-deps select');
  if (!sel) return { err: 'no-deps-sel' };
  sel.value = sel.options[sel.options.length > 1 ? 1 : 0].value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { opts: sel.options.length };
})()
// wait 400

// 1d. 数依赖箭头
(() => [...document.querySelectorAll('#gantt-world path')].filter(p => p.getAttribute('marker-end')).length)()
```
预期箭头数比步骤前多 1。

## 2. 工具栏撤销
```js
(() => {
  [...document.querySelectorAll('button')].find(b => b.title === '撤销 (Ctrl+Z)').click();
  return [...document.querySelectorAll('#gantt-world path')].filter(p => p.getAttribute('marker-end')).length;
})()
```
预期箭头数 -1。

## 3. 键盘 Ctrl+Z / Ctrl+Shift+Z（先 blur）
```js
(() => {
  document.activeElement.blur();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  const bars = document.querySelectorAll('#gantt-world rect[rx="7"]').length;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  const arrows = [...document.querySelectorAll('#gantt-world path')].filter(p => p.getAttribute('marker-end')).length;
  return { barsAfterUndo: bars, arrowsAfterRedo: arrows };
})()
```
预期 redo 后 arrows 恢复为步骤 1d 的值；bars ≥ 1。

## 4. 里程碑菱形切换（M5 修正选择器）
```js
// 若 .task-editor 未打开：先点任意 📅
// [...document.querySelectorAll('.gantt-add')].find(b => b.textContent.trim() === '📅')?.click();  wait 600
(() => {
  const cb = document.querySelector('.task-editor label.te-row input[type=checkbox]');
  if (!cb) return { err: 'no-milestone-checkbox' };
  const before = document.querySelectorAll('#gantt-world polygon').length;
  cb.click();
  const after = document.querySelectorAll('#gantt-world polygon').length;
  cb.click(); // 恢复
  return { before, after, delta: after - before };
})()
```
预期 delta=1。注意：**不存在 `.te-milestone` 类**（旧脚本失效）。

## 5. 时间轴缩放（日 ↔ 周 ↔ 月）
```js
(() => {
  const sel = document.querySelector('.gantt select.tsel'); // 不是 .gantt-scale
  const before = Number(document.querySelector('#gantt-world').getAttribute('width'));
  sel.value = 'week';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { before };
})()
// wait 400 后读 week 宽度；再设 month 读一次；最后设回 day
```
预期 day > week > month（欢迎教程实测 616 > 224 > 84）。

## 6. 导图根连接线回归
```js
(() => ({
  paths: document.querySelectorAll('#world path').length,
  edges: document.querySelectorAll('#world .msz-edge-in').length,
  nodes: document.querySelectorAll('#world .msz-node-in').length,
}))()
```
预期 edges > 0 且 paths ≥ edges。

## 7. 主题切换（M5 修正：按 aria-label 找按钮）
```js
(() => {
  [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('深色'))?.click();
  return 'dark';
})()
// wait 400
(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.querySelector('.canvas-wrap')).backgroundColor,
}))()
```
预期 theme='dark'，bg 非 `rgb(0, 0, 0)`（实测 rgb(42, 38, 34)）。恢复：点 aria-label 含「浅色」的按钮。注意 **`.theme-toggle` 类已不存在**。

## 8. 搜索 + Enter 跳转（M5 修正：input.tsearch + 原生 setter）
```js
(() => {
  const txt = document.querySelector('#world text')?.textContent?.trim() || '';
  const inp = document.querySelector('input.tsearch'); // 不是 .search input
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, txt);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return txt;
})()
// wait 400
(() => document.querySelectorAll('#world rect[stroke-dasharray]').length)()
```
预期 ≥1（选中虚框）。测完用 setter 赋空 + input 清空。

## 9. 命令面板
```js
(() => {
  document.activeElement.blur();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  return 'open';
})()
// wait 400
(() => !!document.querySelector('.palette[role=dialog]')
)()
```
预期 true；Esc 关闭（wait 300 后元素消失）。

---

# M5 增量脚本

## 10. 演示模式（开始 / 翻页 / 退出恢复）
```js
// 10a. 开始（先确保在导图视图）
(() => {
  document.querySelector('button[aria-label="开始演示"]')?.click();
  return 'present';
})()
// wait 800
(() => ({
  overlay: !!document.querySelector('.present-overlay'),
  count: document.querySelector('.present-count')?.textContent,
}))()
// 预期 overlay true，count 形如 1/27

// 10b. 翻页（重复 3 次，每次 wait 450）
(() => {
  document.activeElement.blur();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  return 'next';
})()
// 每次后读 .present-count，页码应递增（实测 1/27 → 4/27）
// 其余键：ArrowLeft/ArrowUp 后退、PageDown/PageUp、Space 前进、Home/End 跳首尾

// 10c. 退出
(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return 'esc';
})()
// wait 600
(() => ({
  overlayGone: !document.querySelector('.present-overlay'),
  toolbarBack: !!document.querySelector('.toolbar'),
  canvasBack: !!document.querySelector('#world'),
}))()
```
注意：进入全屏属 best-effort，浏览器拒绝时静默且功能仍正常；Esc 会连带退出浏览器全屏。

## 11. 减少动效（手动开关 + CSS 生效）
```js
// 11a. 确定性验证 CSS 规则本身（绕过命令面板时序）
(() => {
  const html = document.documentElement;
  const node = document.querySelector('#world .msz-node-in');
  const edge = document.querySelector('#world .msz-edge-in');
  const before = { node: getComputedStyle(node).animationName, edge: getComputedStyle(edge).animationName };
  html.dataset.reduceMotion = '1';
  const during = { node: getComputedStyle(node).animationName, edge: getComputedStyle(edge).animationName };
  html.dataset.reduceMotion = '0';
  const after = { node: getComputedStyle(node).animationName, edge: getComputedStyle(edge).animationName };
  return { before, during, after };
})()
```
预期 before/after 为 msz-node-in / msz-edge-in，during 两者均为 `none`。

开关链路（命令面板）：先 `window.prompt` 无关；blur → 派发 ctrl+k（wait 300）→ 原生 setter 给 `.palette input` 赋「减少动效」（wait 250）→ 此时 `.palette li` 应仅 1 条 → `li.click()`（wait 300）→ 读 `document.documentElement.dataset.reduceMotion` 与 `localStorage.getItem('msz.reduceMotion')`（'1'/'true' ↔ '0'/'false' 交替）。

## 12. 噪点纸面与导出纯净
```js
// 12a. 噪点层存在且在 SVG 世界之外
(() => ({
  noise: !!document.querySelector('.paper-noise'),
  noiseInsideWorld: !!document.querySelector('#world .paper-noise'),
}))()
// 预期 { noise: true, noiseInsideWorld: false }

// 12b. 导出序列化的 #world 不含噪点（导图视图）
(() => {
  const xml = new XMLSerializer().serializeToString(document.querySelector('#world'));
  return { hasTurbulence: xml.includes('feTurbulence'), hasNoiseClass: xml.includes('paper-noise') };
})()
// 预期两个 false。甘特视图同理序列化 #gantt-world
```

## 13. 自定义模板：存 / 建 / 删（含残留清理）
前置：evaluate `window.prompt=()=>'冒烟模板';window.confirm=()=>true;'ok'`

```js
// 13a. 打开命令面板 → setter 赋「存为模板」→ wait 250 → 点唯一 li
//      过滤后断言：[...document.querySelectorAll('.palette li')].map(li=>li.textContent.trim())
//      应为 ["将当前文档存为模板"]；点击后 wait 700，[role=dialog] 消失

// 13b. 记录基线
(() => ({ nodes: document.querySelectorAll('#world .msz-node-in').length, docs: document.querySelectorAll('.sb-item').length }))()

// 13c. 打开「＋ 新建」菜单（wait 300），断言分区
(() => ({
  groups: [...document.querySelectorAll('.tpl-group-label')].map(g => g.textContent.trim()),
  customs: [...document.querySelectorAll('.tpl-custom-name')].map(s => s.textContent.trim()),
}))()
// 预期 groups 含「内置模板」「我的模板」，customs 含「冒烟模板」

// 13d. 从自定义模板新建（点 .tpl-custom 整行，不是 ✕），wait 800
(() => ({
  title: document.querySelector('.doc-title').value,
  nodes: document.querySelectorAll('#world .msz-node-in').length,
  docs: document.querySelectorAll('.sb-item').length,
}))()
// 预期 title='冒烟模板'，nodes 与 13b 相同，docs +1

// 13e. 删除模板（再次打开菜单后）
(() => {
  [...document.querySelectorAll('.tpl-custom-del')]
    .find(s => s.closest('button').textContent.includes('冒烟模板'))?.click();
  return 'del';
})()
// wait 500
(() => ({
  left: [...document.querySelectorAll('.tpl-custom')].filter(b => b.textContent.includes('冒烟模板')).length,
  builtin: document.querySelectorAll('.tpl-menu button:not(.tpl-custom)').length,
}))()
// 预期 left=0，builtin ≥ 4
```

清理自动化残留模板（菜单打开状态下执行）：
```js
(() => {
  let n = 0;
  let s;
  while ((s = document.querySelector('.tpl-custom-del'))) { s.click(); n++; }
  return n;
})()
// wait 500；React 批量移除后 while 可能多点已分离节点（无害）
```

## 14. aria 角色与键盘焦点
```js
// 14a. 导图视图
(() => ({
  tabSel: !!document.querySelector('[role=tab][aria-selected=true]'),
  tabs: document.querySelectorAll('.view-switch [role=tab]').length,
  nav: document.querySelector('aside[role=navigation]')?.getAttribute('aria-label'),
  dialogWhenClosed: !!document.querySelector('.palette[role=dialog]'),
  node: (() => {
    const g = document.querySelector('#world g[role=button]');
    return g ? { tabindex: g.getAttribute('tabindex'), label: g.getAttribute('aria-label'), expanded: g.getAttribute('aria-expanded') } : null;
  })(),
  search: document.querySelector('input.tsearch').getAttribute('aria-label'),
}))()
// 预期 tabs=2、nav='文档库'、node.label 非空（含子节点者 expanded 'true'/'false'）

// 14b. 键盘聚焦节点
(() => {
  document.querySelector('#world g[role=button]')?.focus();
  return document.activeElement?.closest('#world') ? 'focus-in' : 'focus-out';
})()

// 14c. 甘特 a11y（切甘特 wait 500 后）
(() => document.querySelector('#gantt-world')?.getAttribute('aria-label'))()
// 预期 '甘特图时间轴（与思维导图同源）'
```

## 15. 手绘三档几何一致性（只能测 text 锚点）
```js
(() => {
  const box = () =>
    [...document.querySelectorAll('#world text')]
      .map(t => { const b = t.getBBox(); return Math.round(b.x) + ',' + Math.round(b.y); })
      .join('|');
  const sk = [...document.querySelectorAll('select.tsel')]
    .find(s => [...s.options].some(o => o.textContent === '很手绘'));
  const a = box();
  sk.value = '0'; sk.dispatchEvent(new Event('change', { bubbles: true }));
  const b0 = box();
  sk.value = '2'; sk.dispatchEvent(new Event('change', { bubbles: true }));
  return { same0: a === b0, n: a.split('|').length };
  // wait 300 后另起 evaluate 再比一次 same2（同脚本读 box()）
})()
```
预期 same0=true、same2=true。**切勿用 path.getBBox() 比对**——path 描线本身带档位抖动。
