import type { CourseSnapshot } from './model'
import type { DocMeta } from '../types'
import type { HomeTask } from './homeView'
import type { GuideProgress } from '../onboarding/guide'
import type { LearningSession } from './model'
import type { LearningJourney } from './model'

export interface HomePrimaryInput {
  chooseFirst: boolean
  guideCanResume: boolean
  guideProgress: GuideProgress
  resume: { snapshot: CourseSnapshot; session: LearningSession; reason?: string } | undefined
  latestJourney: { snapshot: CourseSnapshot; journey: LearningJourney } | undefined
  pendingDoc: DocMeta | undefined
  availableDoc: DocMeta | undefined
  firstTask: HomeTask | undefined
  personalSnapshots: CourseSnapshot[]
  unarchivedCount: number
  archivedWithin24h: boolean
  hasPracticeQuestions: boolean
}

export interface HomePrimaryDecision {
  headline: string
  primary: string
  description: string
  kind: 'choose-course' | 'resume-guide' | 'resume-journey' | 'resume-session' | 'start-doc' | 'save-analysis' | 'start-practice' | 'start-task' | 'import'
}

/**
 * 首页主行动决策：从「最高优先级」到「最低优先级」依次匹配。
 * P0 选课程 → P1 继续引导 → P2 继续旅程 → P3 继续会话 →
 * P4 待学习资料 → P5 保存分析 → P6 开始练习 → P7 今日任务 → P8 有资料 → P9 导入
 */
export function decideHomePrimary(input: HomePrimaryInput): HomePrimaryDecision {
  const { chooseFirst, guideCanResume, guideProgress, resume, latestJourney,
    pendingDoc, availableDoc, firstTask, personalSnapshots, unarchivedCount,
    archivedWithin24h, hasPracticeQuestions } = input

  if (chooseFirst) {
    return { headline: '今天想学哪门课？', primary: '选择课程', description: '选定课程后，这里只推荐一个下一步。', kind: 'choose-course' }
  }

  const resumeGuideFirst = guideCanResume && (!resume || guideProgress.stepAt >= resume.session.updatedAt)
  if (resumeGuideFirst) {
    return { headline: '从上次停下的地方继续。', primary: '继续学习',
      description: '伊希斯保留了你的入门练习，接着完成第一道题。', kind: 'resume-guide' }
  }

  const journeyFirst = !!latestJourney && latestJourney.journey.updatedAt >= Math.max(resume?.session.updatedAt ?? 0, guideCanResume ? guideProgress.stepAt : 0)
  if (journeyFirst && latestJourney) {
    return { headline: '从上次停下的地方继续。', primary: '继续学习',
      description: `${latestJourney.journey.title} · 阅读位置、修正笔记和重试记录会一起恢复。`, kind: 'resume-journey' }
  }

  if (resume) {
    return { headline: '从上次停下的地方继续。', primary: '继续学习',
      description: `${resume.session.title} · ${resume.reason || '已保存的步骤和文字会一起恢复。'}`, kind: 'resume-session' }
  }

  if (pendingDoc) {
    return { headline: `从「${pendingDoc.title}」开始。`, primary: '开始原文入门练习',
      description: '先读一小段，做一道原文入门题。不用先连接 AI。', kind: 'start-doc' }
  }

  if (unarchivedCount > 0) {
    return { headline: '有分析结果待保存。', primary: '去保存分析结果',
      description: `${unarchivedCount} 份分析结果已生成，保存到课程后可以开始练习。`, kind: 'save-analysis' }
  }

  if (firstTask) {
    return { headline: firstTask.title, primary: '开始这次学习',
      description: firstTask.recommendationReason, kind: 'start-task' }
  }

  if (archivedWithin24h && hasPracticeQuestions) {
    return { headline: '开始第一次练习。', primary: '开始第一次练习',
      description: '分析结果已保存，来做几道题检验掌握程度。', kind: 'start-practice' }
  }

  if (availableDoc) {
    return { headline: '从你已有的资料开始。', primary: '开始原文入门练习',
      description: '先读一小段，做一道原文入门题。不用先连接 AI。', kind: 'start-doc' }
  }

  if (personalSnapshots.length) {
    return { headline: '为今天选一点学习内容。', primary: '开始这次学习',
      description: '今天还没有安排任务，从课程中挑一个知识点开始学习。', kind: 'choose-course' }
  }

  return { headline: '带一份资料，开始学习。', primary: '导入第一份资料',
    description: '导入讲义或笔记，读一点，再试着回忆。', kind: 'import' }
}
