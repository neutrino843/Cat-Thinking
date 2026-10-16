import { COMPANION_CHOICES, saveExperience, START_CHOICES, STUDY_CHOICES, useExperience } from '../../learning/experiencePreferences'
import StudyDialog from './StudyDialog'

export function StudyModeChoice() {
  const mode = useExperience((state) => state.preferences.study)
  return <label className="focus-mode-label">这轮怎么学<select aria-label="这轮学习方式" value={mode} onChange={(event) => saveExperience({ study: event.target.value as typeof mode })}>{Object.entries(STUDY_CHOICES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
}
export default function ExperienceSettings({ onClose }: { onClose: () => void }) {
  const { preferences: p, error } = useExperience()
  return <StudyDialog title="学习偏好" onClose={onClose}>
    <p>随时调整，选择会记在这台设备。不会清空作答或改变复习日期。</p>
    <fieldset><legend>首页从哪里开始</legend>{Object.entries(START_CHOICES).map(([value, label]) => <label key={value}><input type="radio" name="start-mode" checked={p.start === value} onChange={() => saveExperience({ start: value as typeof p.start })}/><span>{label}</span></label>)}</fieldset>
    <fieldset><legend>默认学习方式</legend>{Object.entries(STUDY_CHOICES).map(([value, label]) => <label key={value}><input type="radio" name="study-mode" checked={p.study === value} onChange={() => saveExperience({ study: value as typeof p.study })}/><span>{label}<small>{value === 'guided' ? '读一点，回忆，再练习。每轮开始前也能改。' : '先做已有题目，需要时回看原文。'}</small></span></label>)}</fieldset>
    <fieldset><legend>伊希斯怎样陪伴你</legend>{Object.entries(COMPANION_CHOICES).map(([value, label]) => <label key={value}><input type="radio" name="companion-mode" checked={p.companion === value} onChange={() => saveExperience({ companion: value as typeof p.companion })}/><span>{label}<small>{value === 'gentle' ? '首次或操作失败时短提示；停顿只亮问号。' : value === 'quiet' ? '保持安静，点小猫才出现指导。' : '第一次按步骤指路，完成入门引导后安静陪伴。'}</small></span></label>)}</fieldset>
    <fieldset><legend>阅读与陪伴外观</legend><p>学习时先看题目，需要时展开相关段落；完整阅读、资料管理和设置允许正常滚动。</p><label>猫的位置<select value={p.catSide} onChange={(e) => saveExperience({ catSide: e.target.value as typeof p.catSide })}><option value="right">右侧</option><option value="left">左侧</option></select></label><label><input type="checkbox" checked={p.motion} onChange={(e) => saveExperience({ motion: e.target.checked })}/>轻微角色动作</label><label><input type="checkbox" checked={p.rewards} onChange={(e) => saveExperience({ rewards: e.target.checked })}/>展示学习纪念物</label><p>默认无声音。安静模式仍可看到猫，点击才对话。</p></fieldset>
    {error && <p role="alert" className="study-alert">{error}</p>}
    <button className="study-button study-button-primary" onClick={onClose}>完成设置</button>
  </StudyDialog>
}
