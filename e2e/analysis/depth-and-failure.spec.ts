import { readFile } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { DocData } from '../../src/types'
import { resetStore, waitForApp } from '../helpers'
import { ANALYSIS_SYNTHETIC } from '../../services/analysis-service/test/fixtures/browserSyntheticTexts'

const panel = (page: Page) => page.getByRole('dialog', { name: 'AI 学习分析' })
async function openSource(page: Page, text: string) {
  await resetStore(page); await waitForApp(page)
  await page.locator('input[type=file][accept^=".txt"]').setInputFiles({ name: '公开合成验收.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  const imported = page.getByRole('dialog', { name: '从文档生成可编辑导图' })
  await imported.getByRole('button', { name: '创建可编辑导图' }).click()
  await expect(imported).toBeHidden()
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
}
async function localState(page: Page) {
  return page.evaluate(async () => {
    const opening = indexedDB.open('maosizhi')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    const read = <T,>(table: string) => new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(table).objectStore(table).getAll()
      request.onsuccess = () => resolve(request.result as T[]); request.onerror = () => reject(request.error)
    })
    try { return { tasks: await read<{ runId: string }>('analysisTasks'), docs: await read<{ id: string; payload: string }>('docs'),
      receipts: await read<{ targetDocId: string }>('applicationReceipts') } } finally { db.close() }
  })
}
async function ledger(request: APIRequestContext, runId: string) {
  const response = await request.get(`http://127.0.0.1:8790/__synthetic/runs/${runId}`, {
    headers: { authorization: `Bearer ${process.env.ANALYSIS_GATEWAY_TOKEN ?? ''}` },
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).ledger as { invocationCount: number; usage: { inputTokens: number; outputTokens: number } }
}

test('引文失败明确终止，独立修复只有一次，刷新与脱敏诊断不产生额外生成', async ({ page, request }) => {
  await openSource(page, ANALYSIS_SYNTHETIC.invalidEvidence)
  await panel(page).getByRole('button', { name: '生成摘要与大纲' }).click()
  await expect(panel(page)).toContainText('任务：分析失败', { timeout: 20_000 })
  await expect(panel(page)).toContainText('模型返回的引文或知识引用无法与原文对应')
  await expect(panel(page).getByRole('region', { name: '摘要结果' })).toContainText('未生成')
  await expect(panel(page).getByRole('region', { name: '大纲结果' })).not.toContainText('等待生成')
  const id = (await localState(page)).tasks[0].runId
  const before = await ledger(request, id)
  expect(before).toMatchObject({ invocationCount: 2, usage: { inputTokens: 40, outputTokens: 20 } })
  const downloaded = page.waitForEvent('download')
  await panel(page).getByRole('button', { name: '下载诊断信息' }).click()
  const file = await (await downloaded).path()
  if (!file) throw new Error('Diagnostic download missing')
  const content = await readFile(file, 'utf8')
  expect(JSON.parse(content)).toMatchObject({ kind: 'cat-thinking-analysis-diagnostic', status: 'failed', error: { stage: 'mapping' } })
  expect(content).not.toContain(ANALYSIS_SYNTHETIC.invalidEvidence)
  expect(content).not.toContain('sourceText')
  expect(content).not.toContain('apiKey')
  await panel(page).getByRole('button', { name: '恢复查看' }).click()
  await page.reload(); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page)).toContainText('任务：分析失败')
  expect(await ledger(request, id)).toEqual(before)
  await page.screenshot({ path: 'test-results/analysis-failure-diagnostic.png' })
})

test('深层知识结构经模型、校验、嵌套预览和独立导图应用保留父子与跨节点关系', async ({ page, request }) => {
  await openSource(page, ANALYSIS_SYNTHETIC.hierarchy)
  await panel(page).getByRole('checkbox', { name: '导图', exact: true }).check()
  await panel(page).getByRole('button', { name: '生成所选内容' }).click()
  await expect(panel(page)).toContainText('任务：分析完成', { timeout: 20_000 })
  const result = panel(page).getByRole('region', { name: '导图结果' })
  await expect(result.locator('.analysis-mindmap-tree ul ul ul').first()).toContainText('ATP 和 NADPH')
  await expect(result.getByRole('region', { name: '导图关系' })).toContainText('提供 ATP 和 NADPH')
  const id = (await localState(page)).tasks[0].runId
  expect((await ledger(request, id)).invocationCount).toBe(4)
  await result.getByRole('button', { name: '创建独立导图' }).click()
  await expect(result.getByRole('button', { name: '打开生成导图' })).toBeVisible()
  const snapshot = await localState(page)
  const stored = snapshot.docs.find((doc) => doc.id === snapshot.receipts[0].targetDocId)
  if (!stored) throw new Error('Independent mind map missing')
  const doc = JSON.parse(stored.payload) as DocData
  const carriers = Object.values(doc.nodes).find((node) => node.text === 'ATP 和 NADPH')
  const reaction = carriers?.parent ? doc.nodes[carriers.parent] : undefined
  const concept = reaction?.parent ? doc.nodes[reaction.parent] : undefined
  expect(reaction?.text).toBe('光反应')
  expect(concept?.text).toBe('光合作用')
  expect(doc.relations).toHaveLength(1)
  await page.screenshot({ path: 'test-results/analysis-deep-hierarchy.png' })
  await page.reload(); await waitForApp(page)
  expect((await ledger(request, id)).invocationCount).toBe(4)
})

test('大纲截断的原因不会被导图依赖错误掩盖，恢复与诊断保持零新增调用', async ({ page, request }) => {
  await openSource(page, ANALYSIS_SYNTHETIC.truncatedOutline)
  await panel(page).getByRole('checkbox', { name: '摘要', exact: true }).uncheck()
  await panel(page).getByRole('checkbox', { name: '导图', exact: true }).check()
  await panel(page).getByRole('button', { name: '生成所选内容' }).click()
  await expect(panel(page)).toContainText('任务：分析失败', { timeout: 20_000 })
  await expect(panel(page).locator('.analysis-error').first()).toContainText('模型返回的内容不完整')
  await expect(panel(page).getByRole('region', { name: '导图结果' })).toContainText('所需的大纲尚未成功生成')
  const id = (await localState(page)).tasks[0].runId
  const before = await ledger(request, id)
  expect(before.invocationCount).toBe(2)
  expect(before.usage.outputTokens).toBe(1810)
  const downloaded = page.waitForEvent('download')
  await panel(page).getByRole('button', { name: '下载诊断信息' }).click()
  const file = await (await downloaded).path()
  if (!file) throw new Error('Diagnostic download missing')
  const diagnostic = await readFile(file, 'utf8')
  expect(JSON.parse(diagnostic)).toMatchObject({ error: { stage: 'outline', providerCode: 'finish_not_complete' } })
  expect(diagnostic).not.toContain(ANALYSIS_SYNTHETIC.truncatedOutline)
  await page.reload(); await waitForApp(page)
  await page.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await expect(panel(page).locator('.analysis-error').first()).toContainText('模型返回的内容不完整')
  expect(await ledger(request, id)).toEqual(before)
  await page.screenshot({ path: 'test-results/analysis-outline-truncation.png' })
})
