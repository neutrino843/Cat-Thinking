/** Metadata is kept in the source, but cannot silently become a course title. */
export function isDocumentMetadata(text: string): boolean {
  return /^(?:授课(?:教师|老师)?|任课教师|教师|老师|主讲(?:人|教师)?|讲授|讲师|作者|姓名|院系|学院|学校|单位|邮箱|日期|学期|teacher|lecturer|instructor|professor|author|department|university|email|date)\s*[:：\s]/i.test(text.trim())
    || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())
    || /^[\p{Script=Han}A-Za-z·. ]{1,30}(?:老师|教授|讲师|研究员)$/u.test(text.trim())
}

export function documentTitleFallback(filename: string): string {
  return filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim() || '未命名文档'
}
