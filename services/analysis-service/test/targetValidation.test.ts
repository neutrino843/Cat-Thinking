import { describe, expect, it, vi } from 'vitest'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { RunService } from '../src/domain/runService.js'
import { ProviderGatewayError } from '../src/providers/providerError.js'
import { configurationHash, MAX_ATTESTATION_LIFETIME_MS } from '../src/release/releaseAttestation.js'
import { assertTargetValidationConfiguration, targetValidationScope, validateTargetDeployment,
  type TargetValidationCheckpoint } from '../src/release/targetValidation.js'
import { createTargetValidationStore } from '../src/release/targetValidationStore.js'
import { prepareFixtureRun, FIXTURE_TENANT } from './fixtures/fakeAnalysisProvider.js'
import { targetFixture, targetFixtureBudget, targetFixtureConfig } from './fixtures/targetValidationFixture.js'

describe('non-destructive target validation using injected fake Provider', () => {
  it('validates all five, restarts without replay and clears only its own content', async () => {
    const { store, provider, options } = targetFixture()
    const existing = await prepareFixtureRun(store, 'unrelated-user-content')
    const before = canonicalizeJson(await store.getRun(FIXTURE_TENANT, existing.runId))
    const cleanupExpired = vi.spyOn(store, 'listExpiredRuns')
    const discovery = vi.spyOn(store, 'listDispatchableRuns')
    const close = vi.spyOn(store, 'close')
    const reserve = vi.spyOn(store, 'reserveProviderInvocation')
    const saveCheckpoint = vi.fn()
    const result = await validateTargetDeployment({ ...options, budget: { ...options.budget, maxEstimatedCostMicros: 999 }, saveCheckpoint })
    expect(result.cleanup).toBe('passed')
    expect(provider.calls).toHaveLength(6)
    expect(result.checkpoint.ledger.invocationCount).toBe(6)
    expect(result.checkpoint.artifactHashes).toEqual(expect.objectContaining({ summary: expect.stringMatching(/^[a-f0-9]{64}$/u) }))
    expect(saveCheckpoint).toHaveBeenCalledOnce()
    expect(cleanupExpired).not.toHaveBeenCalled(); expect(discovery).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(3)
    expect(reserve.mock.calls.every(([input]) => input.maxRunEstimatedCostMicros === 999)).toBe(true)
    expect(canonicalizeJson(await store.getRun(FIXTURE_TENANT, existing.runId))).toBe(before)
    expect(await store.getSourceContent(FIXTURE_TENANT, existing.runId, 'synthetic-source')).toBeDefined()
    expect(await store.listArtifactDescriptors(result.checkpoint.tenantId, result.checkpoint.runId)).toEqual([])
    expect(await store.getRunLedgerUsage(result.checkpoint.tenantId, result.checkpoint.runId)).toEqual(result.checkpoint.ledger)
    expect(options.config.release.hold).toBe(true)
  })
  it('uses a signed checkpoint after cleanup interruption and repeats with zero new transport', async () => {
    const { store, provider, options } = targetFixture('d'.repeat(32))
    let checkpoint: TargetValidationCheckpoint | undefined
    let connections = 0
    await expect(validateTargetDeployment({ ...options, saveCheckpoint: async (value) => { checkpoint = value },
      connect: async () => { connections += 1; if (connections === 3) throw new Error('synthetic connection interruption'); return store } })).rejects.toThrow('synthetic connection interruption')
    expect(checkpoint).toBeDefined(); expect(provider.calls).toHaveLength(6)
    const result = await validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint })
    expect(result.checkpoint).toEqual(checkpoint)
    expect(result.cleanup).toBe('passed'); expect(provider.calls).toHaveLength(6)
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'checkpoint_required' })
    expect(provider.calls).toHaveLength(6)
  })
  it('resumes a committed checkpoint before cleanup and refuses mismatched/expired checkpoints', async () => {
    const { provider, options } = targetFixture('e'.repeat(32))
    let checkpoint: TargetValidationCheckpoint | undefined
    await expect(validateTargetDeployment({ ...options, saveCheckpoint: async (value) => { checkpoint = value; throw new Error('synthetic writer interrupted') } })).rejects.toThrow('synthetic writer interrupted')
    const result = await validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint })
    expect(result.cleanup).toBe('passed'); expect(provider.calls).toHaveLength(6)
    for (const change of [{ executionId: 'f'.repeat(32) }, { configurationHash: 'f'.repeat(64) },
      { build: { ...options.build, commit: 'f'.repeat(40) } }, { tenantId: `target-validation-${'f'.repeat(32)}` },
      { runId: `target-run-${'f'.repeat(32)}` }, { requestKey: 'f'.repeat(64) }, { validatedAt: Date.now() + 10000 }, { validatedAt: 1 }]) {
      await expect(validateTargetDeployment({ ...options, resumeCheckpoint: { ...checkpoint!, ...change } })).rejects.toMatchObject({ code: 'checkpoint_invalid' })
    }
    await expect(validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint, now: () => checkpoint!.validatedAt + MAX_ATTESTATION_LIFETIME_MS })).rejects.toMatchObject({ code: 'checkpoint_invalid' })
  })
  it('does not retry an ambiguous accepted request, including another validation of the same nonce', async () => {
    const { store, provider, options } = targetFixture('f'.repeat(32))
    provider.override = () => { throw new ProviderGatewayError({ providerId: provider.id, kind: 'unavailable', retryable: true,
      safeCode: 'synthetic.response_lost', acceptance: 'unknown' }) }
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'incomplete' })
    const scope = targetValidationScope(options.executionId, configurationHash(options.config), options.build)
    expect(await store.getRunLedgerUsage(scope.tenantId, scope.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 1 })
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'incomplete' })
    expect(provider.calls).toHaveLength(1)
  })
  it('resumes a receiving request without changing its durable identity', async () => {
    const { store, provider, options } = targetFixture('1'.repeat(32))
    const scope = targetValidationScope(options.executionId, configurationHash(options.config), options.build)
    await new RunService({ store, retentionSeconds: 3600, createId: (() => { let first = true; return () => { if (first) { first = false; return scope.runId }; return 'synthetic-accepted-event' } })() }).createRun(scope.tenantId, scope.request)
    const result = await validateTargetDeployment(options)
    expect(result.checkpoint.runId).toBe(scope.runId); expect(provider.calls).toHaveLength(6)
  })
  it('fails before connection when prerequisites, readiness, identity or authorization are absent', async () => {
    const { provider, options } = targetFixture()
    const connect = vi.fn(options.connect)
    for (const change of [{ canExecute: async () => false }, { signal: AbortSignal.abort() },
      { config: { ...options.config, release: { hold: false } } }, { budget: { ...options.budget, maxEstimatedTokens: 0 } }]) {
      await expect(validateTargetDeployment({ ...options, connect, ...change })).rejects.toThrow()
    }
    const isReady = vi.spyOn(provider, 'isReady').mockReturnValue(false)
    await expect(validateTargetDeployment({ ...options, connect })).rejects.toMatchObject({ code: 'not_ready' }); isReady.mockRestore()
    await expect(validateTargetDeployment({ ...options, connect, provider: { ...provider, id: 'wrong', isReady: () => true, generate: provider.generate.bind(provider) } })).rejects.toMatchObject({ code: 'configuration_invalid' })
    expect(connect).not.toHaveBeenCalled(); expect(provider.calls).toHaveLength(0)
  })
  it('honors lower deployment budgets without ever raising them', async () => {
    const { provider, options } = targetFixture('2'.repeat(32))
    const config = options.config
    if (config.provider.mode !== 'openai-compatible') throw new Error('fixture missing')
    await expect(validateTargetDeployment({ ...options, config: { ...config, provider: { ...config.provider,
      invocationPolicy: { ...config.provider.invocationPolicy, maxRunEstimatedCostMicros: 1 } } } })).rejects.toMatchObject({ code: 'incomplete' })
    expect(provider.calls).toHaveLength(0)
  })
  it('rejects durable nonce collisions or previously abandoned identities without transport', async () => {
    for (const mode of ['foreign-request', 'abandoned']) {
      const { store, provider, options } = targetFixture('3'.repeat(32))
      const scope = targetValidationScope(options.executionId, configurationHash(options.config), options.build)
      if (mode === 'foreign-request') await new RunService({ store, retentionSeconds: 3600, createId: () => scope.runId }).createRun(scope.tenantId, { ...scope.request, docId: 'foreign-document' })
      else await store.abandonRequest(scope.tenantId, scope.request.requestKey, Date.now())
      await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'scope_mismatch' })
      expect(provider.calls).toHaveLength(0)
    }
  })
  it('fences every exposed store operation and prohibits global or future methods', async () => {
    const { store, options } = targetFixture()
    const scope = targetValidationScope(options.executionId, configurationHash(options.config), options.build)
    const scoped = createTargetValidationStore(store, scope, options.budget)
    expect(() => scoped.getRun('business-tenant', scope.runId)).toThrow('scope_violation')
    expect(() => scoped.getRun(scope.tenantId, 'business-run')).toThrow('scope_violation')
    expect(() => scoped.acquireLease({ tenantId: 'business-tenant', runId: scope.runId, ownerId: 'x', nodeKey: 'x', durationMs: 1000, now: 1 })).toThrow('scope_violation')
    expect(() => scoped.lookupRunByRequestKey(scope.tenantId, 'other-key')).toThrow('scope_violation')
    expect(() => scoped.getCachedEvidenceCard('business-tenant', 'hash', 1)).toThrow('scope_violation')
    expect(() => scoped.cleanupExpiredRun).toThrow('scope_violation'); expect(() => scoped.close).toThrow('scope_violation')
    expect(await scoped.listExpiredRuns(1, 10)).toEqual([])
    expect(await scoped.listDispatchableRuns(1, 0)).toEqual([])
    expect(await scoped.getCachedEvidenceCard(scope.tenantId, 'absent', 1)).toBeUndefined()
    expect(await scoped.getProviderInvocation(scope.tenantId, 'absent')).toBeUndefined()
    expect(await scoped.completeProviderInvocation({ tenantId: scope.tenantId, invocationId: 'absent', transportAttempts: 0, now: 1,
      result: 'outcome_unknown', safeCode: 'synthetic.interrupted' })).toEqual({ outcome: 'missing' })
  })
  it('rejects unhealthy stores and interruption during dispatcher work without losing reservations', async () => {
    const { store, options } = targetFixture()
    vi.spyOn(store, 'checkHealth').mockResolvedValue(false)
    await expect(validateTargetDeployment(options)).rejects.toMatchObject({ code: 'not_ready' })
    const second = targetFixture('4'.repeat(32))
    const controller = new AbortController()
    second.provider.override = (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      controller.abort()
    })
    await expect(validateTargetDeployment({ ...second.options, signal: controller.signal })).rejects.toMatchObject({ code: 'interrupted' })
    const scope = targetValidationScope(second.options.executionId, configurationHash(second.options.config), second.options.build)
    expect(await second.store.getRunLedgerUsage(scope.tenantId, scope.runId)).toMatchObject({ invocationCount: 1, unresolvedCount: 1 })
  })
  it('rejects reusing one nonce under a different build before paying for a new request', async () => {
    const { provider, options } = targetFixture('5'.repeat(32))
    await validateTargetDeployment(options)
    await expect(validateTargetDeployment({ ...options, build: { ...options.build, artifactDigest: '6'.repeat(64) } })).rejects.toMatchObject({ code: 'scope_mismatch' })
    expect(provider.calls).toHaveLength(6)
  })
  it('does not attest an unresolved aggregate even when committed artifacts succeeded', async () => {
    const { store, provider, options } = targetFixture('6'.repeat(32))
    const query = store.getRunLedgerUsage.bind(store)
    const aggregate = vi.spyOn(store, 'getRunLedgerUsage').mockImplementation(async (tenant, run) => {
      const ledger = await query(tenant, run)
      return ledger ? { ...ledger, unresolvedCount: 1 } : undefined
    })
    const checkpoint = vi.fn()
    await expect(validateTargetDeployment({ ...options, saveCheckpoint: checkpoint })).rejects.toMatchObject({ code: 'usage_unresolved' })
    expect(provider.calls).toHaveLength(6); expect(checkpoint).not.toHaveBeenCalled()
    aggregate.mockRestore()
    await validateTargetDeployment(options)
    expect(provider.calls).toHaveLength(6)
  })
  it('keeps the signed write-ahead checkpoint when cleanup fails and finishes without transport replay', async () => {
    const { store, provider, options } = targetFixture('7'.repeat(32))
    const deletion = vi.spyOn(store, 'deleteContent').mockResolvedValue(true)
    let checkpoint: TargetValidationCheckpoint | undefined
    await expect(validateTargetDeployment({ ...options, saveCheckpoint: async (value) => { checkpoint = value } })).rejects.toMatchObject({ code: 'cleanup_failed' })
    deletion.mockRestore()
    const completed = await validateTargetDeployment({ ...options, resumeCheckpoint: checkpoint })
    expect(completed.cleanup).toBe('passed'); expect(provider.calls).toHaveLength(6)
  })
  it('rejects a recovered descriptor mismatch before checkpoint publication', async () => {
    const { store, provider, options } = targetFixture('8'.repeat(32))
    let connections = 0
    const original = store.listArtifactDescriptors.bind(store)
    await expect(validateTargetDeployment({ ...options, connect: async () => {
      connections += 1
      if (connections === 2) vi.spyOn(store, 'listArtifactDescriptors').mockImplementation(async (tenant, run) =>
        (await original(tenant, run))?.map((descriptor) => ({ ...descriptor, artifactHash: '0'.repeat(64) })))
      return store
    } })).rejects.toMatchObject({ code: 'recovery_mismatch' })
    expect(provider.calls).toHaveLength(6)
  })
})

describe('protected target budget and unchanged deployment policy', () => {
  it('rejects disabled stores/providers, unset prices, transport retries and unbounded or invalid explicit budgets', () => {
    const config = targetFixtureConfig()
    if (config.provider.mode !== 'openai-compatible') throw new Error('fixture missing')
    for (const change of [{ jobStore: { mode: 'disabled' as const } }, { provider: { mode: 'disabled' as const } },
      { provider: { ...config.provider, inputMicrosPerMillionTokens: 0 } },
      { provider: { ...config.provider, outputMicrosPerMillionTokens: 0 } },
      { provider: { ...config.provider, invocationPolicy: { ...config.provider.invocationPolicy, maxAttempts: 2 } } }]) {
      expect(() => assertTargetValidationConfiguration({ ...config, ...change }, targetFixtureBudget)).toThrow('configuration_invalid')
    }
    for (const change of [{ maxEstimatedTokens: 200001 }, { maxEstimatedTokens: NaN }, { maxEstimatedCostMicros: 1000001 },
      { maxEstimatedCostMicros: 0 }, { maxEstimatedCostMicros: 0.5 }, { timeoutMs: 120001 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
      expect(() => assertTargetValidationConfiguration(config, { ...targetFixtureBudget, ...change })).toThrow('configuration_invalid')
    }
    expect(() => targetValidationScope('bad', 'c'.repeat(64), targetFixture().options.build)).toThrow()
    expect(() => targetValidationScope('c'.repeat(32), 'bad', targetFixture().options.build)).toThrow()
  })
})
