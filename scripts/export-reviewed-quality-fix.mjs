import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { qualitySample } from '../services/analysis-service/dist/operations/qualityCorpus.js'

// Local source review only. Does not contact a model or alter an immutable learning archive.
const name = process.argv[2]
if (process.argv.length !== 3 || !/^quality-regression-[0-9a-f-]{36}$/u.test(name ?? '')) throw new Error('Expected quality batch directory')
const directory = resolve(import.meta.dirname, '..', '..', 'reports', name)
const raw = JSON.parse(await readFile(join(directory, 'quality-fix-proposal.json'), 'utf8'))
const source = qualitySample('photosynthesis').text
if (raw.sampleId !== 'photosynthesis' || !raw.sourceQuotesVerified) throw new Error('expected public checked proposal')
const reviewed = structuredClone(raw.proposal)
reviewed.additions[0] = { title: '重复组与测量指标',
  statement: '设置重复组观察稳定性；记录单位时间内氧气变化，并说明指标与研究过程的关系。',
  quote: '设置重复组有助于观察稳定性，记录单位时间内氧气变化时应说明指标与研究过程的关系。' }
reviewed.question.answer = '植物材料、二氧化碳供应、温度和测量时长保持相同。'
const q4 = { originalQuestionId: 'q4', prompt: '根据资料，哪项可能解释提高光照后光合速率出现平台？',
  answer: '二氧化碳供应或其他条件成为限制因素',
  quote: '达到一定水平后，速率可能出现平台，二氧化碳供应或其他条件可能成为限制因素。' }
const additions = [...reviewed.additions, q4]
for (const item of [...additions, ...reviewed.question.rubric]) if (!source.includes(item.quote)) throw new Error('quote_not_in_public_source')
if (reviewed.question.rubric.some((item) => /光源|升温|干扰/u.test(item.criterion))) throw new Error('extra_scoring_requirement')
const document = { version: 1, sampleId: raw.sampleId, reviewer: 'Codex source-based review', userApproved: false,
  notProductionArtifact: true, originalModelProposal: 'quality-fix-proposal.json',
  changes: ['补齐模型修订仍遗漏的测量指标', '参考答案只保留题干所需的四个变量', 'q4 将最可能改为可能，保留原文的不确定性'],
  proposal: { ...reviewed, q4 }, sourceRanges: additions.map((item) => ({ title: item.title ?? 'q4',
    start: source.indexOf(item.quote), end: source.indexOf(item.quote) + item.quote.length, quote: item.quote })) }
await writeFile(join(directory, 'reviewed-quality-fix.json'), JSON.stringify(document, null, 2))
console.log('Reviewed public-source draft exported; no provider call, archive mutation or user approval.')
