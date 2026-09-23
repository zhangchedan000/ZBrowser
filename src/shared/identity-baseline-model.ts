import type { IdentityConfigProvenance } from './types'

export type IdentityBaselineStatus = 'active' | 'stale' | 'replaced'

export interface IdentitySnapshotGroup {
  [key: string]: unknown
}

export interface IdentityBaselineSnapshot {
  browser: IdentitySnapshotGroup
  hardware: IdentitySnapshotGroup
  gpu: IdentitySnapshotGroup
  rendering: IdentitySnapshotGroup
  network: IdentitySnapshotGroup
  locale: IdentitySnapshotGroup
}

export interface IdentityBaseline {
  id: string
  profileId: string
  version: number
  status: IdentityBaselineStatus
  createdAt: string
  updatedAt: string
  lastVerifiedAt: string
  snapshot: IdentityBaselineSnapshot
  identityConfigProvenance: IdentityConfigProvenance
}

export interface IdentityDriftChange {
  component: keyof IdentityBaselineSnapshot
  field: string
  before: unknown
  after: unknown
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface IdentityDriftReport {
  profileId: string
  baselineId: string
  driftDetected: boolean
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  changes: IdentityDriftChange[]
  generatedAt: string
}
