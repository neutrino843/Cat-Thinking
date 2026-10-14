import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalizeJson, ARTIFACT_KINDS } from '@cat-thinking/analysis-contracts'
import { z } from 'zod'
import type { AnalysisServiceConfig } from '../config.js'
import { buildIdentitySchema, type BuildIdentity } from './buildIdentity.js'
import { ANALYSIS_SCHEMA_VERSION } from '../infrastructure/postgres/migrations.js'
import { ARTIFACT_SOURCE_REFERENCE_VERSIONS, ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION } from '../domain/artifactPolicyVersions.js'
import { EVIDENCE_ARTIFACT_REF_PROMPT_VERSION } from '../providers/evidenceMapPrompt.js'
import { EVIDENCE_REPAIR_PROMPT_ID, EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION } from '../providers/evidenceRepairPrompt.js'

export const MAX_ATTESTATION_LIFETIME_MS = 24 * 60 * 60_000
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const RELEASE_PROMPT_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'evidence.map': EVIDENCE_ARTIFACT_REF_PROMPT_VERSION, 'structured.repair': ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION,
  [EVIDENCE_REPAIR_PROMPT_ID]: EVIDENCE_SOURCE_REF_REPAIR_PROMPT_VERSION,
  ...Object.fromEntries(ARTIFACT_KINDS.map((kind) => [`artifact.${kind}`, ARTIFACT_SOURCE_REFERENCE_VERSIONS[kind]])),
})
export const RELEASE_SCHEMA_VERSION = ANALYSIS_SCHEMA_VERSION
export const releaseBodySchema = z.object({
  version: z.literal(1), audience: z.literal('cat-analysis-engine'),
  build: buildIdentitySchema, configurationHash: digest,
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  promptVersions: z.record(z.string().max(80), z.string().min(1).max(80)),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  evidence: z.object({ quality: z.literal('passed'), postgresRecovery: z.literal('passed'),
    postgresCoverage: z.literal('passed'), liveProvider: z.literal('passed'),
    executionId: z.string().regex(/^[a-f0-9]{32}$/u),
  }).strict(),
}).strict().refine((body) => body.expiresAt > body.issuedAt && body.expiresAt - body.issuedAt <= MAX_ATTESTATION_LIFETIME_MS)
export type ReleaseBody = z.infer<typeof releaseBodySchema>
export const releaseAttestationSchema = z.object({ body: releaseBodySchema, keyId: digest,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict()
export type ReleaseAttestation = z.infer<typeof releaseAttestationSchema>

export const configurationHash = (config: AnalysisServiceConfig): string => createHash('sha256').update(canonicalizeJson({
  // Bind all runtime policy, including future configuration additions. Only deployment
  // hold/proof paths may change without reissuing evidence. Publish no individual fields.
  ...Object.fromEntries(Object.entries(config).filter(([name]) => name !== 'release')),
  corsOrigins: [...config.corsOrigins].sort(),
})).digest('hex')

export const publicKeyId = (key: KeyObject): string => createHash('sha256')
  .update(key.export({ type: 'spki', format: 'der' })).digest('hex')

export const signReleaseAttestation = (body: ReleaseBody, privateKey: KeyObject): ReleaseAttestation => {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('release_signing_key_invalid')
  const parsed = releaseBodySchema.parse(body)
  return { body: parsed, keyId: publicKeyId(createPublicKey(privateKey)),
    signature: sign(null, Buffer.from(canonicalizeJson(parsed)), privateKey).toString('base64') }
}

export type ReleaseDecision = Readonly<{ ready: true; expiresAt: number }> | Readonly<{
  ready: false; reason: 'invalid' | 'untrusted_key' | 'not_yet_valid' | 'expired' | 'build_mismatch' | 'configuration_mismatch' | 'held' | 'not_configured'
}>
export const verifyReleaseAttestation = (input: {
  readonly value: unknown; readonly publicKey: string; readonly build: BuildIdentity
  readonly configurationHash: string; readonly now: number
}): ReleaseDecision => {
  try {
    const receipt = releaseAttestationSchema.parse(input.value)
    const key = createPublicKey(input.publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || receipt.keyId !== publicKeyId(key)) return { ready: false, reason: 'untrusted_key' }
    if (!verify(null, Buffer.from(canonicalizeJson(receipt.body)), key, Buffer.from(receipt.signature, 'base64'))) return { ready: false, reason: 'invalid' }
    if (!Number.isSafeInteger(input.now) || receipt.body.issuedAt > input.now) return { ready: false, reason: 'not_yet_valid' }
    if (receipt.body.expiresAt <= input.now) return { ready: false, reason: 'expired' }
    if (canonicalizeJson(receipt.body.build) !== canonicalizeJson(input.build)) return { ready: false, reason: 'build_mismatch' }
    if (canonicalizeJson(receipt.body.promptVersions) !== canonicalizeJson(RELEASE_PROMPT_VERSIONS)) return { ready: false, reason: 'build_mismatch' }
    if (receipt.body.configurationHash !== input.configurationHash) return { ready: false, reason: 'configuration_mismatch' }
    return { ready: true, expiresAt: receipt.body.expiresAt }
  } catch { return { ready: false, reason: 'invalid' } }
}
