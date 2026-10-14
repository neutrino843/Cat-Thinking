import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ARTIFACT_KINDS, quizArtifactSchema, type ArtifactKind } from '@cat-thinking/analysis-contracts'
import { ARTIFACT_PAYLOAD_SCHEMAS } from '../src/providers/artifactPrompts.js'
import type { ModelRequest, ModelResponse } from '../src/providers/modelProvider.js'
import { BrowserSyntheticProvider } from './fixtures/browserSyntheticProvider.js'

const citation = { version: 1, provenance: 'source', sourceId: 'public-source', start: 0, end: 8 }
const prompt = (kind: ArtifactKind, count = 5, source = 'public-source', statement = '公开合成数据') => JSON.stringify({
  kind, options: { quizQuestionCount: count }, evidence: { claims: [{ id: 'public-claim', statement, citations: [{ ...citation, sourceId: source }] }] },
})
const request = (kind: ArtifactKind, userPrompt = prompt(kind)): ModelRequest => ({ invocationId: 'synthetic-invocation', role: `artifact-${kind}`,
  qualityProfile: 'standard', systemPrompt: 'synthetic', userPrompt, output: { name: 'synthetic', schema: {} }, maxOutputTokens: 1000 })
const signal = () => new AbortController().signal
const finish = async (promise: Promise<ModelResponse>) => { await vi.runAllTimersAsync(); return JSON.parse((await promise).outputText) as unknown }
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it.each(ARTIFACT_KINDS)('browser fake handles %s explicitly and emits its bounded payload schema', async (kind) => {
  const provider = new BrowserSyntheticProvider()
  const payload = await finish(provider.generate(request(kind), signal()))
  expect(ARTIFACT_PAYLOAD_SCHEMAS[kind].safeParse(payload).success).toBe(true)
})
it.each([5, 10, 20])('browser fake uses the actual selected quiz count %i and three question types', async (count) => {
  const provider = new BrowserSyntheticProvider()
  const payload = quizArtifactSchema.parse(await finish(provider.generate(request('quiz', prompt('quiz', count)), signal())))
  expect(payload.questions).toHaveLength(count)
  expect(new Set(payload.questions.map((question) => question.type))).toEqual(new Set(['multiple-choice', 'true-false', 'short-answer']))
})
it('explicit Artifact and Evidence repair preserve task identity instead of returning a generic Outline', async () => {
  const provider = new BrowserSyntheticProvider()
  const repaired = await finish(provider.generate({ ...request('knowledge'), role: 'repair', userPrompt: JSON.stringify({ original: prompt('knowledge') }) }, signal()))
  expect(ARTIFACT_PAYLOAD_SCHEMAS.knowledge.safeParse(repaired).success).toBe(true)
  const original = 'Map the following immutable chunk envelope to evidence JSON.\n' + JSON.stringify({ sourceText: '公开合成数据', range: { start: 10, end: 16 } })
  const mapped = await finish(provider.generate({ ...request('outline'), role: 'repair', userPrompt: JSON.stringify({ original }) }, signal()))
  expect(mapped).toMatchObject({ claims: [{ citations: [{ start: 10, end: 16 }] }] })
})
it('partial failure is a known refusal once per source and survives explicit retry independently of another run', async () => {
  const provider = new BrowserSyntheticProvider()
  const first = expect(provider.generate(request('outline', prompt('outline', 5, 'source-1', 'fixture partial')), signal())).rejects.toMatchObject({ acceptance: 'not_accepted' })
  await vi.runAllTimersAsync(); await first
  expect(ARTIFACT_PAYLOAD_SCHEMAS.outline.safeParse(await finish(provider.generate(request('outline', prompt('outline', 5, 'source-1', 'fixture partial')), signal()))).success).toBe(true)
  const second = expect(provider.generate(request('outline', prompt('outline', 5, 'source-2', 'fixture partial')), signal())).rejects.toMatchObject({ acceptance: 'not_accepted' })
  await vi.runAllTimersAsync(); await second
})
it('rejects unsupported roles and missing evidence rather than falling back to an Outline', async () => {
  const provider = new BrowserSyntheticProvider()
  await expect(provider.generate({ ...request('outline'), role: 'evidence-merge' }, signal())).rejects.toThrow('Unsupported')
  await expect(provider.generate(request('summary', JSON.stringify({ kind: 'summary', evidence: { claims: [] } })), signal())).rejects.toThrow('evidence missing')
  const controller = new AbortController(); controller.abort(new Error('aborted'))
  await expect(provider.generate(request('summary'), controller.signal)).rejects.toThrow('aborted')
})
