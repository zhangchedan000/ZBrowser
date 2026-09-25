import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  parseArguments,
  selectReleaseFiles,
  signaturesPass,
  updateConfigsMatch
} = require('./signed-release.cjs')

test('selects the current ZBrowser MSI, portable EXE and ZIP for one version', () => {
  const files = selectReleaseFiles([
    'ZBrowser Setup 0.2.0-beta.4.msi',
    'ZBrowser 0.2.0-beta.4.exe',
    'ZBrowser-0.2.0-beta.4-win-x64.zip',
    'unrelated.txt'
  ], '0.2.0-beta.4')

  assert.deepEqual(files, {
    installer: 'ZBrowser Setup 0.2.0-beta.4.msi',
    portable: 'ZBrowser 0.2.0-beta.4.exe',
    zip: 'ZBrowser-0.2.0-beta.4-win-x64.zip'
  })
})

test('requires all three signed Windows roles with valid timestamps', () => {
  const valid = [
    { role: 'installer', status: 'Valid', timestamped: true, thumbprint: 'AA' },
    { role: 'portable', status: 'Valid', timestamped: true, thumbprint: 'AA' },
    { role: 'app', status: 'Valid', timestamped: true, thumbprint: 'AA' }
  ]
  assert.equal(signaturesPass(valid), true)
  assert.equal(signaturesPass(valid.filter((item) => item.role !== 'app')), false)
  assert.equal(signaturesPass(valid.map((item) => item.role === 'portable'
    ? { ...item, timestamped: false }
    : item)), false)
})

test('compares the embedded signed update config with the release input', () => {
  const value = {
    schemaVersion: 1,
    channel: 'beta',
    distributionMode: 'signed',
    manifestUrl: 'https://updates.example.com/zbrowser/beta/latest.json',
    publicKey: 'PUBLIC KEY'
  }
  assert.equal(updateConfigsMatch(value, { ...value }), true)
  assert.equal(updateConfigsMatch(value, { ...value, channel: 'stable' }), false)
})

test('requires e2e and signed update config arguments', () => {
  assert.throws(() => parseArguments(['--release', 'release']), /--e2e and --update-config are required/)
})
