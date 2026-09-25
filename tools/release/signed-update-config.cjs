const { createPublicKey } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { isAbsolute, resolve } = require('node:path')
const pkg = require('../../package.json')

function validateSignedUpdateConfig(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    throw new Error('ZBROWSER_UPDATE_CONFIG_PATH is required for a signed release')
  }
  const path = isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.schemaVersion !== 1
    || !['stable', 'beta'].includes(value.channel)
    || value.distributionMode !== 'signed'
    || typeof value.manifestUrl !== 'string'
    || new URL(value.manifestUrl).protocol !== 'https:'
    || typeof value.publicKey !== 'string'
    || createPublicKey(value.publicKey).asymmetricKeyType !== 'ed25519') {
    throw new Error('Signed update config is invalid')
  }
  return { path, value }
}

function createSignedBuilderConfig(environment = process.env) {
  const configuredPath = environment.ZBROWSER_UPDATE_CONFIG_PATH || environment.PRISM_UPDATE_CONFIG_PATH
  const { path } = validateSignedUpdateConfig(configuredPath)
  return {
    ...pkg.build,
    extraResources: [
      ...(Array.isArray(pkg.build.extraResources) ? pkg.build.extraResources : []),
      { from: path, to: 'update-config.json' }
    ]
  }
}

module.exports = { createSignedBuilderConfig, validateSignedUpdateConfig }
