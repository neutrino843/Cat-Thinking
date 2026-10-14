import { useState } from 'react'
import type { CourseSnapshot } from '../../learning/model'
import { exportCoursePackage, previewCoursePackage, restoreCoursePackage, type CoursePackagePreview } from '../../learning/coursePackage'
import type { LearningAction } from './CourseOverview'

export default function LearningDataPanel({ snapshot, action, busy, onRestored }: { snapshot: CourseSnapshot; action: LearningAction; busy: boolean; onRestored: (courseId: string) => void }) {
  const [password, setPassword] = useState('')
  const [restorePassword, setRestorePassword] = useState('')
  const [file, setFile] = useState<File>()
  const [preview, setPreview] = useState<CoursePackagePreview>()
  const [saved, setSaved] = useState('')
  const missingDocs = snapshot.documents.filter((record) => !snapshot.docs.some((doc) => doc.id === record.docId))
  return <section><h3>资料与进度一起备份</h3><p>课程包包含现存课程文档与附件、归档原文副本、学习记录和复习安排。API 密钥与可执行的后台任务不在包内。</p>
    {missingDocs.length > 0 && <p role="status">有 {missingDocs.length} 份编辑文档已删除，无法导出这些文档；已保存的学习归档仍可备份。恢复预览会列出缺项。</p>}
    <form className="learning-form" onSubmit={(e) => { e.preventDefault(); void action(async () => {
      const blob = await exportCoursePackage(snapshot.course.id, password ? { password } : {})
      const link = document.createElement('a'); const url = URL.createObjectURL(blob)
      link.href = url; link.download = `${snapshot.course.name.replace(/[<>:"/\\|?*]/g, '_')}.mszcourse`; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 2000); setSaved('课程包已生成，请确认浏览器的实际保存位置。')
    }) }}><label>备份密码 可选<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={200} /></label>
      <p>密码至少 8 个字符，请自行保管；密码不会保存在学习记录中。无密码的课程包包含可读取的个人资料。</p>
      <button className="tbtn primary" disabled={busy}>导出课程资料包</button>{saved && <p role="status">{saved}</p>}</form>
    <h4>先检查，再恢复</h4><form className="learning-form" onSubmit={(e) => { e.preventDefault(); if (!file) return; void action(async () => setPreview(await previewCoursePackage(file, restorePassword ? { password: restorePassword } : {}))) }}>
      <label>选择课程包<input type="file" accept=".mszcourse" onChange={(e) => { setFile(e.target.files?.[0]); setPreview(undefined) }} /></label>
      <label>课程包密码<input type="password" autoComplete="off" value={restorePassword} maxLength={200} onChange={(e) => { setRestorePassword(e.target.value); setPreview(undefined) }} /></label>
      <button className="tbtn" disabled={busy || !file}>检查课程包</button></form>
    {preview && <section className="learning-section"><h4>恢复预览</h4><p>{preview.courseName}</p><dl className="learning-counts">{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{{ documents: '编辑文档', sources: '原文', blobs: '附件', archives: '学习资料', attempts: '作答记录', records: '学习对象', schedules: '复习安排' }[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl>
      {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>恢复为一门新课程，保留当前资料；不会恢复付费任务或自动连接服务。</p>
      <button className="tbtn primary" disabled={busy} onClick={() => void action(async () => { const course = await restoreCoursePackage(preview); setPreview(undefined); onRestored(course.id) })}>确认恢复为新课程</button></section>}
    <p>后端数据库与加密恢复材料仍需单独做全应用备份。浏览器下载位置由你选择，课程包可保存到另一块磁盘。</p>
  </section>
}
