import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalizeJson } from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import type { BuildIdentity } from './buildIdentity.js'
import { ciPrerequisitesBodySchema, type CiPrerequisitesBody } from './ciPrerequisites.js'
import { MAX_ATTESTATION_LIFETIME_MS, RELEASE_PROMPT_VERSIONS, RELEASE_SCHEMA_VERSION,
  publicKeyId, releaseBodySchema, type ReleaseBody } from './releaseAttestation.js'
import { targetValidationCheckpointSchema, type TargetValidationCheckpoint, type TargetValidationResult } from './targetValidation.js'

export const signedTargetCheckpointSchema = z.object({ body: targetValidationCheckpointSchema,
  keyId: z.string().regex(/^[a-f0-9]{64}$/u), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u) }).strict()
export const signTargetCheckpoint = (checkpoint: TargetValidationCheckpoint, privateKey: KeyObject): z.infer<typeof signedTargetCheckpointSchema> => {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('target_signing_key_invalid')
  const body = targetValidationCheckpointSchema.parse(checkpoint)
  return { body, keyId: publicKeyId(createPublicKey(privateKey)),
    signature: sign(null, Buffer.from(canonicalizeJson(body)), privateKey).toString('base64') }
}
export const verifyTargetCheckpoint = (input: { readonly value: unknown; readonly publicKey: string;
  readonly build: BuildIdentity; readonly configurationHash: string; readonly executionId: string; readonly now: number }): TargetValidationCheckpoint | undefined => {
  try {
    const receipt = signedTargetCheckpointSchema.parse(input.value)
    const key = createPublicKey(input.publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || receipt.keyId !== publicKeyId(key)
      || !verify(null, Buffer.from(canonicalizeJson(receipt.body)), key, Buffer.from(receipt.signature, 'base64'))
      || canonicalizeJson(receipt.body.build) !== canonicalizeJson(input.build)
      || receipt.body.configurationHash !== input.configurationHash || receipt.body.executionId !== input.executionId
      || !Number.isSafeInteger(input.now) || receipt.body.validatedAt > input.now
      || receipt.body.validatedAt + MAX_ATTESTATION_LIFETIME_MS <= input.now) return undefined
    return receipt.body
  } catch { return undefined }
}

/** Called only by the real configured-Provider runner after every cleanup check. */
export const targetReleaseBody = (input: { readonly validation: TargetValidationResult;
  readonly ci: CiPrerequisitesBody; readonly now: number }): ReleaseBody => {
  const checkpoint = targetValidationCheckpointSchema.parse(input.validation.checkpoint)
  const ci = ciPrerequisitesBodySchema.parse(input.ci)
  if (input.validation.cleanup !== 'passed' || !Number.isSafeInteger(input.validation.completedAt)
    || input.validation.completedAt < checkpoint.validatedAt || input.validation.completedAt > input.now
    || ci.issuedAt > input.now || ci.expiresAt <= input.now
    || canonicalizeJson(ci.build) !== canonicalizeJson(checkpoint.build)) throw new Error('target_release_evidence_invalid')
  return releaseBodySchema.parse({ version: 1, audience: 'cat-analysis-engine', build: checkpoint.build,
    configurationHash: checkpoint.configurationHash, schemaVersion: RELEASE_SCHEMA_VERSION,
    promptVersions: RELEASE_PROMPT_VERSIONS, issuedAt: input.now,
    expiresAt: Math.min(input.now + MAX_ATTESTATION_LIFETIME_MS, ci.expiresAt, checkpoint.validatedAt + MAX_ATTESTATION_LIFETIME_MS),
    evidence: { quality: ci.evidence.quality, postgresRecovery: ci.evidence.postgresRecovery,
      postgresCoverage: ci.evidence.postgresCoverage, liveProvider: 'passed', executionId: checkpoint.executionId } })
}
