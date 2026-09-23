import {
  calculateFingerprintHealthScore,
  resolveFingerprintRisk,
  type FingerprintComponentHealth,
  type FingerprintHealthModel,
  type FingerprintHealthSignal
} from './fingerprint-health-model'

function groupSignals(signals: FingerprintHealthSignal[]): FingerprintComponentHealth[] {
  const groups = new Map<string, FingerprintHealthSignal[]>()

  for (const signal of signals) {
    const current = groups.get(signal.component) ?? []
    current.push(signal)
    groups.set(signal.component, current)
  }

  return Array.from(groups.entries()).map(([component, componentSignals]) => {
    const score = calculateFingerprintHealthScore(componentSignals)

    return {
      component: component as FingerprintComponentHealth['component'],
      score,
      risk: resolveFingerprintRisk(score),
      signals: componentSignals
    }
  })
}

export function buildFingerprintHealthModel(
  signals: FingerprintHealthSignal[],
  identity: FingerprintHealthModel['identity'] = {}
): FingerprintHealthModel {
  const score = calculateFingerprintHealthScore(signals)

  return {
    score,
    risk: resolveFingerprintRisk(score),
    identity,
    components: groupSignals(signals).sort((a, b) => a.score - b.score),
    generatedAt: new Date().toISOString()
  }
}
