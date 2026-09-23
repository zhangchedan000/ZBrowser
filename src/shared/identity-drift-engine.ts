import type { IdentityBaselineSnapshot, IdentityDriftChange, IdentityDriftReport } from './identity-baseline-model'

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { [prefix]: value }
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, child]) => {
    Object.assign(result, flatten(child, prefix ? `${prefix}.${key}` : key))
    return result
  }, {})
}

function severityFor(component: keyof IdentityBaselineSnapshot, field: string): IdentityDriftChange['severity'] {
  if (component === 'gpu' || field.includes('renderer') || field.includes('vendor')) return 'critical'
  if (component === 'network') return 'high'
  if (component === 'locale') return 'medium'
  return 'medium'
}

export function compareIdentityBaseline(
  profileId: string,
  baselineId: string,
  baseline: IdentityBaselineSnapshot,
  current: IdentityBaselineSnapshot
): IdentityDriftReport {
  const changes: IdentityDriftChange[] = []

  for (const component of Object.keys(baseline) as Array<keyof IdentityBaselineSnapshot>) {
    const before = flatten(baseline[component])
    const after = flatten(current[component])
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])

    for (const field of keys) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        changes.push({
          component,
          field,
          before: before[field],
          after: after[field],
          severity: severityFor(component, field)
        })
      }
    }
  }

  const highest = changes.some((item) => item.severity === 'critical')
    ? 'critical'
    : changes.some((item) => item.severity === 'high')
      ? 'high'
      : changes.length
        ? 'medium'
        : 'low'

  return {
    profileId,
    baselineId,
    driftDetected: changes.length > 0,
    severity: highest,
    confidence: changes.length ? 0.95 : 1,
    changes,
    generatedAt: new Date().toISOString()
  }
}
