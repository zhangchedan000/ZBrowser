import { describe, expect, it } from 'vitest'
import { buildAIDiagnosisContext } from './fingerprint-ai-diagnosis'
import { diagnosticChecksToHealthSignals } from './fingerprint-health-adapter'
import { buildFingerprintHealthModel } from './fingerprint-health-aggregator'
import { buildRepairProposals } from './fingerprint-repair-proposal'
import { approveRepairWorkflow, createRepairWorkflow, validateRepairSafety } from './fingerprint-repair-workflow'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from './identity-config-provenance'

describe('fingerprint intelligence provenance', () => {
  it('turns a user-owned mismatch into suggest-only repair while AI-owned fields remain repairable after confirmation', () => {
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['timezone'], 'user')
    provenance = markFingerprintConfigSources(provenance, ['gpuBucket'], 'ai')

    const signals = diagnosticChecksToHealthSignals([
      {
        key: 'runtime-timezone',
        status: 'error',
        message: '实际 America/Los_Angeles / 预期 America/New_York'
      },
      {
        key: 'runtime-webgl-renderer',
        status: 'error',
        message: 'GPU renderer mismatch'
      }
    ], provenance)

    const timezone = signals.find((signal) => signal.key === 'runtime-timezone')
    const gpu = signals.find((signal) => signal.key === 'runtime-webgl-renderer')
    expect(timezone?.configReferences?.map((reference) => reference.source)).toContain('user')
    expect(gpu?.configReferences?.map((reference) => reference.source)).toContain('ai')

    const diagnosis = buildAIDiagnosisContext(buildFingerprintHealthModel(signals))
    const proposals = buildRepairProposals(diagnosis)
    const timezoneProposal = proposals.find((proposal) => proposal.signalKey === 'runtime-timezone')
    const gpuProposal = proposals.find((proposal) => proposal.signalKey === 'runtime-webgl-renderer')

    expect(diagnosis.protectedUserOverrides).toBe(1)
    expect(timezoneProposal?.protectedByUserOverride).toBe(true)
    expect(timezoneProposal?.automatedRepairAllowed).toBe(false)
    expect(timezoneProposal?.actions.at(-1)).toContain('不会')
    expect(gpuProposal?.protectedByUserOverride).toBe(false)
    expect(gpuProposal?.automatedRepairAllowed).toBe(true)
  })

  it('blocks repair workflows that would mutate user-owned configuration', () => {
    const workflow = approveRepairWorkflow(createRepairWorkflow([
      {
        id: 'timezone',
        component: 'locale',
        description: 'change timezone',
        requiresBackup: true,
        reversible: true,
        mutatesConfiguration: true,
        configSources: ['user']
      }
    ]))

    expect(validateRepairSafety(workflow)).toBe(false)
  })

  it('allows confirmed AI-owned repair when rollback is protected by backup', () => {
    const workflow = approveRepairWorkflow(createRepairWorkflow([
      {
        id: 'gpu',
        component: 'gpu',
        description: 'refresh GPU persona',
        requiresBackup: true,
        reversible: false,
        mutatesConfiguration: true,
        configSources: ['ai']
      }
    ]))

    expect(validateRepairSafety(workflow)).toBe(true)
  })
})
