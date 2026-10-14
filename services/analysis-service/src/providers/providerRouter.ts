import type { QualityProfile } from '@cat-thinking/analysis-contracts'
import type { ModelProvider, ModelTaskRole } from './modelProvider.js'

export interface ModelRouteProfile {
  readonly id: string
  readonly providerId: string
  readonly modelId: string
  readonly profileVersion: string
  readonly promptId: string
  readonly promptVersion: string
  readonly roles: readonly ModelTaskRole[]
  readonly qualityProfiles: readonly QualityProfile[]
  readonly priority: number
}

export interface ProviderRouteSelection {
  readonly provider: ModelProvider
  readonly profile: ModelRouteProfile
}

export class ProviderRoutingError extends Error {
  constructor(
    readonly code: 'invalid_configuration' | 'route_unavailable',
    readonly role?: ModelTaskRole,
    readonly qualityProfile?: QualityProfile,
  ) {
    super(`provider routing failed: ${code}`)
    this.name = 'ProviderRoutingError'
  }
}

export class ProviderRouter {
  private readonly providers: ReadonlyMap<string, ModelProvider>
  private readonly profiles: readonly ModelRouteProfile[]

  constructor(providers: readonly ModelProvider[], profiles: readonly ModelRouteProfile[]) {
    const providerMap = new Map<string, ModelProvider>()
    for (const provider of providers) {
      if (providerMap.has(provider.id)) throw new ProviderRoutingError('invalid_configuration')
      providerMap.set(provider.id, provider)
    }
    const profileIds = new Set<string>()
    const storedProfiles: ModelRouteProfile[] = []
    for (const profile of profiles) {
      const provider = providerMap.get(profile.providerId)
      if (
        profileIds.has(profile.id)
        || !provider
        || provider.modelId !== profile.modelId
        || provider.profileVersion !== profile.profileVersion
        || !Number.isInteger(profile.priority)
        || profile.priority < 0
        || profile.roles.length === 0
        || profile.qualityProfiles.length === 0
      ) throw new ProviderRoutingError('invalid_configuration')
      profileIds.add(profile.id)
      storedProfiles.push(Object.freeze({
        ...profile,
        roles: Object.freeze([...profile.roles]),
        qualityProfiles: Object.freeze([...profile.qualityProfiles]),
      }))
    }
    this.providers = providerMap
    this.profiles = Object.freeze(storedProfiles.sort((left, right) => (
      left.priority - right.priority || left.id.localeCompare(right.id)
    )))
  }

  route(role: ModelTaskRole, qualityProfile: QualityProfile): ProviderRouteSelection {
    for (const profile of this.profiles) {
      if (!profile.roles.includes(role) || !profile.qualityProfiles.includes(qualityProfile)) continue
      const provider = this.providers.get(profile.providerId)
      if (provider?.isReady()) return { provider, profile }
    }
    throw new ProviderRoutingError('route_unavailable', role, qualityProfile)
  }
}
