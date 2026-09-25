import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createManifest } from './create-update-manifest.mjs'
import { verifyCandidate } from './verify-update-candidate.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-signed-candidate-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  const notesPath = join(root, 'notes.md')
  const macArtifact = join(root, 'ZBrowser-0.2.0-beta.4-mac-arm64.dmg')
  const winArtifact = join(root, 'ZBrowser-0.2.0-beta.4-win-x64.exe')
  const macAcceptance = join(root, 'macos-release-acceptance.json')
  const winAcceptance = join(root, 'windows-release-acceptance.json')

  await Promise.all([
    writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' })),
    writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' })),
    writeFile(notesPath, '# Beta test\n'),
    writeFile(macArtifact, Buffer.from('signed-macos-candidate')),
    writeFile(winArtifact, Buffer.from('signed-windows-candidate')),
    writeFile(macAcceptance, JSON.stringify({
      schemaVersion: 1,
      passed: true,
      version: '0.2.0-beta.4',
      target: 'darwin-arm64',
      developerTeam: 'TESTTEAM123',
      developerIdVerified: true,
      gatekeeperVerified: true,
      notarizationStapleVerified: true,
      updateConfigVerified: true,
      artifacts: [
        'ZBrowser-0.2.0-beta.4-mac-arm64.dmg',
        'ZBrowser-0.2.0-beta.4-mac-arm64.zip'
      ]
    })),
    writeFile(winAcceptance, JSON.stringify({
      schemaVersion: 1,
      passed: true,
      version: '0.2.0-beta.4',
      target: 'win32-x64',
      updateConfigVerified: true,
      files: [
        { file: 'ZBrowser Setup 0.2.0-beta.4.msi', status: 'Valid', timestamped: true, thumbprint: 'A1' },
        { file: 'ZBrowser 0.2.0-beta.4.exe', status: 'Valid', timestamped: true, thumbprint: 'A1' },
        { file: 'ZBrowser-0.2.0-beta.4-win-x64.zip', status: 'Valid', timestamped: true, thumbprint: 'A1' },
        { file: 'ZBrowser.exe', status: 'Valid', timestamped: true, thumbprint: 'A1' }
      ]
    }))
  ])

  const result = await createManifest({
    channel: 'beta',
    distributionMode: 'signed',
    version: '0.2.0-beta.4',
    privateKey: privateKeyPath,
    notes: notesPath,
    output: join(root, 'manifest.json'),
    artifacts: [
      `darwin-arm64,dmg,${macArtifact},https://updates.example.com/${basename(macArtifact)}`,
      `win32-x64,exe,${winArtifact},https://updates.example.com/${basename(winArtifact)}`
    ],
    allowPartial: false
  })
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(result.manifest, null, 2))

  return {
    root,
    manifestPath,
    publicKeyPath,
    macArtifact,
    winArtifact,
    macAcceptance,
    winAcceptance
  }
}

function verificationOptions(value) {
  return {
    manifest: value.manifestPath,
    publicKey: value.publicKeyPath,
    output: join(value.root, 'candidate-report.json'),
    requireChannel: 'beta',
    artifacts: [
      `darwin-arm64,${value.macArtifact}`,
      `win32-x64,${value.winArtifact}`
    ],
    acceptances: [
      `darwin-arm64,${value.macAcceptance}`,
      `win32-x64,${value.winAcceptance}`
    ]
  }
}

test('verifies an Ed25519-signed beta candidate with both platform acceptances', async () => {
  const value = await fixture()
  try {
    const report = await verifyCandidate(verificationOptions(value))
    assert.equal(report.passed, true)
    assert.equal(report.channel, 'beta')
    assert.equal(report.distributionMode, 'signed')
    assert.equal(report.version, '0.2.0-beta.4')
    assert.match(report.manifestSha256, /^[a-f\d]{64}$/)
    assert.match(report.publicKeySha256, /^[a-f\d]{64}$/)
    assert.equal(Object.keys(report.artifacts).length, 2)
    assert.equal(Object.keys(report.acceptanceEvidence).length, 2)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('rejects an artifact modified after the manifest was signed', async () => {
  const value = await fixture()
  try {
    await writeFile(value.winArtifact, Buffer.from('tampered-windows-candidate'))
    await assert.rejects(
      () => verifyCandidate(verificationOptions(value)),
      /does not match signed manifest/
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('rejects Windows acceptance when a required file is unsigned or untimestamped', async () => {
  const value = await fixture()
  try {
    const acceptance = JSON.parse(await readFile(value.winAcceptance, 'utf8'))
    acceptance.files[0].timestamped = false
    await writeFile(value.winAcceptance, JSON.stringify(acceptance))
    await assert.rejects(
      () => verifyCandidate(verificationOptions(value)),
      /unsigned or untimestamped/
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
