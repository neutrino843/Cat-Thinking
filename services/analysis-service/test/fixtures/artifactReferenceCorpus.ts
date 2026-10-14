import { createHash } from 'node:crypto'
import { evidenceGraphSchema, sourceSnapshotSchema, type EvidenceClaimV1, type EvidenceGraphV1, type SourceSnapshotV1 } from '@cat-thinking/analysis-contracts'
import { validateEvidenceCard } from '../../src/domain/evidenceValidator.js'

interface PublicFact {
  readonly id: string
  readonly statement: string
  readonly quote: string
  readonly occurrence?: number
  readonly kind?: EvidenceClaimV1['kind']
}

export interface ArtifactReferenceCorpusCase {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly facts: readonly PublicFact[]
  readonly expectedSummary: string
  /** Human-authored interpretation boundaries, not an automated claim of model quality. */
  readonly expectedBehavior: readonly string[]
}

const longParagraph = (index: number) => `第${index}组记录：在保持种子品种、含水量和观察时长一致的条件下，分别记录有光组与遮光组的叶片颜色。观察记录仅用于比较颜色变化，不能单凭颜色证明所有生长差异都由光照造成。`
const longText = Array.from({ length: 64 }, (_, index) => longParagraph(index + 1)).join('\n')

/** Written for this repository. No uploaded documents, private quotations, model replies, or credentials. */
export const ARTIFACT_REFERENCE_CORPUS: readonly ArtifactReferenceCorpusCase[] = [
  {
    id: 'chinese-concepts', title: '中文概念及内在关系',
    text: '光合作用把光能转化为储存在有机物中的化学能。\n光反应产生 ATP 和 NADPH。\n卡尔文循环利用 ATP 和 NADPH 固定二氧化碳。',
    facts: [
      { id: 'energy', statement: '光合作用把光能转化为化学能。', quote: '光合作用把光能转化为储存在有机物中的化学能。', kind: 'relationship' },
      { id: 'carriers', statement: '光反应产生 ATP 和 NADPH。', quote: '光反应产生 ATP 和 NADPH。' },
      { id: 'fixation', statement: '卡尔文循环利用 ATP 和 NADPH 固定二氧化碳。', quote: '卡尔文循环利用 ATP 和 NADPH 固定二氧化碳。', kind: 'relationship' },
    ],
    expectedSummary: '光合作用包含有联系的反应过程：光反应产生 ATP 和 NADPH，卡尔文循环利用它们固定二氧化碳。',
    expectedBehavior: ['光反应与卡尔文循环属于光合作用的过程。', '两阶段可通过 ATP 和 NADPH 的供给关系连接。', '不要补充原文未给出的具体酶、地点或效率。'],
  },
  {
    id: 'laboratory-chapters', title: '章节与实验流程',
    text: '一、实验目的\n用透明杯观察盐在水中的溶解过程。\n二、实验步骤\n先取两杯等体积的水，再向各杯加入等质量的盐。\n一杯轻轻搅拌，另一杯保持静置；每隔十秒记录可见晶体。\n三、结论边界\n本次只比较搅拌条件下的可见溶解过程，不能推断盐的化学组成发生改变。',
    facts: [
      { id: 'purpose', statement: '实验观察盐在水中的溶解过程。', quote: '用透明杯观察盐在水中的溶解过程。' },
      { id: 'controls', statement: '水的体积和盐的质量保持一致。', quote: '先取两杯等体积的水，再向各杯加入等质量的盐。', kind: 'procedure' },
      { id: 'observation', statement: '比较搅拌和静置，每隔十秒记录晶体。', quote: '一杯轻轻搅拌，另一杯保持静置；每隔十秒记录可见晶体。', kind: 'procedure' },
      { id: 'boundary', statement: '不能据此推断盐的化学组成改变。', quote: '本次只比较搅拌条件下的可见溶解过程，不能推断盐的化学组成发生改变。' },
    ],
    expectedSummary: '本实验控制水和盐的用量，比较搅拌与静置下的可见溶解过程；记录不能证明盐的化学组成改变。',
    expectedBehavior: ['目的、步骤、结论边界应分组。', '等量取样应先于搅拌对照和定时记录。', '没有实验数据时不要生成“搅拌一定更快”的测量结论。'],
  },
  {
    id: 'repeated-passages', title: '重复文字的不同原文位置',
    text: '第一组：保持其他条件一致。\n处理温度为 20℃。\n第二组：保持其他条件一致。\n处理温度为 30℃。',
    facts: [
      { id: 'first-control', statement: '第一组保持其他条件一致。', quote: '保持其他条件一致。', occurrence: 0 },
      { id: 'first-temperature', statement: '第一组处理温度为 20℃。', quote: '处理温度为 20℃。' },
      { id: 'second-control', statement: '第二组保持其他条件一致。', quote: '保持其他条件一致。', occurrence: 1 },
      { id: 'second-temperature', statement: '第二组处理温度为 30℃。', quote: '处理温度为 30℃。' },
    ],
    expectedSummary: '两组保持其他条件一致，处理温度分别为 20℃ 和 30℃。',
    expectedBehavior: ['相同文字在两个位置出现时，引用位置仍须分别保留。', '没有结果数据时不要虚构温度的影响。'],
  },
  {
    id: 'plain-text-table', title: '文本表格中的单位及限制',
    text: '样本 | 时间（秒） | 质量（克）\n甲 | 10 | 2.0\n乙 | 20 | 2.0\n说明：两行记录来自同一次演示，不构成重复实验。',
    facts: [
      { id: 'units', statement: '时间单位为秒，质量单位为克。', quote: '样本 | 时间（秒） | 质量（克）' },
      { id: 'sample-a', statement: '甲的时间为 10 秒、质量为 2.0 克。', quote: '甲 | 10 | 2.0' },
      { id: 'sample-b', statement: '乙的时间为 20 秒、质量为 2.0 克。', quote: '乙 | 20 | 2.0' },
      { id: 'limit', statement: '两行记录不构成重复实验。', quote: '说明：两行记录来自同一次演示，不构成重复实验。' },
    ],
    expectedSummary: '演示中甲、乙的记录时间分别为 10 秒和 20 秒，质量均为 2.0 克；这两行记录不构成重复实验。',
    expectedBehavior: ['数值必须带回对应列的单位。', '不要把两行记录视为多次重复实验或声称有统计显著性。'],
  },
  {
    id: 'one-fact', title: '只有一条信息的短文',
    text: '正方形的四条边长度相等。',
    facts: [{ id: 'equal-sides', statement: '正方形的四条边长度相等。', quote: '正方形的四条边长度相等。' }],
    expectedSummary: '正方形的四条边长度相等。',
    expectedBehavior: ['可以只有一条知识，不强行增加三层分支。', '未提供面积公式时不要将公式包装成原文内容。'],
  },
  {
    id: 'information-limited', title: '没有提供结果的资料',
    text: '阅读任务：比较两种整理方式。\n本页尚未提供比较标准、过程记录或结果。',
    facts: [{ id: 'missing-results', statement: '资料未提供比较标准、过程记录或结果。', quote: '本页尚未提供比较标准、过程记录或结果。' }],
    expectedSummary: '资料仅说明待比较的任务，尚无标准、过程记录或结果。',
    expectedBehavior: ['应提示信息不足。', '不编造胜出方式、百分比、评价标准或实验结论。'],
  },
  {
    id: 'long-overlapping-support', title: '长材料及重复使用的引文', text: longText,
    facts: Array.from({ length: 64 }, (_, index) => ({ id: `record-${index + 1}`,
      statement: `第${index + 1}组比较有光组与遮光组的颜色，但不能仅凭颜色判断所有生长差异的原因。`,
      quote: longParagraph(index + 1),
    })),
    expectedSummary: '各组在一致条件下记录两组叶片颜色；颜色观察不能单独证明所有生长差异都由光照造成。',
    expectedBehavior: ['每组材料的支持必须全部保留，不能为缩短输入丢弃后半段。', '同一段引文在事实、术语、目标中复用时，只需在引用目录存放一次。', '不得将观察记录解释为确定的因果结论。'],
  },
]

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

const locateOccurrence = (text: string, quote: string, occurrence: number) => {
  let start = -1
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(quote, start + 1)
    if (start < 0) throw new Error('Public corpus quote does not match its declared occurrence')
  }
  return start
}

/** Builds known-good Evidence, and verifies every quote against the authored source before catalogue tests. */
export function createPublicCorpusEvidence(item: ArtifactReferenceCorpusCase): { graph: EvidenceGraphV1; snapshot: SourceSnapshotV1 } {
  const sourceId = `public-${item.id}`
  const snapshot = sourceSnapshotSchema.parse({ version: 1, sourceId, kind: 'text', extractor: 'authored-public-corpus-v1',
    contentHash: hash(item.text), charCount: item.text.length, byteCount: Buffer.byteLength(item.text, 'utf8') })
  const chunk = { version: 1 as const, chunkId: `chunk-${item.id}`, chunkHash: hash(item.text), sourceId,
    start: 0, end: item.text.length, titlePath: [item.title], estimatedTokens: Math.max(1, Math.ceil(item.text.length / 2)),
    ordinal: 0, total: 1, overlapBefore: 0, overlapAfter: 0 }
  const claims = item.facts.map((fact) => {
    const start = locateOccurrence(item.text, fact.quote, fact.occurrence ?? 0)
    return { id: fact.id, kind: fact.kind ?? 'fact' as const, statement: fact.statement, conceptIds: [], citations: [{
      version: 1 as const, provenance: 'source' as const, sourceId, start, end: start + fact.quote.length, quote: fact.quote,
    }] }
  })
  // Terms/objectives intentionally share source support with claims: deduplication must not lose their bindings.
  const terms = claims.map((claim) => ({ id: `term-${claim.id}`, term: `记录要点：${claim.id}`,
    definition: claim.statement, citations: claim.citations }))
  const learningObjectives = claims.map((claim) => ({ id: `objective-${claim.id}`,
    text: `理解原文记录：${claim.id}`, evidenceIds: [claim.id, `term-${claim.id}`] }))
  const card = validateEvidenceCard({ card: { version: 1, chunkId: chunk.chunkId, chunkHash: chunk.chunkHash,
    sourceId, titlePath: chunk.titlePath, claims, terms, learningObjectives }, chunk, snapshot, sourceText: item.text })
  const graph = evidenceGraphSchema.parse({ version: 1, runId: `run-${item.id}`, graphHash: hash(JSON.stringify(card)),
    chunkPlanHash: hash(JSON.stringify(chunk)), sourceContentHashes: [snapshot.contentHash], policyVersion: 'public-corpus-v1',
    promptVersion: 'evidence-source-ref-v3', generatorProfile: 'manual-public-fixture-v1', chunks: [chunk], cards: [card],
    claims: card.claims, terms: card.terms, learningObjectives: card.learningObjectives,
    coverage: { input: 1, analysis: 1, citation: 1, chunksCompleted: 1, chunksFailed: 0, chunksTotal: 1 }, missingChunkIds: [], createdAt: 1 })
  return { graph, snapshot }
}
