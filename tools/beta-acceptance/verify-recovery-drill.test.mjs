import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRecoveryDrill } from './verify-recovery-drill.mjs'

function candidate(version) {
  return {
    schemaVersion: 1,
    passed: true,
    channel: 'beta',
    distributionMode: 'signed',
    version,
    manifestSha256: 'a'.repeat(64),
    artifacts: {
      'darwin-arm64': { sha256: 'b'.repeat(64) },
      'win32-x64': { sha256: 'c'.repeat(64) }
    },
    acceptanceEvidence: {
      'darwin-arm64': { sha256: 'd'.repeat(64) },
      'win32-x64': { sha256: 'e'.repeat(64) }
    }
  }
}

function preservation(fromVersion, toVersion) {
  return {
    schemaVersion: 1,
    passed: true,
    fromVersion,
    toVersion,
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
}

test('accepts a newer signed recovery candidate with preservation evidence', () => {
  const result = verifyRecoveryDrill(
    candidate('0.2.0-beta.4'),
    candidate('0.2.0-beta.5'),
    preservation('0.2.0-beta.4', '0.2.0-beta.5')
  )

  assert.equal(result.passed, true)
  assert.equal(result.baselineVersion, '0.2.0-beta.4')
  assert.equal(result.recoveryVersion, '0.2.0-beta.5')
  assert.equal(result.signedManifestVerified, true)
  assert.equal(result.profileDataPreserved, true)
})

test('rejects a recovery build that is not newer', () => {
  assert.throws(
    () => verifyRecoveryDrill(
      candidate('0.2.0-beta.4'),
      candidate('0.2.0-beta.4'),
      preservation('0.2.0-beta.4', '0.2.0-beta.4')
    ),
    /newer beta version/
  )
})

test('rejects incomplete profile preservation', () => {
  const report = preservation('0.2.0-beta.4', '0.2.0-beta.5')
  report.targets['win32-x64'].identityBaselinePreserved = false

  assert.throws(
    () => verifyRecoveryDrill(
      candidate('0.2.0-beta.4'),
      candidate('0.2.0-beta.5'),
      report
    ),
    /Profile preservation failed/
  )
})
