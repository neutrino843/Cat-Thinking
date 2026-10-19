/** Authored demonstration only. No model, university course or learner outcome is implied. */
export const courseData = {
  name: '自编示范 · 统计学中的相关与因果',
  filename: '自编示范-相关与因果.txt',
  disclosure: '自编、预先整理并核对的演示内容；不是暨大课程讲义，不是AI现场生成，不是真人试用数据。',
  sections: [
    {
      title: '相关与因果',
      text: '相关描述变量一起变化的统计关系，单凭相关不能确认一个变量导致另一个变量变化。例如，炎热天气可能同时增加冰淇淋销量和人们游泳的机会。即使冰淇淋销量与溺水事件一起上升，也不能仅凭这种相关断言冰淇淋导致溺水。',
      questions: [
        { id: 'correlation-choice', type: 'multiple-choice', prompt: '冰淇淋销量与溺水事件一起上升，哪种解释符合资料？', options: ['冰淇淋销量上升必然导致溺水', '气温可能同时影响两者，相关本身不能确认因果', '两者没有任何可能的共同影响因素'], answerIndex: 1, explanation: '资料给出了天气这一可能的共同因素，因此相关本身不足以确认因果关系。' },
        { id: 'correlation-true-false', type: 'true-false', prompt: '只要两个变量一起变化，就可以确认一个变量导致另一个变量变化。', answer: false, explanation: '相关本身不能确认因果，还要考虑共同因素和其他解释。' },
      ],
    },
    {
      title: '共同因素与研究设计',
      text: '可能同时影响所研究两个变量的因素，是需要考虑的共同因素。比较两种学习方式时，原有基础和学习时间可能影响结果。随机分配有助于减少分组差异，但仍需要检查研究实施、样本与测量条件。一次观察不能代替完整的研究设计。',
      questions: [
        { id: 'design-choice', type: 'multiple-choice', prompt: '比较两种学习方式时，哪项做法更有助于减少分组差异？', options: ['让所有基础好的同学使用同一种方式', '只挑选表现最好的结果汇报', '在合适条件下随机分配，并检查实施与测量'], answerIndex: 2, explanation: '资料提出随机分配有助于减少分组差异，同时仍需检查研究条件。' },
        { id: 'confound-short', type: 'short-answer', prompt: '举出比较两种学习方式时需要考虑的两个因素。', answer: '原有基础和学习时间。', rubric: ['提到原有基础或同义表述', '提到学习时间或同义表述'], explanation: '按资料中给出的因素自评，合理同义表述可以接受。' },
      ],
    },
    {
      title: '解释学习记录',
      text: '看过提示后答对，说明这次回答在辅助后与参考答案一致，不能单独证明能够独立回忆。立即重复同一道题，可能受到刚看过答案的影响。隔一段时间后，在明确记录帮助条件的情况下再次作答，可以增加观察信息，但单次表现仍不等于长期掌握。',
      questions: [
        { id: 'assistance-true-false', type: 'true-false', prompt: '看过提示后立即答对同题，足以证明长期掌握。', answer: false, explanation: '资料明确区分辅助后的回答、即时重复与长期掌握。' },
        { id: 'verification-short', type: 'short-answer', prompt: '为什么需要记录再次作答的时间和帮助条件？', answer: '即时重复可能受刚看过答案影响，帮助条件也影响如何解释回答，因此需记录间隔和是否使用帮助。', rubric: ['说明即时重复或刚看过答案可能影响表现', '说明帮助条件会影响对作答的解释'], explanation: '这里使用自评，不能用自评完成代替教师评价或长期学习效果。' },
      ],
    },
  ],
}

export function authoredText(data = courseData) {
  return `自编示范：统计学中的相关与因果\n\n${data.disclosure}\n\n${data.sections.map((s, i) => `第${i + 1}节 ${s.title}\n${s.text}`).join('\n\n')}\n`
}

/** Executed in an isolated browser context, using the real app's validation and course format. */
export async function prepareAuthoredCourse(data) {
  const { canonicalizeJson } = await import('/packages/analysis-contracts/src/index.ts')
  const { db } = await import('/src/store/db.ts')
  const { createSourceSnapshot, sha256Hex } = await import('/src/analysis/fingerprint.ts')
  const { archiveHashPayload, parseLearningEntity, validateLearningArchive } = await import('/src/learning/archiveValidation.ts')
  const { learningBase, newLearningId } = await import('/src/learning/model.ts')
  // The source was saved by the visible document import flow, not injected as a fake import result.
  const source = (await db.sources.toArray()).find((s) => s.name === data.filename)
  if (!source) throw new Error('先通过界面导入自编资料，再准备预先编写的正式题。')
  for (const section of data.sections) if (!source.text.includes(section.text)) throw new Error('导入正文与预编写依据不一致。')
  const courseId = newLearningId(), archiveId = newLearningId(), runId = newLearningId(), artifactId = newLearningId()
  const at = Date.now(), manifest = { version: 1, sources: [await createSourceSnapshot(source)] }
  const questions = data.sections.flatMap((section, sectionIndex) => {
    const start = source.text.indexOf(section.text), end = start + section.text.length
    return section.questions.map((question) => ({ ...question, evidenceIds: [`authored-section-${sectionIndex + 1}`], difficulty: 'easy', citations: [{ version: 1, provenance: 'source', sourceId: source.id, start, end, quote: section.text }] }))
  })
  const quiz = { version: 1, schemaVersion: 1, id: artifactId, runId, docId: source.docId, kind: 'quiz', createdAt: at, updatedAt: at, sourceContentHashes: manifest.sources.map((s) => s.contentHash), payload: { title: '自编并预先核对的六题演示', questions } }
  const archive = { ...learningBase(courseId, archiveId, at), kind: 'archive', originDocId: source.docId, provenanceDocId: source.docId, runId, title: '自编演示归档 · 非AI生成', manifest, sources: [source], artifacts: [quiz], contentHash: '' }
  archive.contentHash = await sha256Hex(canonicalizeJson(archiveHashPayload(archive)))
  await validateLearningArchive(archive)
  const points = data.sections.map((section) => {
    const start = source.text.indexOf(section.text)
    return { ...learningBase(courseId), kind: 'point', title: section.title, definition: section.text, chapter: '自编统计学示范', aliases: [], notes: data.disclosure, status: 'active', goalIncluded: true, sourceRefs: [{ archiveId, sourceId: source.id, start, end: start + section.text.length }], questionRefs: section.questions.map((q) => ({ archiveId, artifactId, questionId: q.id, confirmed: true })) }
  })
  const course = { ...learningBase(courseId, courseId, at), kind: 'course', name: data.name, goal: '演示回答、原文核对、修正与再次验证；不作为学习效果证据', timeZone: 'Asia/Shanghai', dailyMinutes: 30, dailyQuestionLimit: 12, goalVersion: 1, automaticReviews: false, example: true }
  await db.transaction('rw', db.learningRecords, async () => {
    await db.learningRecords.bulkAdd([course, archive, ...points, { ...learningBase(courseId), kind: 'document', docId: source.docId, chapter: '自编统计学示范' }].map(parseLearningEntity))
  })
  return { courseId, documentId: source.docId, pointId: points[0].id, questionKey: `${archiveId}/${artifactId}/${questions[0].id}`, sourceHash: manifest.sources[0].contentHash, archiveHash: archive.contentHash, questionCount: questions.length, disclosure: data.disclosure }
}
