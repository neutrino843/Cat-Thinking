import { db } from '../store/db'
import { getCourse } from '../learning/repository'
import { sha256Hex } from '../analysis/fingerprint'
import { buildFirstQuestion, type FirstQuestion, type GuideBinding } from './guide'

export async function readGuideQuestion(binding: GuideBinding): Promise<FirstQuestion> {
  const [source, doc, course] = await Promise.all([db.sources.get(binding.sourceId), db.docs.get(binding.docId), getCourse(binding.courseId)])
  if (!source || !doc || !course || source.docId !== binding.docId || await sha256Hex(source.text) !== binding.sourceHash) throw new Error('这份资料已被删除或修改。请重新选择资料；不会用失效原文核对答案。')
  const question = buildFirstQuestion(source)
  if (!question) throw new Error('这份资料里暂时没有适合原文填空的完整文字。可以回到资料阅读，或换一份有正文的资料。')
  return question
}
