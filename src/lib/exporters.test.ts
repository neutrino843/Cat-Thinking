import { describe, expect, it, vi } from 'vitest'
import { parseImported, exportSVG, pruneSourceAnchors, validateDoc } from './exporters'
import { simpleFixture, buildFixture } from '../test/fixture'
import type { DocData, MindNodeData } from '../types'

describe('导入校验 parseImported', () => {
  it('合法 JSON 文档可解析并补齐版本号', () => {
    const { doc: d } = parseImported(JSON.stringify(simpleFixture()))
    expect(d.version).toBe(3)
    expect(d.nodes[d.rootId]).toBeDefined()
  })

  it('非法结构抛错', () => {
    expect(() => parseImported('{"foo":1}')).toThrow(/猫思之/)
    expect(() => parseImported('not json')).toThrow()
    expect(() => parseImported(JSON.stringify({ version: 1, rootId: 'x', nodes: {} }))).toThrow()
  })

  /* ---------- P3 新增：按扩展名分流 ---------- */

  it('.md 扩展名走 Markdown 解析', () => {
    const md = `# 标题\n\n- 一级\n  - 二级\n- 兄弟\n`
    const { doc: d } = parseImported(md, '笔记.md')
    expect(d.title).toBe('标题')
    const root = d.nodes[d.rootId]
    expect(root.children.length).toBe(2)
    expect(d.nodes[root.children[0]].text).toBe('一级')
    expect(d.nodes[root.children[1]].text).toBe('兄弟')
  })

  it('.markdown 扩展名同样走 Markdown 解析', () => {
    const { doc: d } = parseImported(`# X\n\n- a\n`, 'x.MARKDOWN')
    expect(d.title).toBe('X')
    expect(d.nodes[d.rootId].children.length).toBe(1)
  })

  it('.opml 扩展名走 OPML 解析（M10）', () => {
    const xml =
      '<?xml version="1.0"?><opml version="2.0"><head><title>OPML导入</title></head>' +
      '<body><outline text="根"><outline text="子A"/></outline></body></opml>'
    const { doc: d, blobs } = parseImported(xml, '导图.opml')
    expect(d.title).toBe('OPML导入')
    expect(Object.keys(d.nodes).length).toBe(2)
    const root = d.nodes[d.rootId]
    expect(root.text).toBe('根')
    expect(d.nodes[root.children[0]].text).toBe('子A')
    expect(Object.keys(blobs).length).toBe(0)
  })

  it('.xml 扩展名同样走 OPML 解析', () => {
    const xml = '<?xml version="1.0"?><opml><body><outline text="顶层"/></body></opml>'
    const { doc: d } = parseImported(xml, 'x.XML')
    expect(d.nodes[d.rootId].text).toBe('顶层')
  })

  it('.msz 扩展名按 JSON 全量格式解析（单文件模式与 JSON 同构）', () => {
    const { doc: d } = parseImported(JSON.stringify(simpleFixture()), '猫思之-x.msz')
    expect(d.version).toBe(3)
    expect(d.nodes[d.rootId]).toBeDefined()
  })

  it('缺省文件名按 JSON 解析（向后兼容旧调用方式）', () => {
    const { doc: d } = parseImported(JSON.stringify(simpleFixture()))
    expect(d.nodes[d.rootId]).toBeDefined()
  })

  /* ---------- 审计新增：H-1 导入净化 + M-9 深度上限 ---------- */

  it('H-1：导入的 richNote.html 经白名单净化（script/on* 被剥离）', () => {
    const f = simpleFixture()
    const rid = f.rootId
    ;(f.nodes[rid] as MindNodeData).richNote = {
      html: '<p onclick="alert(1)">正常<b>加粗</b></p><script>alert(2)</script><img src=x onerror="alert(3)">',
    }
    const d = validateDoc(JSON.parse(JSON.stringify(f)))
    const html = d.nodes[rid].richNote!.html
    expect(html).toContain('正常')
    expect(html).toContain('<b>加粗</b>')
    expect(html).not.toMatch(/script|onclick|onerror|<img/i)
  })

  it('H-1：导入的 links 中 javascript: 协议被剔除，http(s) 与内部锚点保留', () => {
    const f = simpleFixture()
    const rid = f.rootId
    ;(f.nodes[rid] as MindNodeData).links = [
      { id: 'l1', kind: 'url', url: 'javascript:alert(1)' },
      { id: 'l2', kind: 'url', url: 'https://example.com' },
      { id: 'l3', kind: 'node', nodeId: 'n1' },
      { id: 'l4', kind: 'url', url: 'data:text/html,<script>alert(1)</script>' },
    ]
    const d = validateDoc(JSON.parse(JSON.stringify(f)))
    const links = d.nodes[rid].links!
    expect(links.map((l) => l.id)).toEqual(['l2', 'l3'])
  })

  it('H-1：非法 richNote 结构被剔除而不抛错', () => {
    const f = simpleFixture()
    const rid = f.rootId
    ;(f.nodes[rid] as unknown as Record<string, unknown>).richNote = { html: 42 }
    const d = validateDoc(JSON.parse(JSON.stringify(f)))
    expect(d.nodes[rid].richNote).toBeUndefined()
  })

  it('M-9：超深嵌套（>2000 层）被拒绝，防递归布局栈溢出', () => {
    // 构造 2001 层链
    const nodes: Record<string, MindNodeData> = {}
    let prev = 'r'
    nodes.r = { id: 'r', parent: null, children: [], text: 'root' }
    for (let i = 1; i <= 2001; i++) {
      const id = 'n' + i
      nodes[id] = { id, parent: prev, children: [], text: id }
      nodes[prev].children.push(id)
      prev = id
    }
    const doc: DocData = {
      version: 3, id: 'deep', title: 'deep', rootId: 'r', layout: 'logic',
      nodes, createdAt: 0, updatedAt: 0,
    }
    expect(() => validateDoc(JSON.parse(JSON.stringify(doc)))).toThrow(/深度/)
  })

  it('.md 文件名作为 fallbackTitle 兜底', () => {
    // 无 H1 的 Markdown，文件名作为标题
    const { doc: d } = parseImported('- 仅列表项\n  - 子\n', '我的笔记.md')
    expect(d.title).toBe('我的笔记')
  })

  /* ---------- P3 新增：加强结构校验（修审核 S-3） ---------- */

  /** 构造一份带 deps 的合法文档用于校验测试 */
  function docWithDeps(): DocData {
    return buildFixture({
      text: 'root',
      children: [
        { text: 'a', task: { start: '2026-01-01', end: '2026-01-05', progress: 50 } },
        {
          text: 'b',
          task: { start: '2026-01-06', deps: [{ from: 'will-replace', type: 'FS' }] },
        },
      ],
    })
  }

  it('带 deps 的合法文档通过校验', () => {
    const base = docWithDeps()
    // 修正 deps.from 指向真实节点 a
    const ids = Object.keys(base.nodes)
    const rootId = base.rootId
    const aId = base.nodes[rootId].children[0]
    base.nodes[base.nodes[rootId].children[1]].task!.deps![0].from = aId
    void ids
    const { doc: d } = parseImported(JSON.stringify(base))
    expect(d.nodes[aId]).toBeDefined()
    expect(d.nodes[d.nodes[rootId].children[1]].task?.deps?.[0].from).toBe(aId)
  })

  it('deps.from 指向不存在的节点应拒绝', () => {
    const base = docWithDeps()
    // deps.from 保持 'will-replace'（不在 nodes 中）
    expect(() => parseImported(JSON.stringify(base))).toThrow(/task\.deps\.from/)
  })

  it('parent↔children 不一致应拒绝', () => {
    const d = simpleFixture()
    const root = d.nodes[d.rootId]
    // 让 child b 的 parent 指向不存在的节点
    const bId = root.children[1]
    d.nodes[bId].parent = 'nonexistent'
    expect(() => parseImported(JSON.stringify(d))).toThrow(/parent/)
  })

  it('children 包含不存在的节点应拒绝', () => {
    const d = simpleFixture()
    d.nodes[d.rootId].children.push('ghost')
    expect(() => parseImported(JSON.stringify(d))).toThrow(/children/)
  })

  it('根节点 parent 非 null 应拒绝', () => {
    const d = simpleFixture()
    d.nodes[d.rootId].parent = 'wrong'
    expect(() => parseImported(JSON.stringify(d))).toThrow(/rootId/)
  })

  it('task.progress 类型错误应拒绝', () => {
    const d = simpleFixture()
    const aId = d.nodes[d.rootId].children[0]
    // 注入非法类型（绕过 TS 断言）
    ;(d.nodes[aId] as unknown as { task: { progress: unknown } }).task = { progress: '50%' }
    expect(() => parseImported(JSON.stringify(d))).toThrow(/task\.progress/)
  })

  it('JSON 解析失败给出可读中文错误', () => {
    expect(() => parseImported('{invalid json', 'x.json')).toThrow(/JSON/)
  })

  /* ---------- L-3：deps.type 必须是枚举 ---------- */

  it('deps.type 不在 FS/SS/FF/SF 内应拒绝（L-3）', () => {
    const base = docWithDeps()
    const ids = Object.keys(base.nodes)
    const rootId = base.rootId
    const aId = base.nodes[rootId].children[0]
    const bNode = base.nodes[base.nodes[rootId].children[1]]
    bNode.task!.deps![0] = { from: aId, type: 'XX' as 'FS' }
    void ids
    expect(() => parseImported(JSON.stringify(base))).toThrow(/task\.deps\.type/)
  })

  /* ---------- M7-P3：_blobs 剥离 ---------- */

  it('M7-P3：JSON 含 _blobs 时剥离并单独返回', () => {
    const base = simpleFixture()
    const payload = { ...base, _blobs: { b1: { dataURL: 'data:text/plain;base64,AA==', type: 'text/plain' } } }
    const { doc, blobs } = parseImported(JSON.stringify(payload))
    expect(doc.version).toBe(3)
    expect((doc as unknown as Record<string, unknown>)._blobs).toBeUndefined()
    expect(blobs.b1).toBeDefined()
    expect(blobs.b1.dataURL).toBe('data:text/plain;base64,AA==')
  })

  it('M17：JSON 来源文档经校验后单独返回，且强制绑定当前导图 id', () => {
    const base = simpleFixture()
    const payload = {
      ...base,
      _sources: [{
        version: 1,
        id: 'source-1',
        docId: '伪造-id',
        name: '../课程.md',
        kind: 'markdown',
        mime: 'text/markdown',
        size: 8,
        lastModified: 100,
        importedAt: 200,
        extractor: 'test-v1',
        text: '# 课程',
        charCount: 999,
        anchors: [{ nodeId: base.rootId, start: 0, end: 4, locator: '课程' }],
        locators: [{ start: 0, end: 4, titlePath: ['课程'], page: 1 }],
      }],
    }
    const { doc, sources } = parseImported(JSON.stringify(payload))
    expect(sources).toHaveLength(1)
    expect(sources[0].docId).toBe(doc.id)
    expect(sources[0].name).toBe('课程.md')
    expect(sources[0].charCount).toBe(4)
    expect(sources[0].locators).toEqual([{ start: 0, end: 4, titlePath: ['课程'], page: 1 }])
    expect((doc as unknown as Record<string, unknown>)._sources).toBeUndefined()
  })

  it('M17：拒绝来源锚点指向不存在节点或越过原文范围', () => {
    const base = simpleFixture()
    const source = {
      version: 1, id: 's1', name: 'x.txt', kind: 'text', text: 'abc', anchors: [],
    }
    expect(() => parseImported(JSON.stringify({
      ...base,
      _sources: [{ ...source, anchors: [{ nodeId: 'ghost', start: 0, end: 1 }] }],
    }))).toThrow(/不存在的节点/)
    expect(() => parseImported(JSON.stringify({
      ...base,
      _sources: [{ ...source, anchors: [{ nodeId: base.rootId, start: 0, end: 9 }] }],
    }))).toThrow(/区间非法/)
  })

  it('M17：导出边界剔除用户已删除节点的悬空来源锚点', () => {
    const doc = simpleFixture()
    const liveId = doc.rootId
    const sources = pruneSourceAnchors(doc, [{
      version: 1,
      id: 's1',
      docId: '旧-id',
      name: 'x.txt',
      kind: 'text',
      mime: 'text/plain',
      size: 3,
      lastModified: 1,
      importedAt: 2,
      extractor: 'test',
      text: 'abc',
      charCount: 3,
      anchors: [
        { nodeId: liveId, start: 0, end: 1 },
        { nodeId: 'deleted-node', start: 1, end: 2 },
      ],
    }])
    expect(sources[0].docId).toBe(doc.id)
    expect(sources[0].anchors).toEqual([{ nodeId: liveId, start: 0, end: 1 }])
  })

  /* ---------- S-2：SVG 导出标记净化 ---------- */

  it('SVG 导出移除 <script> 与事件属性（S-2）', async () => {
    let captured: Blob | null = null
    const urlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((b) => {
        captured = b as Blob
        return 'blob:mock'
      })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    const malicious =
      '<script>alert(1)</script>' +
      '<g onclick="evil()" onload="x()">ok</g>' +
      '<a href="javascript:evil()">link</a>'
    exportSVG({ worldHTML: malicious, doc: simpleFixture(), dark: false })
    expect(captured).toBeTruthy()
    const text = await captured!.text()
    expect(text).not.toContain('<script')
    expect(text).not.toContain('onclick')
    expect(text).not.toContain('onload')
    expect(text).not.toContain('javascript:')
    expect(text).toContain('>ok<')
    urlSpy.mockRestore()
    clickSpy.mockRestore()
  })
})
