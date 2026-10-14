import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { localArtifactFixtures } from '../test/localArtifactFixtures'
import { sha256Hex } from '../analysis/fingerprint'
import { archiveHashPayload } from './archiveValidation'
import { learningBase, type LearningArchive } from './model'

export async function archivedFixture() {
  const fixture = await localArtifactFixtures()
  const archive: LearningArchive = { ...learningBase('synthetic-course', 'synthetic-archive', 1), kind: 'archive', originDocId: fixture.doc.id, provenanceDocId: fixture.doc.id, runId: fixture.quiz.runId, title: '公开合成学习归档', manifest: fixture.task.request.manifest, sources: [fixture.source], artifacts: [fixture.mindmap, fixture.quiz], contentHash: '' }
  archive.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(archive)))
  return { ...fixture, archive }
}
