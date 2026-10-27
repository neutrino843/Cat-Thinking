import type { ArtifactEnvelopeV1 } from '@cat-thinking/analysis-contracts'
import { AnalysisTaskController, isAnalysisTerminal, type AnalysisTaskState } from '../analysis/taskController'
import { HttpAnalysisEngineClient } from '../analysis/engineClient'
import { analysisTaskRepository } from '../analysis/taskPersistence'
import { LearningError } from './model'
import { createLearningArchive, loadCourseSnapshot } from './repository'
import { bindNodeHintArchive } from './nodeLearning'
import type { NodeSupport } from './nodeTypes'

export async function persistNodeHintResult(courseId: string, support: NodeSupport, runId: string, artifacts: ArtifactEnvelopeV1[]) {
  const archive = await createLearningArchive({ courseId, docId: support.docId, runId, artifacts, title: `节点提示 · ${support.question}`.slice(0, 200) })
  // An unrelated draft can win the course CAS. Binding the same immutable
  // archive again is safe and never creates a second model task.
  for (let attempt = 0; ; attempt++) {
    try { await bindNodeHintArchive(courseId, support.id, archive.id); return }
    catch (error) { if (!(error instanceof LearningError) || error.code !== 'conflict' || attempt >= 2) throw error }
  }
}

/** One bounded read of a stored task. connect() never submits or resumes work. */
async function readExistingTask(docId: string): Promise<AnalysisTaskState> {
  const controller = new AnalysisTaskController(docId, new HttpAnalysisEngineClient(), analysisTaskRepository)
  let unsubscribe = () => {}
  let disconnect = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<AnalysisTaskState>((resolve, reject) => {
      unsubscribe = controller.subscribe(() => {
        const state = controller.getSnapshot()
        if (!state.loading) resolve(state)
      })
      timeout = setTimeout(() => reject(new LearningError('missing', '提示结果状态读取超时。')), 15_000)
      disconnect = controller.connect()
    })
  } finally {
    clearTimeout(timeout); unsubscribe(); disconnect()
  }
}

/** Export is an explicit boundary: settle results even when their panel was closed. */
export async function archiveNodeHintsForBackup(courseId: string) {
  const snapshot = await loadCourseSnapshot(courseId)
  for (const support of snapshot.nodeWorkspace?.supports ?? []) {
    if (support.archiveId || support.restored || !await analysisTaskRepository.load(support.docId)) continue
    const state = await readExistingTask(support.docId)
    if (!state.run || !isAnalysisTerminal(state.run) || state.sourceChanged) {
      throw new LearningError('missing', '有提示任务尚未完成或状态无法确认。请回原轮次恢复查看后再备份，也可明确选择仅备份本机已有数据。')
    }
    const succeeded = Object.values(state.run.artifactStates).filter((item) => item?.status === 'succeeded').length
    const artifacts = Object.values(state.mirror?.artifacts ?? {}).filter((item): item is ArtifactEnvelopeV1 => !!item)
    if (succeeded !== artifacts.length) throw new LearningError('missing', '已完成的提示结果尚未完整取回，请恢复查看后再备份；本次没有重新调用模型。')
    if (artifacts.length) await persistNodeHintResult(courseId, support, state.run.id, artifacts)
  }
}
