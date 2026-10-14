import { personalProviderModelsInputSchema, providerModelIdSchema, type PersonalProviderModelsInput } from '@cat-thinking/analysis-contracts'
import type { AnalysisEventV1, AnalysisRunV1 } from '@cat-thinking/analysis-contracts'

export interface PersonalProfileState {
  readonly revision: number
  readonly profileId?: string
  readonly enabled: boolean
  readonly checkState: 'unchecked' | 'ready' | 'failed' | 'unsupported'
}
export interface PersonalProviderSnapshot {
  readonly id: string
  readonly settings: PersonalSavedSettings
  readonly revoked: boolean
}
export type PersonalSavedSettings = PersonalProviderModelsInput & Readonly<{ modelId: string }>
export const storedPersonalSettingsSchema = personalProviderModelsInputSchema.extend({ modelId: providerModelIdSchema })
export interface PersonalProfileStore {
  readState(): Promise<PersonalProfileState>
  getSnapshot(profileId: string): Promise<PersonalProviderSnapshot | undefined>
  save(expectedRevision: number, settings: PersonalSavedSettings): Promise<PersonalProfileState>
  setCheck(expectedRevision: number, result: 'ready' | 'failed' | 'unsupported'): Promise<PersonalProfileState>
  setEnabled(expectedRevision: number, enabled: boolean): Promise<PersonalProfileState>
  clear(expectedRevision: number): Promise<PersonalProfileState>
  revokeHistoricSecrets(retainProfileId?: string): Promise<void>
  getRunSnapshot(tenantId: string, runId: string): Promise<PersonalProviderSnapshot | undefined>
  createRun(tenantId: string, run: AnalysisRunV1, event: AnalysisEventV1): Promise<Readonly<{ run: AnalysisRunV1; reused: boolean; event?: AnalysisEventV1 }>>
  listBoundActiveRuns(): Promise<readonly Readonly<{ tenantId: string; runId: string }>[]>
  listDispatchableRuns(now: number, limit: number): Promise<readonly Readonly<{ tenantId: string; runId: string }>[]>
  listExpiredRuns(now: number, limit: number): Promise<readonly Readonly<{ tenantId: string; runId: string }>[]>
  checkHealth(): Promise<boolean>
  close(): Promise<void>
}

export class PersonalProfileConflictError extends Error {
  constructor() { super('personal_profile_revision_conflict'); this.name = 'PersonalProfileConflictError' }
}
export class PersonalProfileUnavailableError extends Error {
  constructor() { super('personal_profile_unavailable'); this.name = 'PersonalProfileUnavailableError' }
}
