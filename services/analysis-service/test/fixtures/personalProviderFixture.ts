import { randomUUID } from 'node:crypto'
import type { AnalysisEventV1, AnalysisRunV1, ArtifactKind } from '@cat-thinking/analysis-contracts'
import { loadAnalysisServiceConfig } from '../../src/config.js'
import { JobStoreConflictError } from '../../src/domain/jobStore.js'
import type { InMemoryJobStore } from '../../src/infrastructure/memoryJobStore.js'
import { PersonalProfileConflictError, PersonalProfileUnavailableError, type PersonalProfileState, type PersonalProfileStore, type PersonalProviderSnapshot, type PersonalSavedSettings } from '../../src/personal/profileStore.js'
import type { FetchImplementation } from '../../src/providers/openAICompatibleProvider.js'
import type { ModelRequest, ModelTaskRole } from '../../src/providers/modelProvider.js'
import { FakeAnalysisProvider } from './fakeAnalysisProvider.js'

export const personalFixtureConfig = () => loadAnalysisServiceConfig({
  NODE_ENV: 'test', ANALYSIS_OPERATING_MODE: 'personal', ANALYSIS_AUTH_MODE: 'service-token',
  ANALYSIS_SERVICE_TOKEN: 'synthetic-personal-service-token-not-a-real-secret', ANALYSIS_CORS_ORIGINS: 'http://127.0.0.1:5173',
  ANALYSIS_JOB_STORE: 'postgres', ANALYSIS_DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/cat_analysis_test',
  ANALYSIS_CONTENT_ENCRYPTION_KEY: Buffer.alloc(32, 47).toString('base64'), ANALYSIS_LEASE_MS: '1000', ANALYSIS_SSE_POLL_MS: '100',
})
export const personalFixtureSettings = (modelId = 'synthetic-model'): PersonalSavedSettings => ({
  version: 1, providerId: 'custom', baseUrl: 'http://127.0.0.1:9876/v1/', modelId,
  apiKey: 'synthetic-personal-key-not-real', protocol: 'chat-completions', structuredOutput: 'json_schema', networkMode: 'local-loopback',
})

// This fixture tests manager decisions; PostgreSQL integration tests prove binding atomicity and encryption.
export class MemoryPersonalProfileStore implements PersonalProfileStore {
  state: PersonalProfileState = { revision: 0, enabled: false, checkState: 'unchecked' }
  snapshots = new Map<string, PersonalProviderSnapshot>()
  bindings = new Map<string, string>()
  healthy = true
  constructor(readonly jobs: InMemoryJobStore) {}
  readState() { return Promise.resolve({ ...this.state }) }
  getSnapshot(id: string) { return Promise.resolve(this.snapshots.get(id)) }
  save(revision: number, settings: PersonalSavedSettings) {
    this.expect(revision)
    const id = randomUUID()
    this.snapshots.set(id, { id, settings: { ...settings }, revoked: false })
    this.state = { revision: revision + 1, profileId: id, enabled: false, checkState: 'unchecked' }
    return this.readState()
  }
  setCheck(revision: number, result: 'ready' | 'failed' | 'unsupported') {
    this.expect(revision)
    if (!this.state.profileId) throw new PersonalProfileUnavailableError()
    this.state = { ...this.state, revision: revision + 1, enabled: false, checkState: result }
    return this.readState()
  }
  setEnabled(revision: number, enabled: boolean) {
    this.expect(revision)
    if (enabled && (!this.state.profileId || !['ready', 'unsupported'].includes(this.state.checkState))) throw new PersonalProfileUnavailableError()
    this.state = { ...this.state, revision: revision + 1, enabled }
    return this.readState()
  }
  clear(revision: number) {
    this.expect(revision)
    this.state = { revision: revision + 1, enabled: false, checkState: 'unchecked' }
    return this.readState()
  }
  revokeHistoricSecrets(retainProfileId?: string) {
    if (retainProfileId !== this.state.profileId) throw new PersonalProfileConflictError()
    for (const [profileId, snapshot] of this.snapshots) {
      if (profileId !== retainProfileId) this.snapshots.set(profileId, { ...snapshot, settings: { ...snapshot.settings, apiKey: undefined }, revoked: true })
    }
    return Promise.resolve()
  }
  getRunSnapshot(tenant: string, id: string) {
    const snapshotId = this.bindings.get(`${tenant}:${id}`)
    return Promise.resolve(snapshotId ? this.snapshots.get(snapshotId) : undefined)
  }
  async createRun(tenant: string, run: AnalysisRunV1, event: AnalysisEventV1) {
    const profileId = this.state.profileId
    if (!this.state.enabled || !profileId || run.request.providerProfileId !== profileId) throw new JobStoreConflictError('personal profile changed')
    const result = await this.jobs.createRun(tenant, run, event)
    if (!result.reused) this.bindings.set(`${tenant}:${run.id}`, profileId)
    return result
  }
  async listBoundActiveRuns() {
    const refs: { tenantId: string; runId: string }[] = []
    for (const key of this.bindings.keys()) {
      const separator = key.indexOf(':')
      const ref = { tenantId: key.slice(0, separator), runId: key.slice(separator + 1) }
      const run = await this.jobs.getRun(ref.tenantId, ref.runId)
      if (run && !['partial', 'succeeded', 'cancelled', 'failed', 'expired'].includes(run.status)) refs.push(ref)
    }
    return refs
  }
  async listDispatchableRuns(now: number, limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be positive')
    const activeProfileId = this.state.profileId
    if (!this.healthy || !this.state.enabled || !activeProfileId) return []
    const candidates: { tenantId: string; runId: string }[] = []
    for (const [key, profileId] of this.bindings) {
      if (profileId !== activeProfileId) continue
      const separator = key.indexOf(':')
      const tenantId = key.slice(0, separator)
      const runId = key.slice(separator + 1)
      candidates.push({ tenantId, runId })
    }
    // Mirror the production personal query, including active leases and fair ordering before LIMIT.
    return this.jobs.listDispatchableRuns(now, limit, { profileId: activeProfileId, boundRuns: candidates })
  }
  async listExpiredRuns(now: number, limit: number) {
    return (await this.jobs.listExpiredRuns(now, limit)).filter((ref) => this.bindings.has(`${ref.tenantId}:${ref.runId}`))
  }
  checkHealth() { return Promise.resolve(this.healthy) }
  close() { this.healthy = false; return Promise.resolve() }
  private expect(revision: number) { if (this.state.revision !== revision) throw new PersonalProfileConflictError() }
}

export const createPersonalFixtureFetch = () => {
  const calls: { method: string; modelId?: string }[] = []
  const synthetic = new FakeAnalysisProvider()
  let modelStatus = 200
  let failPost = false
  const fetchImplementation: FetchImplementation = async (_url, init) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      calls.push({ method })
      return new Response(JSON.stringify({ data: [{ id: 'synthetic-model' }, { id: 'synthetic-model-b' }] }),
        { status: modelStatus, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[];
      max_tokens?: number; max_completion_tokens?: number; response_format?: { json_schema?: { name: string; schema: Record<string, unknown> } } }
    calls.push({ method, modelId: body.model })
    if (failPost) throw new TypeError('synthetic_transport_outcome_lost')
    const userPrompt = body.messages.find((message) => message.role === 'user')?.content ?? ''
    const systemPrompt = body.messages.find((message) => message.role === 'system')?.content ?? ''
    const variables = userPrompt.startsWith('Map the following immutable chunk envelope') ? undefined
      : JSON.parse(userPrompt) as { kind?: string; task?: string }
    const role: ModelTaskRole = userPrompt.startsWith('Map the following immutable chunk envelope') ? 'evidence-map'
      : variables?.task ? 'repair' : `artifact-${variables?.kind}` as ModelTaskRole
    const artifactKind = variables?.task ?? variables?.kind
    const supportedArtifactKinds: readonly ArtifactKind[] = ['summary', 'outline', 'mindmap', 'quiz', 'knowledge']
    const inferredOutputName = (role === 'evidence-map' || variables?.task === 'evidence-map')
      ? systemPrompt.includes('excerptId') ? 'evidence_map_v3' : systemPrompt.includes('"quote"') ? 'evidence_map_v2' : 'evidence_map_v1'
      : artifactKind && supportedArtifactKinds.includes(artifactKind as ArtifactKind) && systemPrompt.includes('artifact-source-refs-v1')
        ? `artifact_${artifactKind}_source_refs_v1` : 'synthetic_output'
    const request: ModelRequest = { invocationId: 'synthetic-http-call', role, qualityProfile: 'standard',
      systemPrompt, userPrompt,
      maxOutputTokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
      output: { name: body.response_format?.json_schema?.name
        ?? inferredOutputName,
      schema: body.response_format?.json_schema?.schema ?? {} } }
    const result = await synthetic.generate(request, init?.signal ?? new AbortController().signal)
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: result.outputText } }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens } }), { headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImplementation, setModelStatus: (value: number) => { modelStatus = value }, failNextPost: () => { failPost = true } }
}
