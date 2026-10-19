import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = process.env.CODEX_PRIMARY_RUNTIME_ROOT || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime')
const modules = path.join(runtime, 'dependencies/node/node_modules')
const requireRuntime = createRequire(path.join(modules, '__competition__.cjs'))
process.env.RUNTIME_NODE_MODULES = modules
const { Presentation, PresentationFile } = await import(pathToFileURL(requireRuntime.resolve('@oai/artifact-tool')).href)
const skill = process.env.PRESENTATIONS_SKILL_DIR
if (!skill) throw new Error('请设置 PRESENTATIONS_SKILL_DIR 为已安装的 Presentations skill 目录。')
const output = path.join(root, 'docs/iterations/2026-10-19-益海嘉里杯初赛方案/参赛材料')
const build = path.join(root, 'reports/competition-2026-10-19/deck-build')
await fs.mkdir(build, { recursive: true })
await fs.mkdir(output, { recursive: true })
const walkthrough = JSON.parse(await fs.readFile(path.join(root, 'reports/competition-2026-10-19/walkthrough.json'), 'utf8'))
if (walkthrough.status !== 'passed') throw new Error('先完成实际演练，才能制作含验证结果的展示稿。')
const colors = { paper: '#FAF6ED', ink: '#25332B', muted: '#667166', green: '#21553B', rule: '#D4D8CB' }
const font = 'Microsoft YaHei'
const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } })
function text(slide, content, x, y, width, height, size = 28, options = {}) {
  const shape = slide.shapes.add({ geometry: 'textbox', position: { left: x, top: y, width, height }, fill: 'none', line: { fill: 'none', width: 0 } })
  shape.text = content
  shape.text.style = { typeface: font, fontSize: size, color: options.color || colors.ink, bold: !!options.bold, verticalAlignment: 'top' }
  return shape
}
function slide(title) {
  const item = presentation.slides.add()
  item.background.fill = colors.paper
  text(item, title, 72, 54, 1136, 80, 44, { bold: true })
  return item
}
async function image(slide, filename, x, y, width, height, alt) {
  slide.images.add({ blob: new Uint8Array(await fs.readFile(path.join(output, '截图', filename))), contentType: 'image/png', fit: 'contain', position: { left: x, top: y, width, height }, alt })
}
function notes(slide, content) { slide.speakerNotes.text = content }
const s1 = slide('猫思之')
text(s1, '让课程练习\n回到原文依据', 72, 182, 1000, 185, 64, { bold: true, color: colors.green })
text(s1, '面向大学课程的原文核对与主动练习助手', 76, 423, 1050, 54, 30)
text(s1, '参赛工作稿 · 演示采用自编资料，真实课程与团队信息待补齐', 76, 614, 1120, 44, 22, { color: colors.muted })
notes(s1, '约20秒。项目从自己的课程资料出发，帮助用户尝试作答、核对依据并留下修正。本工作稿不代表已完成报名或已经证明提分效果。品牌与配色沿用项目design.md。')

const s2 = slide('一道统计学题的核对过程')
text(s2, '冰淇淋销量与溺水事件一起上升，能确认因果吗？', 72, 179, 420, 150, 36, { bold: true })
text(s2, '先尝试回答，再回到原文检查共同因素。', 72, 370, 410, 110, 28)
text(s2, '自编案例，用于展示流程\n需求假设仍需同课学生验证', 72, 550, 440, 88, 23, { color: colors.muted })
await image(s2, '03-选项特写.png', 530, 155, 680, 455, '本轮实际浏览器中的自编统计学题目选项')
notes(s2, '约30秒。案例和选定错误回答均由本轮演示脚本编写。六题预先写入隔离浏览器的有效归档，不是AI现场生成。用户原话、课程名称和需求调查还没有收集，不能把这个案例称作真实学习困难的研究结果。')

const s3 = slide('回答、依据与修正的关联')
const rows = [
  ['01', '先尝试回答', '保留原始回答，参考答案在提交后出现'],
  ['02', '按需核对原文', '正式题引用生成时归档，原文与解释可对照'],
  ['03', '写下自己的修正', '原回答继续保留，补学关联本次重试'],
  ['04', '之后再次验证', '采用或手动保存日期，帮助条件单独记录'],
]
rows.forEach(([n, label, detail], i) => {
  const y = 170 + i * 111
  text(s3, n, 72, y, 76, 60, 34, { color: colors.green, bold: true })
  text(s3, label, 172, y, 340, 62, 32, { bold: true })
  text(s3, detail, 555, y + 5, 645, 70, 26)
})
notes(s3, '约35秒。创新定位是面向课程的过程设计与工程整合，主动回忆、资料出题和间隔复习并非原创理论。NotebookLM已支持资料闪卡与测验：https://workspaceupdates.googleblog.com/2025/09/flashcards-quizzes-reports-notebook-lm-google-education.html 。Anki已有主动回忆与间隔复习：https://docs.ankiweb.net/background.html 。本项目复习当前是1/3/7/14天固定规则，不是FSRS或个性化记忆预测。')

const s4 = slide('一次补学保留前后的记录')
text(s4, '初次回答与重试分开保存', 72, 169, 420, 90, 34, { bold: true })
text(s4, '原文回看、修正笔记和下一次安排可以继续查看。', 72, 307, 410, 144, 28)
text(s4, '图中是自动化演示记录\n即时同题答对不代表长期掌握', 72, 546, 430, 90, 23, { color: colors.muted })
await image(s4, '07-修正特写.png', 520, 156, 690, 462, '实际补学界面的脚本编写修正笔记')
notes(s4, '约35秒。可以播放附带的自动化实际录屏，也可按演练卡在本机操作。脚本选择错答、填写修正、答对重试并保存日期。辅助记录观测仅限应用内部，跨会话完整归属尚未验证，因此没有新加独立掌握标签。')

const s5 = slide('当前验证与尚待验证')
text(s5, '已执行的软件验证', 72, 165, 530, 58, 32, { bold: true, color: colors.green })
text(s5, '实际导入与预编写六题校验\n补学、保存与刷新恢复\n空白浏览器的课程包恢复\n外网阻断时的预置学习路径', 72, 260, 530, 275, 28)
text(s5, '真人与学习效果', 680, 165, 530, 58, 32, { bold: true })
text(s5, '同课学生的独立操作观察\n真实课程资料与教师核对\n延迟作答和学习效果对比\n当前均未完成', 680, 260, 530, 275, 28)
text(s5, '自动化演练使用本地服务，不验证离线模型生成或新电脑安装。', 72, 620, 1136, 44, 23, { color: colors.muted })
notes(s5, `约35秒。软件证据：reports/competition-2026-10-19/walkthrough.json，对应执行完成于${walkthrough.finishedAt}。本轮浏览器检查${walkthrough.checks.length}项，不与其他专项测试重复相加。没有真人参与人数或提分数据，不能编造成功率、满意度或合作学校。四个窄屏仅覆盖记录到练习与关键控件，不代表全端验收。`)

const s6 = slide('下一步：同课小样本试用')
text(s6, '一门真实课程', 72, 185, 1020, 64, 38, { bold: true, color: colors.green })
text(s6, '替换为获准讲义，逐题核对依据和参考答案。', 72, 268, 1100, 65, 29)
text(s6, '4～6 名同学的观察计划', 72, 374, 1080, 64, 38, { bold: true })
text(s6, '记录能否独立完成流程、卡点与真实返回情况。', 72, 457, 1110, 65, 29)
text(s6, '本轮现金预算建议不超过150元，劳动与既有设备另计。', 72, 572, 1120, 44, 23, { color: colors.muted })
text(s6, '团队、指导老师与学院信息在提交前据实填写。', 72, 628, 1120, 44, 23, { color: colors.muted })
notes(s6, '约25秒。4～6人是招募目标，150元是预算建议，都不是实际成果。先完成真实课程、试用与报名手续，再决定是否继续产品增量。第二十四季通知：https://jwc.jnu.edu.cn/2026/0907/c6765a862657/page.htm 。本期截止、展示时长、签章与最终材料格式由团队确认；本讲述约3分钟是内部演练安排。')

const draft = path.join(build, 'candidate.pptx')
await (await PresentationFile.exportPptx(presentation)).save(draft)
for (const [index, item] of presentation.slides.items.entries()) {
  const preview = await presentation.export({ slide: item, format: 'png', scale: 1 })
  await fs.writeFile(path.join(build, `slide-${index + 1}.png`), new Uint8Array(await preview.arrayBuffer()))
}
await fs.writeFile(path.join(build, 'presentation.proto.json'), JSON.stringify(presentation.toProto(), null, 2))
const { finalizePresentation } = await import(pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs')).href)
const finalPath = path.join(output, '猫思之-参赛展示工作稿.pptx')
const finalResult = await finalizePresentation({ workspaceDir: root, candidatePath: draft, finalPath, pythonExecutable: path.join(runtime, 'dependencies/python/python.exe'), integrityValidatorPath: path.join(skill, 'container_tools/inspect_presentation_package_integrity.py'), layoutValidatorPath: path.join(skill, 'container_tools/inspect_presentation_layout_geometry.py'), layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-heading-fit'], explicitTotalSlideCount: 6, requiredNativeTableOwnerSlides: [], requiredNativeChartOwnerSlides: [], fontPolicy: { basis: 'design', families: [font] }, verifyArtifactToolImport: true, receiptPath: path.join(build, 'validation.json') })
const pdfPath = path.join(output, '猫思之-参赛展示工作稿.pdf')
try {
  const pdf = await presentation.export({ format: 'pdf' })
  await fs.writeFile(pdfPath, new Uint8Array(await pdf.arrayBuffer()))
} catch (error) {
  await fs.writeFile(path.join(build, 'native-pdf-export-failure.json'), JSON.stringify({ message: error.message, fallback: 'reviewed PNG slides to image-based PDF via bundled reportlab' }, null, 2))
  execFileSync(path.join(runtime, 'dependencies/python/python.exe'), [path.join(root, 'scripts/competition/export-pdf.py'), '--slides', build, '--output', pdfPath], { stdio: 'inherit', windowsHide: true })
}
console.log(JSON.stringify({ deck: path.relative(root, finalPath), pdf: path.relative(root, pdfPath), slides: presentation.slides.items.length, finalizerCompleted: !!finalResult }))
