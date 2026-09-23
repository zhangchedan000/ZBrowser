import type { IdentityConfigValue } from './identity-config-resolver'

export interface IdentityConflict {
  key: string
  aiValue?: unknown
  userValue?: unknown
  runtimeValue?: unknown
  severity: 'low' | 'medium' | 'high'
  message: string
}

export interface IdentityConflictReport {
  conflicts: IdentityConflict[]
  hasConflicts: boolean
}

function compareValue(key: string, config: IdentityConfigValue, runtime?: unknown): IdentityConflict | null {
  if (runtime === undefined || runtime === config.value) return null

  return {
    key,
    aiValue: config.source === 'ai' ? config.value : undefined,
    userValue: config.source === 'user' ? config.value : undefined,
    runtimeValue: runtime,
    severity: config.source === 'user' ? 'medium' : 'high',
    message: `${key} differs from runtime value`
  }
}

export function detectIdentityConflicts(
  config: Record<string, IdentityConfigValue>,
  runtime: Record<string, unknown>
): IdentityConflictReport {
  const conflicts = Object.entries(config)
    .map(([key, value]) => compareValue(key, value, runtime[key]))
    .filter((item): item is IdentityConflict => item !== null)

  return {
    conflicts,
    hasConflicts: conflicts.length > 0
  }
}
