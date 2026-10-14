import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signCiPrerequisites, verifyCiPrerequisites, type CiPrerequisitesBody } from '../src/release/ciPrerequisites.js'
import { MAX_ATTESTATION_LIFETIME_MS, verifyReleaseAttestation } from '../src/release/releaseAttestation.js'
import { targetFixtureBuild as build } from './fixtures/targetValidationFixture.js'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const body = (): CiPrerequisitesBody => ({ version: 1, audience: 'cat-analysis-ci-prerequisites', build,
  issuedAt: 1000, expiresAt: 2000, evidence: { quality: 'passed', postgresRecovery: 'passed', postgresCoverage: 'passed',
    dependencyAudit: 'passed', remotePlatform: 'ubuntu', containerReady: 'passed', browserRecovery: 'passed',
    workflowExecutionId: '123456/attempt-1', reportDigest: 'd'.repeat(64) } })
const check = (value: unknown, overrides = {}) => verifyCiPrerequisites({ value, publicKey, build, now: 1500, ...overrides })

describe('trusted remote CI prerequisite evidence', () => {
  it('accepts only signed current build evidence and cannot authorize release', () => {
    const receipt = signCiPrerequisites(body(), keys.privateKey)
    expect(check(receipt)).toEqual({ ready: true, body: body() })
    expect(verifyReleaseAttestation({ value: receipt, publicKey, build, now: 1500, configurationHash: 'e'.repeat(64) }).ready).toBe(false)
    expect(check(body())).toEqual({ ready: false, reason: 'invalid' })
  })
  it('rejects skipped, local, unsigned or incomplete security evidence', () => {
    for (const change of [{ quality: 'skipped' }, { postgresRecovery: 'skipped' }, { postgresCoverage: 'skipped' },
      { dependencyAudit: 'skipped' }, { remotePlatform: 'windows' }, { containerReady: 'skipped' },
      { browserRecovery: 'skipped' }, { reportDigest: '' }, { workflowExecutionId: 'raw secret\n' }]) {
      expect(() => signCiPrerequisites({ ...body(), evidence: { ...body().evidence, ...change } } as CiPrerequisitesBody, keys.privateKey)).toThrow()
    }
    expect(check({ ...signCiPrerequisites(body(), keys.privateKey), extra: 'ignored?' }).ready).toBe(false)
  })
  it('rejects tampered signatures and another trust root', () => {
    const receipt = signCiPrerequisites(body(), keys.privateKey)
    expect(check({ ...receipt, body: { ...body(), expiresAt: 2100 } })).toEqual({ ready: false, reason: 'invalid' })
    expect(check({ ...receipt, signature: 'bad' }).ready).toBe(false)
    const other = generateKeyPairSync('ed25519')
    expect(check(receipt, { publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toEqual({ ready: false, reason: 'untrusted_key' })
    expect(check(receipt, { publicKey: 'broken' })).toEqual({ ready: false, reason: 'invalid' })
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(check(receipt, { publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toEqual({ ready: false, reason: 'untrusted_key' })
  })
  it('revokes future, expired and mismatched builds and bounds the lifetime', () => {
    const receipt = signCiPrerequisites(body(), keys.privateKey)
    for (const now of [999, NaN, 1.5]) expect(check(receipt, { now })).toEqual({ ready: false, reason: 'not_yet_valid' })
    expect(check(receipt, { now: 2000 })).toEqual({ ready: false, reason: 'expired' })
    expect(check(receipt, { build: { ...build, commit: 'f'.repeat(40) } })).toEqual({ ready: false, reason: 'build_mismatch' })
    for (const expiresAt of [1000, 999, 1001 + MAX_ATTESTATION_LIFETIME_MS]) expect(() => signCiPrerequisites({ ...body(), expiresAt }, keys.privateKey)).toThrow()
    expect(() => signCiPrerequisites(body(), keys.publicKey)).toThrow('ci_signing_key_invalid')
  })
})
