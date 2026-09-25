import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSignedBuilderConfig, validateSignedUpdateConfig } = require('./signed-update-config.cjs')

async function signedConfig(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-signed-update-config-'))
  const { publicKey } = generateKeyPairSync('ed25519')
  const path = join(root, 'update-config.json')
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    channel: 'beta',
    distributionMode: 'signed',
    manifestUrl: 'https://updates.example.com/zbrowser/beta/latest.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    ...overrides
  }))
  return { root, path }
}

test('accepts a signed Ed25519 update config and packages it as resources/update-config.json', async () => {
  const fixture = await signedConfig()
  try {
    const validated = validateSignedUpdateConfig(fixture.path)
    assert.equal(validated.value.channel, 'beta')
    assert.equal(validated.value.distributionMode, 'signed')

    const config = createSignedBuilderConfig({ ZBROWSER_UPDATE_CONFIG_PATH: fixture.path })
    const entry = config.extraResources.find((value) => value.to === 'update-config.json')
    assert.deepEqual(entry, { from: fixture.path, to: 'update-config.json' })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('keeps the legacy release environment variable compatible', async () => {
  const fixture = await signedConfig()
  try {
    const config = createSignedBuilderConfig({ PRISM_UPDATE_CONFIG_PATH: fixture.path })
    assert.equal(config.extraResources.at(-1).from, fixture.path)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects internal unsigned config for a signed release build', async () => {
  const fixture = await signedConfig({ distributionMode: 'internal-unsigned' })
  try {
    assert.throws(() => validateSignedUpdateConfig(fixture.path), /Signed update config is invalid/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects non-HTTPS manifest endpoints', async () => {
  const fixture = await signedConfig({ manifestUrl: 'http://updates.example.com/zbrowser/beta/latest.json' })
  try {
    assert.throws(() => validateSignedUpdateConfig(fixture.path), /Signed update config is invalid/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
