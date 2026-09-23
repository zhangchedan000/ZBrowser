import type { IdentityConfigSection, IdentityConfigSource } from './types'

export type FingerprintComponent =
  | 'browser'
  | 'hardware'
  | 'gpu'
  | 'rendering'
  | 'network'
  | 'locale'

export type FingerprintRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type FingerprintRepairPolicy = 'suggest_only' | 'confirm_apply'

export interface FingerprintConfigReference {
  section: IdentityConfigSection
  key: string
  source: IdentityConfigSource
}

export interface FingerprintHealthSignal {
  component: FingerprintComponent
  key: string
  value: unknown
  expected?: unknown
  weight: number
  confidence: number
  impact: 'info' | 'warning' | 'error'
  evidence: string
  configReferences?: FingerprintConfigReference[]
}

export interface FingerprintComponentHealth {
  component: FingerprintComponent
  score: number
  risk: FingerprintRiskLevel
  signals: FingerprintHealthSignal[]
}

export interface FingerprintIdentitySnapshot {
  browser?: Record<string, unknown>
  hardware?: Record<string, unknown>
  gpu?: Record<string, unknown>
  rendering?: Record<string, unknown>
  network?: Record<string, unknown>
  locale?: Record<string, unknown>
}

export interface FingerprintHealthModel {
  score: number
  risk: FingerprintRiskLevel
  identity: FingerprintIdentitySnapshot
  components: FingerprintComponentHealth[]
  generatedAt: string
}

export interface AIDiagnosisIssue {
  component: FingerprintComponent
  key: string
  evidence: string
  configReferences: FingerprintConfigReference[]
  repairPolicy: FingerprintRepairPolicy
}

export interface AIDiagnosisContext {
  summary: string
  risks: string[]
  suggestedActions: string[]
  requiresUserConfirmation: boolean
  issues: AIDiagnosisIssue[]
  protectedUserOverrides: number
}

export function calculateFingerprintHealthScore(signals: FingerprintHealthSignal[]): number {
  const penalty = signals.reduce((total, signal) => {
    if (signal.impact === 'error') return total + signal.weight * signal.confidence
    if (signal.impact === 'warning') return total + signal.weight * signal.confidence * 0.5
    return total
  }, 0)

  return Math.max(0, Math.min(100, Math.round(100 - penalty)))
}

export function resolveFingerprintRisk(score: number): FingerprintRiskLevel {
  if (score < 40) return 'critical'
  if (score < 65) return 'high'
  if (score < 85) return 'medium'
  return 'low'
}
