import type { AIDiagnosisContext } from './fingerprint-health-model'

export type IdentityConfigArea =
  | 'fingerprint'
  | 'network'
  | 'locale'
  | 'browser'
  | 'hardware'

export interface IdentityAnalysisRequest {
  areas: IdentityConfigArea[]
  userOverrides?: Record<string, unknown>
}

export interface IdentityConfigurationPlan {
  detectedIssues: string[]
  suggestedChanges: string[]
  requiresConfirmation: boolean
  preservedUserOverrides: Record<string, unknown>
}

export function buildIdentityConfigurationPlan(
  diagnosis: AIDiagnosisContext,
  request: IdentityAnalysisRequest
): IdentityConfigurationPlan {
  const preservedUserOverrides = request.userOverrides ?? {}

  return {
    detectedIssues: diagnosis.risks,
    suggestedChanges: diagnosis.suggestedActions,
    requiresConfirmation: true,
    preservedUserOverrides
  }
}
