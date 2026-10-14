import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function writeQualityReport(directory, batch) {
  const entries = [...batch.results, ...(batch.followups ?? []), ...(batch.remediations ?? [])]
  const rows = entries.map((entry, index) => `| ${index + 1} | ${entry.sample.id} | ${entry.purpose ?? entry.requestedKinds?.join('、') ?? '五内容'} | ${entry.result.outcome} | ${entry.result.callsUsed} | ${entry.result.usage.inputTokens}/${entry.result.usage.outputTokens} | ${Object.keys(entry.result.artifacts ?? {}).join('、') || '无'} |`).join('\n')
  const coverage = batch.samples.map((sample) => {
    const kinds = new Set(entries.filter((entry) => entry.sample.id === sample.id).flatMap((entry) => Object.keys(entry.result.artifacts ?? {})))
    return `- ${sample.id}：${kinds.size}/5 类，${[...kinds].join('、') || '无产物'}。`
  }).join('\n')
  await writeFile(join(directory, 'report.md'), `# 真实模型质量回归执行记录\n\n模型 ${batch.model}，服务 ${batch.provider}，语料 ${batch.corpusVersion}，执行 ${batch.executionId}。\n\n限定原创公开样本；不使用用户文件。每次执行最多 8 次调用，批次最多 16 次；单次输出最多 4096 tokens；批次总 token 预算 100000。已结束且用量完整的调用按实际计入，运行中或结果未知的调用保留估算额度。价格未知，费用以服务商账单为准，不能视为人民币费用上限。\n\n| 阶段 | 公开样本 | 范围 | 结果 | 实际调用 | 输入/输出 tokens | 已校验产物 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n实际调用 ${batch.callsUsed}/16；输入 ${batch.inputTokens}，输出 ${batch.outputTokens}，合计 ${batch.inputTokens + batch.outputTokens}/100000 tokens；结果未知 ${batch.unresolvedCount}。\n\n${coverage}\n\n跨运行取得五类产物仅说明类别覆盖，不能据此声称单次五内容流程通过。原始流水线通过：${batch.pipelinePassed ? '是' : '否'}。语义质量仍需要独立审阅；所有结果保持 modelQualityApproved=false。修订建议不计为生产 Artifact，也不覆盖原输出。\n\n公开原文与真实产物见 [results.json](results.json)，每次调用及失败见 [diagnostics.json](diagnostics.json)。若有质量修订见 [quality-fix-proposal.json](quality-fix-proposal.json)。\n\n停止后不会自动重试。续测必须核对原账本、连接与剩余预算；未知结果或未完成检查点禁止续测。验证任务正文按自身范围清理，调用记录保留。\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  if (process.argv.length !== 3 || !/^quality-regression-[0-9a-f-]{36}$/u.test(name ?? '')) throw new Error('Expected quality batch directory')
  const directory = resolve(import.meta.dirname, '..', '..', 'reports', name)
  await writeQualityReport(directory, JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')))
}
