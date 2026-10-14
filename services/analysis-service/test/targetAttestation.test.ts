import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_ATTESTATION_LIFETIME_MS, signReleaseAttestation, verifyReleaseAttestation } from '../src/release/releaseAttestation.js'
import { signTargetCheckpoint, targetReleaseBody, verifyTargetCheckpoint } from '../src/release/targetAttestation.js'
import type { TargetValidationCheckpoint, TargetValidationResult } from '../src/release/targetValidation.js'
import type { CiPrerequisitesBody } from '../src/release/ciPrerequisites.js'
import { targetFixtureBuild as build } from './fixtures/targetValidationFixture.js'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const checkpoint = (): TargetValidationCheckpoint => ({ version: 1, audience: 'cat-analysis-target-checkpoint', build,
  configurationHash: 'c'.repeat(64), executionId: 'd'.repeat(32), validatedAt: 1000,
  tenantId: `target-validation-${'d'.repeat(32)}`, runId: `target-run-${'d'.repeat(32)}`, requestKey: 'e'.repeat(64),
  artifactHashes: { summary: 'f'.repeat(64), outline: 'f'.repeat(64), mindmap: 'f'.repeat(64), quiz: 'f'.repeat(64), knowledge: 'f'.repeat(64) },
  ledger: { usage: { inputTokens: 120, outputTokens: 60, estimatedCostMicros: 1000, currency: 'USD' },
    invocationCount: 6, unresolvedCount: 0, estimatedInputTokens: 120, reservedOutputTokens: 10000 } })
const ci = (): CiPrerequisitesBody => ({ version: 1, audience: 'cat-analysis-ci-prerequisites', build, issuedAt: 900, expiresAt: 2000,
  evidence: { quality: 'passed', postgresRecovery: 'passed', postgresCoverage: 'passed', dependencyAudit: 'passed',
    remotePlatform: 'ubuntu', containerReady: 'passed', browserRecovery: 'passed', workflowExecutionId: '1234/1', reportDigest: 'a'.repeat(64) } })
const validation = (): TargetValidationResult => ({ checkpoint: checkpoint(), completedAt: 1400, cleanup: 'passed' })
const check = (value: unknown, overrides = {}) => verifyTargetCheckpoint({ value, publicKey, build,
  configurationHash: checkpoint().configurationHash, executionId: checkpoint().executionId, now: 1500, ...overrides })

describe('separate purpose target checkpoint signatures', () => {
  it('can recover the exact execution but never authorizes an API release', () => {
    const receipt = signTargetCheckpoint(checkpoint(), keys.privateKey)
    expect(check(receipt)).toEqual(checkpoint())
    expect(verifyReleaseAttestation({ value: receipt, publicKey, build, now: 1500, configurationHash: checkpoint().configurationHash }).ready).toBe(false)
    expect(check(checkpoint())).toBeUndefined()
    expect(() => signTargetCheckpoint(checkpoint(), keys.publicKey)).toThrow('target_signing_key_invalid')
  })
  it('rejects forged or other trusted-key context and stale/future evidence', () => {
    const receipt = signTargetCheckpoint(checkpoint(), keys.privateKey)
    expect(check({ ...receipt, body: { ...checkpoint(), validatedAt: 1100 } })).toBeUndefined()
    expect(check({ ...receipt, signature: 'broken' })).toBeUndefined()
    const other = generateKeyPairSync('ed25519')
    for (const overrides of [{ publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { publicKey: 'invalid' }, { build: { ...build, commit: 'c'.repeat(40) } }, { configurationHash: 'b'.repeat(64) },
      { executionId: 'a'.repeat(32) }, { now: 999 }, { now: NaN }, { now: 1000 + MAX_ATTESTATION_LIFETIME_MS }]) {
      expect(check(receipt, overrides)).toBeUndefined()
    }
  })
  it('refuses incomplete or unknown usage in a checkpoint', () => {
    expect(() => signTargetCheckpoint({ ...checkpoint(), ledger: { ...checkpoint().ledger, unresolvedCount: 1 } } as unknown as TargetValidationCheckpoint, keys.privateKey)).toThrow()
    expect(check({ ...signTargetCheckpoint(checkpoint(), keys.privateKey), extra: 'ignored?' })).toBeUndefined()
  })
})
describe('target release uses unchanged Ed25519 trust and exact configuration', () => {
  it('binds the target build and configuration and expires with the earliest prerequisite', () => {
    const body = targetReleaseBody({ validation: validation(), ci: ci(), now: 1500 })
    expect(body.configurationHash).toBe(checkpoint().configurationHash)
    expect(body.expiresAt).toBe(2000)
    const receipt = signReleaseAttestation(body, keys.privateKey)
    expect(verifyReleaseAttestation({ value: receipt, publicKey, build, now: 1500, configurationHash: body.configurationHash }).ready).toBe(true)
    expect(verifyReleaseAttestation({ value: receipt, publicKey, build, now: 1500, configurationHash: '1'.repeat(64) })).toEqual({ ready: false, reason: 'configuration_mismatch' })
  })
  it('cannot prolong an old live checkpoint by renewing CI evidence', () => {
    const now = 1500
    const renewed = { ...ci(), expiresAt: now + MAX_ATTESTATION_LIFETIME_MS, issuedAt: now }
    expect(targetReleaseBody({ validation: validation(), ci: renewed, now }).expiresAt).toBe(1000 + MAX_ATTESTATION_LIFETIME_MS)
  })
  it('does not issue successful release evidence for uncompleted, skipped, stale or mismatched checks', () => {
    for (const value of [{ ...validation(), cleanup: 'pending' }, { ...validation(), completedAt: 999 },
      { ...validation(), completedAt: 1600 }, { ...validation(), completedAt: NaN }]) {
      expect(() => targetReleaseBody({ validation: value as TargetValidationResult, ci: ci(), now: 1500 })).toThrow('evidence_invalid')
    }
    for (const change of [{ issuedAt: 1600 }, { expiresAt: 1500 }, { build: { ...build, commit: 'e'.repeat(40) } }]) {
      expect(() => targetReleaseBody({ validation: validation(), ci: { ...ci(), ...change }, now: 1500 })).toThrow('evidence_invalid')
    }
    expect(() => targetReleaseBody({ validation: validation(), ci: ci(), now: NaN })).toThrow()
  })
})
