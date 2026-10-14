import {
  ANALYSIS_CONTRACT_VERSION,
  evidenceCardSchema,
  providerRouteSchema,
  type EvidenceCardV1,
  type SourceCitationV1,
} from '@cat-thinking/analysis-contracts'
import { ZodError } from 'zod'
import type {
  EvidenceGenerator,
  EvidenceGeneratorRoute,
  EvidenceMapInput,
  EvidenceMapOutput,
} from '../domain/evidenceGenerator.js'
import { EvidenceValidationError } from '../domain/evidenceValidator.js'
import {
  EVIDENCE_MAP_OUTPUT_JSON_SCHEMA,
  EVIDENCE_QUOTE_OUTPUT_JSON_SCHEMA,
  EVIDENCE_SOURCE_REF_OUTPUT_JSON_SCHEMA,
  EVIDENCE_MAP_PROMPT_VERSION,
  EVIDENCE_QUOTE_PROMPT_VERSION,
  EVIDENCE_SOURCE_REF_PROMPT_VERSION,
  EVIDENCE_ARTIFACT_REF_PROMPT_VERSION,
  type EvidenceMapModelOutput,
  type EvidenceQuoteModelOutput,
  type EvidenceSourceRefModelOutput,
  type EvidenceMapPromptVariables,
  evidenceMapModelOutputSchema,
  evidenceQuoteModelOutputSchema,
  evidenceSourceRefModelOutputSchema,
} from './evidenceMapPrompt.js'
import type { EvidenceRepairVariables } from './evidenceRepairPrompt.js'
import { EvidenceQuoteResolutionError, resolveEvidenceQuote, validateEvidenceCardForChunk } from './evidenceQuoteResolver.js'
import { createEvidenceSourceExcerpts, EvidenceExcerptResolutionError, resolveEvidenceSourceExcerpt,
  type EvidenceSourceExcerpt } from './evidenceSourceExcerpts.js'
import { createStableInvocationId } from './invocationId.js'
import { ProviderGatewayError } from './providerError.js'
import type { ProviderInvocationCoordinator } from './providerInvocationCoordinator.js'
import type { PromptDefinition, PromptRegistry } from './promptRegistry.js'
import { StructuredOutputDecodeError, decodeStructuredOutput } from './structuredOutputDecoder.js'

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const DEFAULT_MAX_DECODE_BYTES = 1_000_000
const RUN_ATTEMPT = 0

export interface ProviderEvidenceGeneratorOptions {
  readonly coordinator: ProviderInvocationCoordinator
  readonly prompts: PromptRegistry
  readonly promptId: string
  readonly route: EvidenceGeneratorRoute
  readonly maxOutputTokens?: number
  readonly maxDecodeBytes?: number
  readonly temperature?: number
  readonly repair?: Readonly<{ promptId: string; route: EvidenceGeneratorRoute }>
}

const positiveInteger = (value: number, label: string, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer not greater than ${maximum}`)
  }
}

const citationFor = (input: EvidenceMapInput, span: { readonly start: number; readonly end: number }): SourceCitationV1 => ({
  version: ANALYSIS_CONTRACT_VERSION,
  provenance: 'source',
  sourceId: input.chunk.sourceId,
  start: span.start,
  end: span.end,
})

const cardFor = (input: EvidenceMapInput, output: EvidenceMapModelOutput): EvidenceCardV1 => evidenceCardSchema.parse({
  version: ANALYSIS_CONTRACT_VERSION,
  chunkId: input.chunk.chunkId,
  chunkHash: input.chunk.chunkHash,
  sourceId: input.chunk.sourceId,
  titlePath: input.chunk.titlePath,
  claims: output.claims.map((claim) => ({
    ...claim,
    citations: claim.citations.map((citation) => citationFor(input, citation)),
  })),
  terms: output.terms.map((term) => ({
    ...term,
    citations: term.citations.map((citation) => citationFor(input, citation)),
  })),
  learningObjectives: output.learningObjectives,
})

const quoteCardFor = (input: EvidenceMapInput, output: EvidenceQuoteModelOutput): EvidenceCardV1 => evidenceCardSchema.parse({
  version: ANALYSIS_CONTRACT_VERSION,
  chunkId: input.chunk.chunkId,
  chunkHash: input.chunk.chunkHash,
  sourceId: input.chunk.sourceId,
  titlePath: input.chunk.titlePath,
  claims: output.claims.map((claim) => ({ ...claim, citations: claim.citations.map((citation) => resolveEvidenceQuote(input, citation)) })),
  terms: output.terms.map((term) => ({ ...term, citations: term.citations.map((citation) => resolveEvidenceQuote(input, citation)) })),
  learningObjectives: output.learningObjectives,
})

const sourceRefCardFor = (input: EvidenceMapInput, output: EvidenceSourceRefModelOutput,
  excerpts: readonly EvidenceSourceExcerpt[]): EvidenceCardV1 => evidenceCardSchema.parse({
  version: ANALYSIS_CONTRACT_VERSION,
  chunkId: input.chunk.chunkId, chunkHash: input.chunk.chunkHash, sourceId: input.chunk.sourceId, titlePath: input.chunk.titlePath,
  claims: output.claims.map((claim) => ({ ...claim,
    citations: claim.citations.map((citation) => resolveEvidenceSourceExcerpt(input, excerpts, citation)) })),
  terms: output.terms.map((term) => ({ ...term,
    citations: term.citations.map((citation) => resolveEvidenceSourceExcerpt(input, excerpts, citation)) })),
  learningObjectives: output.learningObjectives,
})

const failureCode = (error: unknown): string | undefined => {
  if (error instanceof StructuredOutputDecodeError || error instanceof EvidenceQuoteResolutionError
    || error instanceof EvidenceExcerptResolutionError) return error.code
  if (error instanceof ZodError) return 'contract_invalid'
  if (error instanceof EvidenceValidationError) return error.issues[0]?.code ?? 'validation_invalid'
  return undefined
}

export class ProviderEvidenceGenerator implements EvidenceGenerator {
  readonly route: EvidenceGeneratorRoute
  private readonly coordinator: ProviderInvocationCoordinator
  private readonly prompt: PromptDefinition<EvidenceMapPromptVariables>
  private readonly maxOutputTokens: number
  private readonly maxDecodeBytes: number
  private readonly temperature?: number
  private readonly repair?: PromptDefinition<EvidenceRepairVariables>
  private readonly repairRoute?: EvidenceGeneratorRoute
  private readonly usesQuotes: boolean
  private readonly usesSourceRefs: boolean

  constructor(options: ProviderEvidenceGeneratorOptions) {
    positiveInteger(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 'maxOutputTokens', 1_000_000)
    positiveInteger(options.maxDecodeBytes ?? DEFAULT_MAX_DECODE_BYTES, 'maxDecodeBytes', 20_000_000)
    if (options.temperature !== undefined && (
      !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2
    )) throw new RangeError('temperature must be between 0 and 2')
    this.route = Object.freeze(providerRouteSchema.parse(options.route))
    if (![EVIDENCE_MAP_PROMPT_VERSION, EVIDENCE_QUOTE_PROMPT_VERSION, EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION].includes(this.route.promptVersion)) {
      throw new RangeError('unsupported evidence prompt version')
    }
    this.usesQuotes = this.route.promptVersion === EVIDENCE_QUOTE_PROMPT_VERSION
    this.usesSourceRefs = [EVIDENCE_SOURCE_REF_PROMPT_VERSION, EVIDENCE_ARTIFACT_REF_PROMPT_VERSION].includes(this.route.promptVersion)
    this.coordinator = options.coordinator
    this.prompt = options.prompts.resolve<EvidenceMapPromptVariables>(
      options.promptId,
      this.route.promptVersion,
      'evidence-map',
    )
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    this.maxDecodeBytes = options.maxDecodeBytes ?? DEFAULT_MAX_DECODE_BYTES
    this.temperature = options.temperature
    if (options.repair) {
      this.repair = options.prompts.resolve(options.repair.promptId, options.repair.route.promptVersion, 'repair')
      this.repairRoute = Object.freeze(providerRouteSchema.parse(options.repair.route))
    }
  }

  async map(input: EvidenceMapInput, signal: AbortSignal): Promise<EvidenceMapOutput> {
    if (input.text.length !== input.chunk.end - input.chunk.start) {
      if (this.usesSourceRefs) throw new ProviderGatewayError({ providerId: this.route.providerId, kind: 'invalid_response', retryable: false,
        acceptance: 'not_accepted', safeCode: 'evidence_excerpt_range_invalid' })
      throw new RangeError('evidence chunk text length differs from its range')
    }
    let excerpts: readonly EvidenceSourceExcerpt[] = []
    if (this.usesSourceRefs) {
      try { excerpts = createEvidenceSourceExcerpts(input) } catch (error) {
        if (!(error instanceof EvidenceExcerptResolutionError)) throw error
        throw new ProviderGatewayError({ providerId: this.route.providerId, kind: 'invalid_response', retryable: false,
          acceptance: 'not_accepted', safeCode: `evidence_${error.code}` })
      }
    }
    const output = this.usesSourceRefs ? { name: 'evidence_map_v3', schema: EVIDENCE_SOURCE_REF_OUTPUT_JSON_SCHEMA } : this.usesQuotes
      ? { name: 'evidence_map_v2', schema: EVIDENCE_QUOTE_OUTPUT_JSON_SCHEMA }
      : { name: 'evidence_map_v1', schema: EVIDENCE_MAP_OUTPUT_JSON_SCHEMA }
    const original = this.prompt.render({ ...input.chunk, locale: input.locale, text: input.text,
      ...(this.usesSourceRefs ? { excerpts } : {}) })
    const nodeKey = `evidence:${input.chunk.chunkId}`
    const invocationId = createStableInvocationId({
      runId: input.runId,
      nodeKey,
      runAttempt: RUN_ATTEMPT,
      role: 'evidence-map',
    })
    let result = await this.coordinator.generate({
      tenantId: input.tenantId,
      runId: input.runId,
      nodeKey,
      runAttempt: RUN_ATTEMPT,
      expectedRoute: this.route,
      request: {
        invocationId,
        role: 'evidence-map',
        qualityProfile: input.qualityProfile,
        systemPrompt: this.prompt.system,
        userPrompt: original,
        output,
        maxOutputTokens: this.maxOutputTokens,
        ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
      },
    }, signal)
    let inputTokens = result.response.usage.inputTokens
    let outputTokens = result.response.usage.outputTokens
    const decode = () => validateEvidenceCardForChunk(input, this.usesSourceRefs
      ? sourceRefCardFor(input, decodeStructuredOutput(result.response.outputText, evidenceSourceRefModelOutputSchema, this.maxDecodeBytes), excerpts)
      : this.usesQuotes
      ? quoteCardFor(input, decodeStructuredOutput(result.response.outputText, evidenceQuoteModelOutputSchema, this.maxDecodeBytes))
      : cardFor(input, decodeStructuredOutput(result.response.outputText, evidenceMapModelOutputSchema, this.maxDecodeBytes)))
    try {
      let card
      try { card = decode() } catch (error) {
        const remainingTokens = this.maxOutputTokens - outputTokens
        const failure = failureCode(error)
        if (!this.repair || !this.repairRoute || signal.aborted
          || failure === undefined || failure === 'too_large' || remainingTokens <= 0) throw error
        const repairKey = `${nodeKey}:repair`
        result = await this.coordinator.generate({
          tenantId: input.tenantId, runId: input.runId, nodeKey: repairKey, runAttempt: RUN_ATTEMPT,
          expectedRoute: this.repairRoute,
          request: {
            invocationId: createStableInvocationId({ runId: input.runId, nodeKey: repairKey, runAttempt: RUN_ATTEMPT, role: 'repair' }),
            role: 'repair', qualityProfile: input.qualityProfile, systemPrompt: this.repair.system,
            userPrompt: this.repair.render({ task: 'evidence-map', original, rejected: result.response.outputText, failure }),
            output, maxOutputTokens: remainingTokens,
          },
        }, signal)
        inputTokens += result.response.usage.inputTokens
        outputTokens += result.response.usage.outputTokens
        card = decode()
      }
      return {
        card,
        inputTokens,
        outputTokens,
      }
    } catch (error) {
      const failure = failureCode(error)
      if (failure === undefined) throw error
      throw new ProviderGatewayError({
        providerId: this.route.providerId,
        kind: 'invalid_response',
        retryable: false,
        safeCode: `evidence_${failure}`,
      })
    }
  }
}
