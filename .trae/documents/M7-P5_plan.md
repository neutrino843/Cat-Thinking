# M7-P5 实施计划 · 模板预览 + .msz-tpl 导入导出 + 模板富内容化

## Context

M7-P4（布局扩展）已交付并推送（commit `720650d`）。P5 是 M7 阶段收尾：让模板从「纯文字列表」升级为「可视化预览 + 可分享 + 富内容示范」，直接对应 M7_plan.md §二 40-41 行与 §五 P5/C5。

驱动来源：用户 2026-09-23 新增需求「模板预览/一键应用/分享」。当前内置模板无标签/图标/任务示范，与 M7-P1~P3 富内容能力脱节；自定义模板无法跨设备分享。

预期结果：用户在 Sidebar 新建菜单可悬停查看模板缩略图；每个模板可导出 `.msz-tpl` 文件分享；可导入 `.msz-tpl` 加入「我的模板」；内置四类模板（book/project/meeting/swot）展示标签色/图标/里程碑示范。

## 范围（In Scope）

1. `templates.ts` 的 `TplNode` 扩展富内容字段（tags/icons/task）；`buildDoc` 透传；升级 book/project/meeting/swot 四个模板。
2. 模板缩略图：新建 `TemplateThumbnail` 组件，用 `computeLayout` 结果渲染静态 SVG（rect + 文字 + 标签色点，scale to fit 120×80，无事件）。
3. `.msz-tpl` 导入导出：新建 `templateIO.ts`，格式 `{ name, doc, _blobs? }`；导出内嵌 blob dataURL（复用 exporters 基建）；导入走 `saveTemplate` 克隆链路。
4. Sidebar 模板菜单：悬停弹出预览卡片；每个模板加「导出」按钮；底部加「导入模板」入口。
5. 单测：.msz-tpl 往返一致（名称 + 节点结构）；缩略图 SVG 非空。

## 不纳入（Out of Scope）

- 模板缩略图实时编辑（仅静态预览，不支持在预览里改）
- 模板市场/云端分享（仅本地文件导出导入）
- 模板缩略图的手绘抖动效果（静态直线，保持渲染简单、体积可控）
- 自定义模板的重命名（M5 仅存/删，P5 不扩）

## 关键文件

| 路径 | 性质 | 关键改动 |
|---|---|---|
| [src/data/templates.ts](file:///d:/猫思之/src/data/templates.ts) | 修改 | `TplNode` 加 `tags?/icons?/task?`；`buildDoc` 透传；升级 book/project/meeting/swot |
| [src/components/TemplateThumbnail.tsx](file:///d:/猫思之/src/components/TemplateThumbnail.tsx) | 新增 | 静态缩略 SVG 组件（computeLayout + 简化绘制） |
| [src/lib/templateIO.ts](file:///d:/猫思之/src/lib/templateIO.ts) | 新增 | `exportTemplate(name, doc)` / `importTemplateFile(file)` |
| [src/components/Sidebar.tsx](file:///d:/猫思之/src/components/Sidebar.tsx) | 修改 | 预览弹层、导出按钮、导入模板入口 |
| [src/styles.css](file:///d:/猫思之/src/styles.css) | 修改 | 缩略图弹层样式（.tpl-thumb / .tpl-pop） |
| [src/lib/templateIO.test.ts](file:///d:/猫思之/src/lib/templateIO.test.ts) | 新增 | .msz-tpl 往返 + 缩略图非空 |

预估总改动 ≈ +350 行。

## 复用的现有基建

- `computeLayout(doc)` → [layout.ts](file:///d:/猫思之/src/lib/layout.ts) ：缩略图取节点坐标
- `getTheme(dark)` → [theme.ts](file:///d:/猫思之/src/lib/theme.ts) ：缩略图配色
- `buildDoc(tpl)` / `findTpl(id)` → [templates.ts](file:///d:/猫思之/src/data/templates.ts) ：内置模板转 DocData
- `saveTemplate(name, doc)` → [db.ts](file:///d:/猫思之/src/store/db.ts#L287) ：导入模板时克隆 + blob 落盘
- `validateDoc(d)` → [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts#L167) ：导入时结构校验
- `collectBlobIds` / `blobToDataURL` / `sanitizeFileName` / `download` → [exporters.ts](file:///d:/猫思之/src/lib/exporters.ts) ：导出时 blob 内嵌
- `cloneFromTemplate` → [templateClone.ts](file:///d:/猫思之/src/lib/templateClone.ts) ：saveTemplate 内部已调用，自动重映射 id/blobId/links
- `TAG_COLORS` → [Canvas.tsx](file:///d:/猫思之/src/components/Canvas.tsx#L20) ：缩略图标签色点配色（导出到 thumbnail 用，或在 thumbnail 内复刻色板）

## 设计细节

### 1. TplNode 富内容扩展

```ts
interface TplNode {
  text: string
  note?: string
  tags?: { text: string; color: string }[]   // color 用色板 key
  icons?: string[]
  task?: { start?: string; end?: string; milestone?: boolean }
  children?: TplNode[]
}
```

`buildDoc` 的 `mk` 函数把 `tn.tags/tn.icons/tn.task` 透传到 MindNodeData（已有字段）。color 仍按 level 轮转。

### 2. 四个模板富内容化

| 模板 | 示范内容 |
|---|---|
| **book** | 核心观点加 `tags:[{text:'观点',color:'blue'}]`；金句加 `tags:[{text:'金句',color:'amber'}]`；行动启发加 `icons:['flag']` |
| **project** | 里程碑节点（M1/M2/M3）加 `task:{milestone:true}`；风险加 `tags:[{text:'风险',color:'red'}]` |
| **meeting** | 行动项加 `task:{start,end}` + `tags:[{text:'待办',color:'green'}]`；决议加 `icons:['check']` |
| **swot** | S 加 `tags:[{text:'内部',color:'green'}]`；W 加 `tags:[{text:'内部',color:'red'}]`；O 加 `tags:[{text:'外部',color:'blue'}]`；T 加 `tags:[{text:'外部',color:'orange'}]` |

注：图标 id 必须是 `src/data/icons.ts` 中已有的（如 flag/check/star）。先确认 icons.ts 有哪些 id。

### 3. TemplateThumbnail 组件

```tsx
interface Props { doc: DocData; dark: boolean; w?: number; h?: number }
export default function TemplateThumbnail({ doc, dark, w=140, h=100 }: Props) {
  const theme = getTheme(dark)
  const layout = useMemo(() => computeLayout(doc), [doc])
  // 缩放：以 bounds 为基准等比缩到 (w,h) 内，居中
  const scale = Math.min((w-8)/layout.bounds.w, (h-8)/layout.bounds.h)
  const ox = (w - layout.bounds.w*scale)/2 - layout.bounds.x*scale
  const oy = (h - layout.bounds.h*scale)/2 - layout.bounds.y*scale
  return (
    <svg width={w} height={h} style={{background: theme.paper, borderRadius: 6}}>
      <g transform={`translate(${ox},${oy}) scale(${scale})`}>
        {layout.edges.map(e => <path key=... d={straightPath(e.points)} stroke={...} fill="none" strokeWidth={1.2}/>)}
        {[...layout.nodes.values()].map(n => (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.level===0?8:5}
              fill={n.level===0?theme.rootFill:theme.nodeFill} stroke={n.level<=1?theme.ink:theme.inkSoft} strokeWidth={1}/>
            <text x={n.x+6} y={n.y+n.h/2} fontSize={9} fill={theme.ink} dominantBaseline="central">
              {truncate(n.text, 8)}
            </text>
            {/* 标签色点 */}
            {tags.slice(0,3).map((t,i)=> <circle cx={n.x+n.w-5-i*7} cy={n.y+n.h/2} r={2.2} fill={TAG_COLORS[t.color]??'#999'}/>)}
          </g>
        ))}
      </g>
    </svg>
  )
}
```

关键：用直线 `straightPath(points)`（取端点连线）而非 sketchPath，保持缩略图干净、无抖动依赖。文字截断到 8 字符。

### 4. .msz-tpl 格式

```json
{
  "name": "读书笔记",
  "doc": { ...完整 DocData（version:2）... },
  "_blobs": { "blobId": { "dataURL": "data:image/png;base64,...", "type": "image/png" } }
}
```

`_blobs` 可选，仅当模板含图片/附件时存在。

**导出** `exportTemplate(name, doc)`：
- 复用 `collectBlobIds(doc)` + `getBlob` + `blobToDataURL`（≤2MB 才内嵌）
- 下载 `${sanitizeFileName(name)}.msz-tpl`，MIME `application/json`

**导入** `importTemplateFile(file)`：
- `JSON.parse` → 校验有 `name`(string) + `doc`
- `validateDoc(doc)` 做结构校验（复用 exporters）
- 对 `_blobs` 中每个 blob：`fetch(dataURL).blob()` → `putBlob(blobId, doc.id, blob)`（先放源 doc.id 下，saveTemplate 会克隆）
- `await saveTemplate(name, doc)`（内部 cloneFromTemplate 重映射 id/blobId + cloneDocBlobs）
- `window.dispatchEvent(new Event('msz:templates-changed'))`

### 5. Sidebar UI

模板菜单每个按钮：
- 内置模板：`<button onClick=create(t.id)>` + 「导出」小按钮
- 自定义模板：`<button onClick=createFromCustom(t)>` + 「导出」+「删除」
- 悬停：弹出右侧 `TemplateThumbnail` 卡片（含模板名 + 节点数）

底部：在「导入文件」旁加「导入模板」按钮（accept `.msz-tpl`）。

预览弹层用绝对定位，避免遮挡。用 `onMouseEnter/onMouseLeave` 控制显示，移动设备用 onClick 切换。

## 验收对照（C5）

| 验收条 | 验证方式 |
|---|---|
| 模板预览缩略图正确 | 浏览器冒烟：悬停 book/swot 看缩略图结构与标签色点 |
| .msz-tpl 往返一致 | templateIO.test.ts：导出→导入，断言 name + 节点数 + 关键节点 text 一致 |
| coverage ≥ 93.06%（剔除 blobs db 层） | npm run coverage |
| build gzip 增量 ≤ +12KB | npm run build |
| TEST_REPORT 追加 M7 | 写报告 |

## 验证流程（maosizhi-test-runbook）

1. `npm run coverage` → 全绿
2. `npm run build` → tsc 0 + gzip 增量
3. browser_use 冒烟：模板预览（悬停 4 个模板）、导出 .msz-tpl、导入 .msz-tpl、富内容模板创建后节点有标签/图标/任务
4. TEST_REPORT.md 追加 M7-P5 章节
5. commit `feat(M7-P5): ...` + push origin/main

## 风险与对策

| 风险 | 对策 |
|---|---|
| TplNode 加字段破坏现有 templateClone 单测 | buildDoc 透传可选字段，cloneFromTemplate 已支持 tags/icons/task，零迁移 |
| 缩略图 computeLayout 在菜单打开时批量计算卡顿 | 模板节点数 < 30，computeLayout < 2ms；用 useMemo 缓存，菜单关闭不计算 |
| 悬停弹层在窄屏溢出 | 弹层定位用 `right: 100%` 从菜单左侧弹出，限宽 160px |
| .msz-tpl 导入含非法 doc 导致崩溃 | 复用 validateDoc 严格校验，失败 alert 不入库 |
| 导入 blob 超 IDB 配额 | 复用 putBlob 现有配额异常处理（中文提示） |
