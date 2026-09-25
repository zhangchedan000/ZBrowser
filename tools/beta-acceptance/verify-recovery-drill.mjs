#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = ['darwin-arm64', 'win32-x64']
const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/

function parseArguments(argv) {
  const options = { baseline: '', recovery: '', preservation: '', output: '' }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--baseline') options.baseline = resolve(argv[++index] ?? '')
    else if (argument === '--recovery') options.recovery = resolve(argv[++index] ?? '')
    else if (argument === '--profile-preservation') options.preservation = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.baseline || !options.recovery || !options.preservation || !options.output) {
    throw new Error('--baseline, --recovery, --profile-preservation and --output are required')
  }
  return options
}

function compareVersions(first, second) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(value)
    if (!match) throw new Error(`Invalid beta version: ${value}`)
    return match.slice(1).map(Number)
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function validateSignedCandidate(value, label) {
  if (value?.schemaVersion !== 1
    || value?.passed !== true
    || value?.channel !== 'beta'
    || value?.distributionMode !== 'signed'
    || typeof value?.version !== 'string'
    || !BETA_VERSION.test(value.version)
    || !/^[a-f\d]{64}$/i.test(value.manifestSha256 ?? '')
    || !value.artifacts
    || !value.acceptanceEvidence) {
    throw new Error(`${label} signed candidate report is invalid`)
  }
  for (const target of TARGETS) {
    const artifact = value.artifacts[target]
    const acceptance = value.acceptanceEvidence[target]
    if (!artifact || !acceptance
      || !/^[a-f\d]{64}$/i.test(artifact.sha256 ?? '')
      || !/^[a-f\d]{64}$/i.test(acceptance.sha256 ?? '')) {
      throw new Error(`${label} signed candidate is missing ${target} evidence`)
    }
  }
}

function validatePreservation(value, baselineVersion, recoveryVersion) {
  if (value?.schemaVersion !== 1
    || value?.passed !== true
    || value?.fromVersion !== baselineVersion
    || value?.toVersion !== recoveryVersion
    || !value.targets) {
    throw new Error('Profile preservation report identity is invalid')
  }
  for (const target of TARGETS) {
    const result = value.targets[target]
    if (!result
      || result.profileDataPreserved !== true
      || result.identityBaselinePreserved !== true
      || result.settingsPreserved !== true
      || result.launchAfterRecoveryPassed !== true) {
      throw new Error(`Profile preservation failed for ${target}`)
    }
  }
}

function verifyRecoveryDrill(baseline, recovery, preservation) {
  validateSignedCandidate(baseline, 'Baseline')
  validateSignedCandidate(recovery, 'Recovery')
  if (compareVersions(recovery.version, baseline.version) <= 0) {
    throw new Error('Recovery candidate must use a newer beta version')
  }
  validatePreservation(preservation, baseline.version, recovery.version)

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    baselineVersion: baseline.version,
    recoveryVersion: recovery.version,
    signedManifestVerified: true,
    profileDataPreserved: true,
    targets: Object.fromEntries(TARGETS.map((target) => [target, {
      profileDataPreserved: true,
      identityBaselinePreserved: true,
      settingsPreserved: true,
      launchAfterRecoveryPassed: true
    }]))
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const [baselineText, recoveryText, preservationText] = await Promise.all([
    readFile(options.baseline, 'utf8'),
    readFile(options.recovery, 'utf8'),
    readFile(options.preservation, 'utf8')
  ])
  const report = verifyRecoveryDrill(
    JSON.parse(baselineText),
    JSON.parse(recoveryText),
    JSON.parse(preservationText)
  )
  report.inputs = {
    baselineCandidateSha256: createHash('sha256').update(baselineText).digest('hex'),
    recoveryCandidateSha256: createHash('sha256').update(recoveryText).digest('hex'),
    profilePreservationSha256: createHash('sha256').update(preservationText).digest('hex')
  }
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export {
  compareVersions,
  parseArguments,
  validatePreservation,
  validateSignedCandidate,
  verifyRecoveryDrill
}
