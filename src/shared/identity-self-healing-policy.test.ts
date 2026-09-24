import { describe, expect, it } from 'vitest'
import { evaluateIdentitySelfHealingPolicy } from './identity-self-healing-policy'
import type { IdentityRepairStrategy } from './identity-repair-strategy'

function strategy(kind: IdentityRepairStrategy['kind'], sections: IdentityRepairStrategy['affectedSections'] = []): IdentityRepairStrategy {
  return {
    kind,
    reason: kind,
    affectedSections: sections,
    requiresUserConfirmation: kind !== 'replace_baseline',
    automaticActionAvailable: kind !== 'manual_review' && kind !== 'none',
    targetCountryCode: 'US',
    ...(kind === 'switch_proxy'
      ? { candidateProxy: { id: 'us-1', name: 'US 1', countryCode: 'US', score: 95 } }
      : {})
  }
}

describe('identity self-healing policy', () => {
  it('keeps old/default assisted profiles confirmation-gated', () => {
    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'assisted',
      environmentType: 'temporary',
      strategy: strategy('repair_configuration', ['locale'])
    }).action).toBe('suggest')
  })

  it('auto-executes only low-risk locale/browser configuration repair', () => {
    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'account',
      strategy: strategy('repair_configuration', ['locale', 'browser']),
      driftSeverity: 'medium',
      healthRisk: 'medium'
    }).action).toBe('execute')

    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'account',
      strategy: strategy('repair_configuration', ['network']),
      driftSeverity: 'medium',
      healthRisk: 'medium'
    }).action).toBe('suggest')
  })

  it('never auto-switches an account environment proxy', () => {
    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'account',
      strategy: strategy('switch_proxy')
    }).action).toBe('suggest')

    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'temporary',
      strategy: strategy('switch_proxy'),
      driftSeverity: 'medium',
      healthRisk: 'medium'
    }).action).toBe('execute')
  })

  it('keeps full identity regeneration confirmation-gated even in auto mode', () => {
    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'temporary',
      strategy: strategy('regenerate_identity', ['fingerprint'])
    })).toMatchObject({ action: 'suggest', risk: 'high' })
  })

  it('allows verified baseline replacement in auto mode', () => {
    expect(evaluateIdentitySelfHealingPolicy({
      mode: 'auto',
      environmentType: 'account',
      strategy: strategy('replace_baseline')
    })).toMatchObject({ action: 'execute', risk: 'low' })
  })
})
