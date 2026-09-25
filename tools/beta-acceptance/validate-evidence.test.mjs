import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateEvidence, validatePolicy } from './validate-evidence.mjs'

const policy = {
  schemaVersion: 1,
  channel: 'beta',
  minimumSoakHoursPerPlatform: 12,
  minimumLaunchesPerPlatform: 50,
  minimumUpdateAttemptsPerPlatform: 3,
  minimumCrashFreeRate: 0.99,
  minimumUpdateSuccessRate: 1,
  phases: [
    { name: 'internal', audiencePercent: 5, minimumHours: 8 },
    { name: 'limited', audiencePercent: 25, minimumHours: 24 },
    { name: 'broad', audiencePercent: 100, minimumHours: 48 }
  ],
  pauseOn: [
    'startup_crash',
    'profile_data_loss',
    'fingerprint_regression',
    'proxy_identity_leak',
    'update_failure',
    'self_healing_loop',
    'attention_patrol_regression'
  ],
  rollbackStrategy: 'publish_newer_recovery_build'
}

const candidate = {
  schemaVersion: 1,
  passed: true,
  channel: 'beta',
  distributionMode: 'signed',
  version: '0.2.0-beta.4'
}

function evidence(requestedPhase = 'internal', completedPhase = null, observedHours = 0) {
  return {
    schemaVersion: 1,
    channel: 'beta',
    version: '0.2.0-beta.4',
    platforms: {
      'darwin-arm64': {
        appE2ePassed: true,
        fingerprintNativePassed: true,
        fingerprintFixedTemplatePassed: true,
        profileDataPassed: true,
        proxyIdentityPassed: true,
        evidenceSha256: 'a'.repeat(64),
        soakHours: 12,
        launches: 50,
        crashes: 0,
        updateAttempts: 3,
        updateSuccesses: 3
      },
      'win32-x64': {
        appE2ePassed: true,
        fingerprintNativePassed: true,
        fingerprintFixedTemplatePassed: true,
        profileDataPassed: true,
        proxyIdentityPassed: true,
        evidenceSha256: 'b'.repeat(64),
        soakHours: 12,
        launches: 50,
        crashes: 0,
        updateAttempts: 3,
        updateSuccesses: 3
      }
    },
    recoveryDrill: {
      reportSha256: 'c'.repeat(64)
    },
    rolloutGate: {
      requestedPhase,
      completedPhase,
      observedHours,
      pauseSignals: []
    }
  }
}

const bundles = {
  'darwin-arm64': { size: 123, sha256: 'a'.repeat(64) },
  'win32-x64': { size: 456, sha256: 'b'.repeat(64) }
}

const recovery = {
  schemaVersion: 1,
  passed: true,
  baselineVersion: '0.2.0-beta.4',
  recoveryVersion: '0.2.0-beta.5',
  signedManifestVerified: true,
  profileDataPreserved: true,
  targets: {
    'darwin-arm64': {
      profileDataPreserved: true,
      identityBaselinePreserved: true,
      settingsPreserved: true,
      launchAfterRecoveryPassed: true
    },
    'win32-x64': {
      profileDataPreserved: true,
      identityBaselinePreserved: true,
      settingsPreserved: true,
      launchAfterRecoveryPassed: true
    }
  }
}

test('accepts the initial rollout phase only after platform and recovery gates pass', () => {
  validatePolicy(policy)
  const report = evaluateEvidence(candidate, evidence(), policy, bundles, recovery, 'c'.repeat(64))
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
  assert.equal(report.rollout.authorizedPhase, 'internal')
  assert.equal(report.platformResults['win32-x64'].crashFreeRate, 1)
  assert.equal(report.platformResults['darwin-arm64'].updateSuccessRate, 1)
})

test('requires prior phase observation before advancing rollout', () => {
  const tooEarly = evaluateEvidence(
    candidate,
    evidence('limited', 'internal', 7.9),
    policy,
    bundles,
    recovery,
    'c'.repeat(64)
  )
  assert.equal(tooEarly.passed, false)
  assert.ok(tooEarly.failures.includes('rollout_gate_observation_time'))

  const ready = evaluateEvidence(
    candidate,
    evidence('limited', 'internal', 8),
    policy,
    bundles,
    recovery,
    'c'.repeat(64)
  )
  assert.equal(ready.passed, true)
  assert.equal(ready.rollout.authorizedPhase, 'limited')
})

test('blocks rollout when soak or update evidence is below policy', () => {
  const value = evidence()
  value.platforms['win32-x64'].soakHours = 11.9
  value.platforms['darwin-arm64'].updateSuccesses = 2
  const report = evaluateEvidence(candidate, value, policy, bundles, recovery, 'c'.repeat(64))
  assert.equal(report.passed, false)
  assert.ok(report.failures.includes('win32-x64:soakHours'))
  assert.ok(report.failures.includes('darwin-arm64:updateSuccessRate'))
})

test('blocks rollout immediately on a known pause signal', () => {
  const value = evidence()
  value.rolloutGate.pauseSignals = ['profile_data_loss']
  const report = evaluateEvidence(candidate, value, policy, bundles, recovery, 'c'.repeat(64))
  assert.equal(report.passed, false)
  assert.ok(report.failures.includes('rollout_paused'))
})

test('rejects recovery evidence that is not newer than the candidate', () => {
  const invalidRecovery = {
    ...recovery,
    recoveryVersion: '0.2.0-beta.4'
  }
  const report = evaluateEvidence(candidate, evidence(), policy, bundles, invalidRecovery, 'c'.repeat(64))
  assert.equal(report.passed, false)
  assert.ok(report.failures.includes('newer_recovery_build_drill'))
})
