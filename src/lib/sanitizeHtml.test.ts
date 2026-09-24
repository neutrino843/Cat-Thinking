import { describe, it, expect } from 'vitest'
import { sanitizeHtml, richNoteToText } from './sanitizeHtml'

describe('sanitizeHtml', () => {
  it('保留白名单内标签', () => {
    const out = sanitizeHtml('<p>正文 <b>加粗</b> <i>斜体</i> <u>下划</u></p>')
    expect(out).toContain('<b>加粗</b>')
    expect(out).toContain('<i>斜体</i>')
    expect(out).toContain('<u>下划</u>')
    expect(out).toContain('正文')
  })

  it('保留列表结构', () => {
    const out = sanitizeHtml('<ul><li>a</li><li>b</li></ul>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>a</li>')
    expect(out).toContain('<li>b</li>')
  })

  it('A 标签保留 http href 并加 rel=target', () => {
    const out = sanitizeHtml('<a href="https://example.com">link</a>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('A 标签保留内部锚点 #node-xxx', () => {
    const out = sanitizeHtml('<a href="#node-abc">跳转</a>')
    expect(out).toContain('href="#node-abc"')
    // 内部锚点不加 target=_blank
    expect(out).not.toContain('target="_blank"')
  })

  it('剥离非白名单标签但保留文本（unwrap）', () => {
    const out = sanitizeHtml('<div><span>裸文本</span></div>')
    expect(out).toBe('裸文本')
  })

  it('移除 on* 事件属性', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" onmouseover="x()">文本</p>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
    expect(out).toContain('文本')
  })

  it('移除 style 属性', () => {
    const out = sanitizeHtml('<p style="color:red">文本</p>')
    expect(out).not.toContain('style')
    expect(out).toContain('文本')
  })

  it('剥离 A 上的非法协议（javascript:）', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">点击</a>')
    expect(out).not.toContain('javascript')
    expect(out).not.toContain('href=')
    expect(out).toContain('点击')
  })

  it('剥离 A 上的 data: 协议', () => {
    const out = sanitizeHtml('<a href="data:text/html,xxx">点击</a>')
    expect(out).not.toContain('href=')
    expect(out).toContain('点击')
  })

  it('剥离 A 上的 vbscript: 协议', () => {
    const out = sanitizeHtml('<a href="vbscript:msgbox(1)">点击</a>')
    expect(out).not.toContain('href=')
  })

  it('整棵丢弃 script 子树（不留 children）', () => {
    const out = sanitizeHtml('<p>前<script>alert(1)</script>后</p>')
    expect(out).toContain('前')
    expect(out).toContain('后')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert(1)')
  })

  it('丢弃 style 标签整棵子树', () => {
    const out = sanitizeHtml('<style>body{color:red}</style><p>文本</p>')
    expect(out).not.toContain('color:red')
    expect(out).toContain('文本')
  })

  it('丢弃 iframe/svg/object 整棵子树', () => {
    const out = sanitizeHtml('<iframe src="x"></iframe><svg onload="alert(1)"></svg><p>文本</p>')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('svg')
    expect(out).not.toContain('onload')
    expect(out).toContain('文本')
  })

  it('空输入返回空串', () => {
    expect(sanitizeHtml('')).toBe('')
    expect(sanitizeHtml(null as unknown as string)).toBe('')
  })

  it('嵌套危险标签内仍净化', () => {
    const out = sanitizeHtml('<p>ok<script>bad()</script>tail</p>')
    expect(out).toContain('ok')
    expect(out).toContain('tail')
    expect(out).not.toContain('bad()')
  })

  it('对非白名单标签里的子白名单标签仍递归净化', () => {
    const out = sanitizeHtml('<div><p>正文 <b>粗</b></p></div>')
    expect(out).toContain('<b>粗</b>')
    expect(out).toContain('正文')
  })

  it('最终输出绝不出现 javascript: 字面', () => {
    const cases = [
      '<a href="javascript:alert(1)">x</a>',
      '<p onclick="javascript:alert(1)">y</p>',
      '<img src="x" onerror="javascript:alert(1)">',
    ]
    for (const c of cases) {
      const out = sanitizeHtml(c)
      expect(out.toLowerCase()).not.toContain('javascript:')
      expect(out.toLowerCase()).not.toContain('alert(1)')
    }
  })
})

describe('richNoteToText', () => {
  it('普通段落转纯文本', () => {
    expect(richNoteToText('<p>你好 <b>世界</b></p>')).toBe('你好 世界')
  })

  it('BR / P 产生换行', () => {
    expect(richNoteToText('<p>a</p><p>b</p>')).toBe('a\nb')
    expect(richNoteToText('a<br>b')).toBe('a\nb')
  })

  it('列表转行首', () => {
    const out = richNoteToText('<ul><li>a</li><li>b</li></ul>')
    expect(out).toContain('a')
    expect(out).toContain('b')
    expect(out).toContain('\n')
  })

  it('外部链接保留 URL', () => {
    const out = richNoteToText('<a href="https://e.com">点</a>')
    expect(out).toContain('点')
    expect(out).toContain('[链接](https://e.com)')
  })

  it('内部锚点链接不输出 URL', () => {
    const out = richNoteToText('<a href="#node-1">跳</a>')
    expect(out).toContain('跳')
    expect(out).not.toContain('[链接]')
  })

  it('空输入返回空串', () => {
    expect(richNoteToText('')).toBe('')
  })
})
