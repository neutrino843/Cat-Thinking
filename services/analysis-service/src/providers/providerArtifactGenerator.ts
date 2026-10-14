import { canonicalizeJson, mindMapArtifactSchema, type ArtifactKind, type ProviderRouteV1 } from '@cat-thinking/analysis-contracts'
import type { ArtifactGenerationInput, ArtifactGenerationOutput, ArtifactGenerator } from '../domain/artifactGenerator.js'
import { ArtifactValidationError, validateGeneratedArtifact } from '../domain/artifactValidator.js'
import { ARTIFACT_PAYLOAD_SCHEMAS, MINDMAP_HIERARCHY_PROMPT_VERSION, OUTLINE_HIERARCHY_PROMPT_VERSION,
  REPAIR_PROMPT_VERSION, artifactOutputSchema, artifactPromptVersion, type RepairVariables } from './artifactPrompts.js'
import { createStableInvocationId } from './invocationId.js'
import { ProviderGatewayError } from './providerError.js'
import type { ProviderInvocationCoordinator } from './providerInvocationCoordinator.js'
import type { PromptDefinition, PromptRegistry } from './promptRegistry.js'
import { decodeStructuredOutput, StructuredOutputDecodeError } from './structuredOutputDecoder.js'
import { z } from 'zod'
import { normalizeOptionalNulls, strictOutputSchema } from './strictOutputSchema.js'
import { inheritOutlineHierarchy } from '../domain/outlineHierarchy.js'
import {
  ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION, ARTIFACT_SOURCE_REFERENCE_VERSIONS,
  ArtifactReferenceDraftError, artifactReferenceDraftOutputSchema, artifactReferenceDraftSchema,
  createArtifactReferenceCatalog, hydrateArtifactReferenceDraft,
} from './artifactReferenceDraft.js'

export interface ArtifactAdapterRoute { readonly promptId: string; readonly route: ProviderRouteV1 }
export interface ProviderArtifactGeneratorOptions {
  readonly coordinator: ProviderInvocationCoordinator
  readonly prompts: PromptRegistry
  readonly routes: Readonly<Record<ArtifactKind, ArtifactAdapterRoute>>
  readonly repair?: ArtifactAdapterRoute
  readonly now?: () => number
  readonly maxOutputTokens?: number
}

export class ProviderArtifactGenerator implements ArtifactGenerator {
  private readonly prompts: Readonly<Record<ArtifactKind, PromptDefinition<ArtifactGenerationInput>>>
  private readonly repair?: PromptDefinition<RepairVariables>
  constructor(private readonly options: ProviderArtifactGeneratorOptions) {
    const protocolFamilies = new Set(Object.entries(options.routes).map(([kind, config]) => {
      const artifactKind = kind as ArtifactKind
      if (config.route.promptVersion === ARTIFACT_SOURCE_REFERENCE_VERSIONS[artifactKind]) return 'source-refs'
      if (config.route.promptVersion === artifactPromptVersion(artifactKind)) return 'legacy'
      throw new RangeError('unsupported artifact prompt version')
    }))
    if (options.repair && (protocolFamilies.size !== 1 || options.repair.route.promptVersion !== (
      protocolFamilies.has('source-refs') ? ARTIFACT_SOURCE_REFERENCE_REPAIR_VERSION : REPAIR_PROMPT_VERSION
    ))) throw new RangeError('artifact repair prompt version does not match the artifact protocol')
    this.prompts = Object.fromEntries(Object.entries(options.routes).map(([kind, config]) => [kind,
      options.prompts.resolve<ArtifactGenerationInput>(config.promptId, config.route.promptVersion, `artifact-${kind as ArtifactKind}`),
    ])) as Record<ArtifactKind, PromptDefinition<ArtifactGenerationInput>>
    if (options.repair) this.repair = options.prompts.resolve(options.repair.promptId, options.repair.route.promptVersion, 'repair')
  }

  async generate(input: ArtifactGenerationInput, signal: AbortSignal): Promise<ArtifactGenerationOutput> {
    const snapshots = new Map(input.run.request.manifest.sources.map((source) => [source.sourceId, source]))
    const sourceContextMatches = canonicalizeJson(input.graph.sourceContentHashes) === canonicalizeJson(input.run.request.manifest.sources.map((source) => source.contentHash))
      && input.graph.chunks.every((chunk) => {
        const source = snapshots.get(chunk.sourceId)
        return source !== undefined && chunk.start >= (source.selectedRange?.start ?? 0)
          && chunk.end <= (source.selectedRange?.end ?? source.charCount)
      })
    if (input.runId !== input.run.id || input.docId !== input.run.docId || input.graph.runId !== input.runId
      || !sourceContextMatches || canonicalizeJson(input.options) !== canonicalizeJson(input.run.request.options)
      || !input.run.request.artifacts.includes(input.kind) || input.kind === 'mindmap' && !input.outline) {
      throw new ArtifactValidationError([{ code: 'identity_invalid', path: '', message: 'scheduled artifact context is invalid' }])
    }
    const prompt = this.prompts[input.kind]
    const usesSourceReferences = prompt.version === ARTIFACT_SOURCE_REFERENCE_VERSIONS[input.kind]
    let catalog: ReturnType<typeof createArtifactReferenceCatalog> | undefined
    let original: string
    try {
      catalog = usesSourceReferences ? createArtifactReferenceCatalog(input.graph) : undefined
      original = prompt.render(input)
    } catch (error) {
      if (!(error instanceof ArtifactReferenceDraftError)) throw error
      throw new ProviderGatewayError({ providerId: this.options.routes[input.kind].route.providerId,
        kind: 'invalid_response', retryable: false, acceptance: 'not_accepted', safeCode: `artifact_${error.code}` })
    }
    const nodeKey = `artifact:${input.kind}`
    const payloadSchema = usesSourceReferences ? artifactReferenceDraftOutputSchema(input.kind) : artifactOutputSchema(input.kind)
    const output = { name: usesSourceReferences ? `artifact_${input.kind}_source_refs_v1` : `artifact_${input.kind}_v1`,
      schema: strictOutputSchema(payloadSchema) }
    const tokenBudget = Math.min(input.budget.maxOutputTokens, this.options.maxOutputTokens ?? input.budget.maxOutputTokens)
    const call = (repair: boolean, userPrompt: string, maxOutputTokens = tokenBudget) => {
      const config = repair ? this.options.repair : this.options.routes[input.kind]
      const system = repair ? this.repair?.system : prompt.system
      if (!config || !system) throw new Error('repair configuration is unavailable')
      const role = repair ? 'repair' as const : `artifact-${input.kind}` as const
      const key = repair ? `${nodeKey}:repair` : nodeKey
      return this.options.coordinator.generate({
        tenantId: input.tenantId, runId: input.runId, nodeKey: key, runAttempt: input.attempt,
        expectedRoute: config.route,
        request: {
          invocationId: createStableInvocationId({ runId: input.runId, nodeKey: key, runAttempt: input.attempt, role }),
          role, qualityProfile: input.options.qualityProfile,
          systemPrompt: system, userPrompt, output,
          maxOutputTokens,
        },
      }, signal)
    }
    let result = await call(false, original)
    let usage = result.response.usage
    let estimatedCostMicros = result.invocation.estimatedCostMicros
    const decode = () => {
      let payload: unknown
      if (usesSourceReferences && catalog) {
        // The JSON decoder bounds bytes/depth before schema normalization. Only
        // optional nulls are omitted; strict wrapper/citation keys remain enforced.
        const schema = z.preprocess((value) => normalizeOptionalNulls(value, payloadSchema), artifactReferenceDraftSchema(input.kind))
        const draft = decodeStructuredOutput(result.response.outputText, schema, input.budget.maxArtifactBytes)
        payload = hydrateArtifactReferenceDraft(input.kind, draft, catalog)
      } else {
        // The persisted legacy protocol keeps its numeric citation contract.
        const decoded = decodeStructuredOutput(result.response.outputText, z.unknown(), input.budget.maxArtifactBytes)
        const parsed = ARTIFACT_PAYLOAD_SCHEMAS[input.kind].safeParse(normalizeOptionalNulls(decoded, payloadSchema))
        if (!parsed.success) throw new StructuredOutputDecodeError('schema_invalid')
        payload = parsed.data
      }
      const enforceOutlineHierarchy = prompt.version === MINDMAP_HIERARCHY_PROMPT_VERSION
        || prompt.version === ARTIFACT_SOURCE_REFERENCE_VERSIONS.mindmap
      const enforceNodeGrounding = enforceOutlineHierarchy || prompt.version === OUTLINE_HIERARCHY_PROMPT_VERSION
        || prompt.version === ARTIFACT_SOURCE_REFERENCE_VERSIONS.outline
      const validatedPayload = input.kind === 'mindmap' && input.outline && enforceOutlineHierarchy
        ? inheritOutlineHierarchy(mindMapArtifactSchema.parse(payload), input.outline) : payload
      const now = (this.options.now ?? Date.now)()
      return validateGeneratedArtifact({
        artifact: {
          version: 1, schemaVersion: 1, id: `artifact-${result.invocation.invocationId}`,
          runId: input.runId, docId: input.docId, kind: input.kind,
          sourceContentHashes: input.graph.sourceContentHashes, createdAt: now, updatedAt: now, payload: validatedPayload,
        },
        expectedKind: input.kind, run: input.run, graph: input.graph, outline: input.outline,
        enforceOutlineHierarchy, enforceNodeGrounding,
        maxArtifactBytes: input.budget.maxArtifactBytes,
      })
    }
    try {
      let artifact
      try { artifact = decode() } catch (error) {
        const remainingTokens = tokenBudget - usage.outputTokens
        if (!this.repair || signal.aborted || !this.repairable(error) || remainingTokens <= 0) throw error
        result = await call(true, this.repair.render({
          task: input.kind, original, rejected: result.response.outputText,
          failure: error instanceof ArtifactValidationError
            ? JSON.stringify(error.issues.slice(0, 12).map(({ code, path, message }) => ({ code, path, message })))
            : error instanceof StructuredOutputDecodeError || error instanceof ArtifactReferenceDraftError ? error.code : 'artifact_invalid',
        }), remainingTokens)
        usage = { inputTokens: usage.inputTokens + result.response.usage.inputTokens, outputTokens: usage.outputTokens + result.response.usage.outputTokens }
        estimatedCostMicros += result.invocation.estimatedCostMicros
        artifact = decode()
      }
      return { artifact, route: this.options.routes[input.kind].route,
        usage: { ...usage, estimatedCostMicros, currency: 'USD' } }
    } catch (error) {
      if (!(error instanceof ArtifactValidationError) && !(error instanceof StructuredOutputDecodeError)
        && !(error instanceof ArtifactReferenceDraftError)) throw error
      const tooLarge = error instanceof StructuredOutputDecodeError && error.code === 'too_large'
        || error instanceof ArtifactValidationError && error.issues.some(({ code }) => code === 'artifact_too_large')
      throw new ProviderGatewayError({ providerId: result.route.providerId, kind: 'invalid_response', retryable: false,
        safeCode: error instanceof ArtifactReferenceDraftError ? `artifact_${error.code}`
          : tooLarge ? 'artifact_output_too_large' : 'artifact_output_invalid' })
    }
  }
  private repairable(error: unknown): boolean {
    return error instanceof ArtifactValidationError && !error.issues.some(({ code }) => code === 'artifact_too_large')
      || error instanceof StructuredOutputDecodeError && error.code !== 'too_large'
      || error instanceof ArtifactReferenceDraftError && !['capacity_exceeded', 'catalog_invalid'].includes(error.code)
  }
}
