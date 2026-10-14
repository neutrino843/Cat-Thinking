import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { loadAnalysisServiceConfig } from '../src/config.js'
import { ReleaseGate } from '../src/release/releaseGate.js'
import { configurationHash, MAX_ATTESTATION_LIFETIME_MS, RELEASE_PROMPT_VERSIONS, RELEASE_SCHEMA_VERSION, signReleaseAttestation, verifyReleaseAttestation, type ReleaseBody } from '../src/release/releaseAttestation.js'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const build = { serviceVersion: '0.1.0', commit: 'a'.repeat(40), artifactDigest: 'b'.repeat(64) }
const config = loadAnalysisServiceConfig({ ANALYSIS_RELEASE_HOLD: 'false', ANALYSIS_RELEASE_ATTESTATION_PATH: 'receipt', ANALYSIS_RELEASE_PUBLIC_KEY_PATH: 'public' })
const body = (): ReleaseBody => ({ version: 1, audience: 'cat-analysis-engine', build, configurationHash: configurationHash(config), schemaVersion: RELEASE_SCHEMA_VERSION, promptVersions: { ...RELEASE_PROMPT_VERSIONS }, issuedAt: 1000, expiresAt: 2000, evidence: { quality: 'passed', postgresRecovery: 'passed', postgresCoverage: 'passed', liveProvider: 'passed', executionId: 'c'.repeat(32) } })
const check = (value: unknown, overrides = {}) => verifyReleaseAttestation({ value, publicKey, build, configurationHash: configurationHash(config), now: 1500, ...overrides })

describe('version bound release signatures', () => {
  it('binds the Knowledge grounding and independent repair policies and rejects older evidence', () => {
    expect(RELEASE_PROMPT_VERSIONS).toEqual({
      'evidence.map': 'evidence-source-ref-v4', 'evidence.repair': 'evidence-repair-v2', 'structured.repair': 'artifact-ref-repair-v3',
      'artifact.summary': 'summary-grounded-refs-v2', 'artifact.outline': 'outline-grounded-hierarchy-refs-v3',
      'artifact.mindmap': 'mindmap-outline-hierarchy-refs-v3', 'artifact.quiz': 'quiz-grounded-refs-v2',
      'artifact.knowledge': 'knowledge-grounded-refs-v3',
    })
    const oldPolicies = { ...RELEASE_PROMPT_VERSIONS, 'artifact.knowledge': 'artifact-v1' }
    expect(check(signReleaseAttestation({ ...body(), promptVersions: oldPolicies }, keys.privateKey)))
      .toEqual({ ready: false, reason: 'build_mismatch' })
  })
  it('admits only verified current evidence within its validity interval', () => {
    const receipt = signReleaseAttestation(body(), keys.privateKey)
    expect(check(receipt)).toEqual({ ready: true, expiresAt: 2000 })
    expect(check(receipt, { now: 2000 })).toEqual({ ready: false, reason: 'expired' })
    expect(check(receipt, { now: 999 })).toEqual({ ready: false, reason: 'not_yet_valid' })
    expect(check(receipt, { now: NaN })).toEqual({ ready: false, reason: 'not_yet_valid' })
  })
  it('rejects tampering, malformed signatures and untrusted keys', () => {
    const receipt = signReleaseAttestation(body(), keys.privateKey)
    expect(check({ ...receipt, body: { ...receipt.body, expiresAt: 2100 } })).toEqual({ ready: false, reason: 'invalid' })
    expect(check({ ...receipt, signature: 'bad' }).ready).toBe(false)
    const other = generateKeyPairSync('ed25519')
    expect(check(receipt, { publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toEqual({ ready: false, reason: 'untrusted_key' })
    expect(check(receipt, { publicKey: 'invalid' }).ready).toBe(false)
    expect(check({ ...receipt, extra: true }).ready).toBe(false)
    expect(() => signReleaseAttestation(body(), keys.publicKey)).toThrow('release_signing_key_invalid')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => signReleaseAttestation(body(), rsa.privateKey)).toThrow('release_signing_key_invalid')
    expect(check(receipt, { publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }).ready).toBe(false)
  })
  it('rejects evidence for other builds, prompts or configuration', () => {
    const receipt = signReleaseAttestation(body(), keys.privateKey)
    for (const change of [{ commit: 'd'.repeat(40) }, { artifactDigest: 'e'.repeat(64) }, { serviceVersion: 'new' }]) {
      expect(check(receipt, { build: { ...build, ...change } })).toEqual({ ready: false, reason: 'build_mismatch' })
    }
    expect(check(signReleaseAttestation({ ...body(), promptVersions: { 'artifact.summary': 'old' } }, keys.privateKey))).toEqual({ ready: false, reason: 'build_mismatch' })
    expect(check(receipt, { configurationHash: 'd'.repeat(64) })).toEqual({ ready: false, reason: 'configuration_mismatch' })
  })
  it('bounds lifetime and requires every successful prerequisite', () => {
    for (const expiresAt of [1000, 999, 1001 + MAX_ATTESTATION_LIFETIME_MS]) {
      expect(() => signReleaseAttestation({ ...body(), expiresAt }, keys.privateKey)).toThrow()
    }
    for (const field of ['quality', 'postgresRecovery', 'postgresCoverage', 'liveProvider']) {
      expect(check({ body: { ...body(), evidence: { ...body().evidence, [field]: 'skipped' } } }).ready).toBe(false)
    }
  })
  it('binds sensitive configuration through an opaque digest and excludes deployment paths', () => {
    expect(configurationHash(config)).toMatch(/^[a-f0-9]{64}$/u)
    expect(configurationHash({ ...config, leaseMs: config.leaseMs + 1 })).not.toBe(configurationHash(config))
    expect(configurationHash({ ...config, bodyLimitBytes: config.bodyLimitBytes + 1 })).not.toBe(configurationHash(config))
    expect(configurationHash({ ...config, trustProxyHops: config.trustProxyHops + 1 })).not.toBe(configurationHash(config))
    expect(configurationHash({ ...config, release: { hold: true } })).toBe(configurationHash(config))
    expect(configurationHash({ ...config, corsOrigins: ['https://b.test', 'https://a.test'] })).toBe(configurationHash({ ...config, corsOrigins: ['https://a.test', 'https://b.test'] }))
    const deployment = loadAnalysisServiceConfig({ ANALYSIS_PROVIDER_MODE: 'openai-compatible', ANALYSIS_PROVIDER_ID: 'synthetic', ANALYSIS_PROVIDER_BASE_URL: 'https://models.test/v1', ANALYSIS_PROVIDER_ALLOWED_HOSTS: 'models.test', ANALYSIS_PROVIDER_API_KEY: 'synthetic-secret-not-a-real-key', ANALYSIS_PROVIDER_MODEL_ID: 'synthetic-model', ANALYSIS_PROVIDER_PROFILE_VERSION: 'synthetic-profile' })
    expect(deployment.provider.mode).toBe('openai-compatible')
    if (deployment.provider.mode !== 'openai-compatible') throw new Error('fixture provider missing')
    for (const changes of [{ apiKey: 'changed-synthetic-secret' }, { modelId: 'new-model' }, { inputMicrosPerMillionTokens: 1 }, { invocationPolicy: { ...deployment.provider.invocationPolicy, maxAttempts: 1 } }]) {
      expect(configurationHash({ ...deployment, provider: { ...deployment.provider, ...changes } })).not.toBe(configurationHash(deployment))
    }
    expect(configurationHash(deployment)).not.toContain('synthetic-secret')
  })
})

describe('reloading release gate', () => {
  it('defaults to a hold and cannot be bypassed by a boolean alone', async () => {
    const read = vi.fn()
    expect(await new ReleaseGate({ config: loadAnalysisServiceConfig({}), build, read }).status()).toEqual({ ready: false, reason: 'held' })
    expect(read).not.toHaveBeenCalled()
    for (const options of [{ config }, { config: { ...config, release: { hold: false } }, build }, { config, build: { ...build, serviceVersion: 'wrong' } }]) {
      expect(await new ReleaseGate(options).status()).toEqual({ ready: false, reason: 'not_configured' })
    }
  })
  it('revokes expired, removed, replaced or unreadable proofs without restart', async () => {
    let now = 1500
    let receipt = JSON.stringify(signReleaseAttestation(body(), keys.privateKey))
    const read = vi.fn(async (path: string) => path === 'public' ? publicKey : receipt)
    const gate = new ReleaseGate({ config, build, read, now: () => now })
    expect((await gate.status()).ready).toBe(true)
    now = 2000
    expect(await gate.status()).toEqual({ ready: false, reason: 'expired' })
    now = 1500
    receipt = '{}'
    expect((await gate.status()).ready).toBe(false)
    receipt = 'broken json'
    expect((await gate.status()).ready).toBe(false)
    read.mockRejectedValueOnce(new Error('missing'))
    expect((await gate.status()).ready).toBe(false)
    receipt = JSON.stringify(signReleaseAttestation(body(), keys.privateKey))
    expect((await gate.status()).ready).toBe(true)
  })
})
