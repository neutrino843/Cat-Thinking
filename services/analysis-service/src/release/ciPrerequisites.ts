import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import { buildIdentitySchema, type BuildIdentity } from './buildIdentity.js'
import { MAX_ATTESTATION_LIFETIME_MS, publicKeyId } from './releaseAttestation.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const ciPrerequisitesBodySchema = z.object({
  version: z.literal(1), audience: z.literal('cat-analysis-ci-prerequisites'),
  build: buildIdentitySchema,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  evidence: z.object({
    quality: z.literal('passed'), postgresRecovery: z.literal('passed'),
    postgresCoverage: z.literal('passed'), dependencyAudit: z.literal('passed'),
    remotePlatform: z.literal('ubuntu'), containerReady: z.literal('passed'), browserRecovery: z.literal('passed'),
    workflowExecutionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u),
    reportDigest: digest,
  }).strict(),
}).strict().refine((body) => body.expiresAt > body.issuedAt
  && body.expiresAt - body.issuedAt <= MAX_ATTESTATION_LIFETIME_MS)
export type CiPrerequisitesBody = z.infer<typeof ciPrerequisitesBodySchema>
export const ciPrerequisitesAttestationSchema = z.object({
  body: ciPrerequisitesBodySchema, keyId: digest,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict()
export type CiPrerequisitesAttestation = z.infer<typeof ciPrerequisitesAttestationSchema>

// The trusted CI signer owns the truth of these reports. Local fake test results
// cannot create this receipt; this audience is never accepted by ReleaseGate.
export const signCiPrerequisites = (body: CiPrerequisitesBody, privateKey: KeyObject): CiPrerequisitesAttestation => {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('ci_signing_key_invalid')
  const parsed = ciPrerequisitesBodySchema.parse(body)
  return { body: parsed, keyId: publicKeyId(createPublicKey(privateKey)),
    signature: sign(null, Buffer.from(canonicalizeJson(parsed)), privateKey).toString('base64') }
}

export type CiPrerequisitesDecision = Readonly<{ ready: true; body: CiPrerequisitesBody }> | Readonly<{
  ready: false; reason: 'invalid' | 'untrusted_key' | 'not_yet_valid' | 'expired' | 'build_mismatch'
}>
export const verifyCiPrerequisites = (input: {
  readonly value: unknown; readonly publicKey: string; readonly build: BuildIdentity; readonly now: number
}): CiPrerequisitesDecision => {
  try {
    const receipt = ciPrerequisitesAttestationSchema.parse(input.value)
    const key = createPublicKey(input.publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || receipt.keyId !== publicKeyId(key)) return { ready: false, reason: 'untrusted_key' }
    if (!verify(null, Buffer.from(canonicalizeJson(receipt.body)), key, Buffer.from(receipt.signature, 'base64'))) return { ready: false, reason: 'invalid' }
    if (!Number.isSafeInteger(input.now) || receipt.body.issuedAt > input.now) return { ready: false, reason: 'not_yet_valid' }
    if (receipt.body.expiresAt <= input.now) return { ready: false, reason: 'expired' }
    if (canonicalizeJson(receipt.body.build) !== canonicalizeJson(input.build)) return { ready: false, reason: 'build_mismatch' }
    return { ready: true, body: receipt.body }
  } catch { return { ready: false, reason: 'invalid' } }
}
