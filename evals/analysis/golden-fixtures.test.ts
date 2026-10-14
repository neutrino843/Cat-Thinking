import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import expectationsFixture from './fixtures/foundations-zh/expectations.json'
import manifestFixture from './fixtures/foundations-zh/manifest.json'

const relationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.string().min(1),
})

const expectationsSchema = z
  .object({
    version: z.literal(1),
    fixtureId: z.string().min(1),
    language: z.string().min(2),
    requiredConcepts: z.array(z.string().min(1)).min(1),
    requiredRelations: z.array(relationSchema),
    answerableQuestions: z.array(
      z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict(),
    ),
    forbiddenClaims: z.array(z.string().min(1)),
    requiredSourceFragments: z.array(z.string().min(1)).min(1),
  })
  .strict()

const manifestSchema = z
  .object({
    version: z.literal(1),
    fixtureId: z.string().min(1),
    sourceFile: z.literal('source.txt'),
    expectationsFile: z.literal('expectations.json'),
    license: z.literal('project-generated'),
    redistributable: z.literal(true),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

describe('analysis golden fixture manifest', () => {
  it('pins project-generated source bytes and expectation identity', () => {
    const source = readFileSync('evals/analysis/fixtures/foundations-zh/source.txt', 'utf8')
    const expectations = expectationsSchema.parse(expectationsFixture)
    const manifest = manifestSchema.parse(manifestFixture)
    const hash = createHash('sha256').update(source, 'utf8').digest('hex')

    expect(hash).toBe(manifest.contentHash)
    expect(expectations.fixtureId).toBe(manifest.fixtureId)
  })

  it('anchors every required fragment in the immutable source', () => {
    const source = readFileSync('evals/analysis/fixtures/foundations-zh/source.txt', 'utf8')
    const expectations = expectationsSchema.parse(expectationsFixture)

    for (const fragment of expectations.requiredSourceFragments) {
      expect(source).toContain(fragment)
    }
    for (const forbidden of expectations.forbiddenClaims) {
      expect(source).not.toContain(forbidden)
    }
  })
})
