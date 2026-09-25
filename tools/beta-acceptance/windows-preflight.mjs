#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseArguments(argv) {
  const options = { release: '', e2e: '', output: '' }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--release') options.release = resolve(argv[++index] ?? '')
    else if (argument === '--e2e') options.e2e = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.release || !options.e2e || !options.output) {
    throw new Error('--release, --e2e and --output are required')
  }
  return options
}

function artifactKind(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.msi')) return 'msi'
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.exe')) return /setup/i.test(name) ? 'installer-exe' : 'portable-exe'
  return ''
}

async function collectArtifacts(releaseRoot, version) {
  const files = await readdir(releaseRoot, { withFileTypes: true })
  const matches = files
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.includes(version))
    .filter((name) => ['msi', 'zip', 'portable-exe', 'installer-exe'].includes(artifactKind(name)))

  const records = []
  for (const name of matches) {
    const path = join(releaseRoot, name)
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) throw new Error(`Release artifact is empty: ${name}`)
    records.push({
      file: name,
      kind: artifactKind(name),
      size: info.size,
      sha256: await sha256(path)
    })
  }

  const kinds = new Set(records.map((record) => record.kind))
  if (!kinds.has('msi') || !kinds.has('portable-exe') || !kinds.has('zip')) {
    throw new Error('Windows Beta preflight requires MSI, portable EXE and ZIP artifacts')
  }
  return records.sort((first, second) => first.file.localeCompare(second.file))
}

async function runPreflight(options) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const [packageJson, betaRelease, e2e] = await Promise.all([
    readFile(join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'build', 'beta-release.json'), 'utf8').then(JSON.parse),
    readFile(options.e2e, 'utf8').then(JSON.parse)
  ])

  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(packageJson.version ?? '')
    || betaRelease.schemaVersion !== 1
    || betaRelease.channel !== 'beta'
    || betaRelease.version !== packageJson.version
    || betaRelease.status !== 'candidate') {
    throw new Error('Package version and Beta release contract are not synchronized')
  }

  if (e2e.schemaVersion !== 1 || e2e.passed !== true || e2e.appMode !== 'packaged') {
    throw new Error('Packaged-app E2E report is missing or did not pass')
  }

  const artifacts = await collectArtifacts(options.release, packageJson.version)
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    target: 'win32-x64',
    channel: 'beta',
    version: packageJson.version,
    evidenceType: 'unsigned-preflight',
    finalAcceptanceReady: false,
    finalAcceptanceBlockers: [
      'authenticode_signature_not_verified',
      'timestamp_not_verified',
      'signed_update_manifest_not_verified'
    ],
    packagedAppE2E: {
      passed: true,
      reportFile: basename(options.e2e),
      sha256: await sha256(options.e2e)
    },
    artifacts
  }

  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await runPreflight(options)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

export { artifactKind, collectArtifacts, parseArguments, runPreflight }
