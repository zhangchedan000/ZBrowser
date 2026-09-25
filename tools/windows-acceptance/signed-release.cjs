#!/usr/bin/env node

const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readFile, readdir, stat, writeFile } = require('node:fs/promises')
const { basename, join, resolve } = require('node:path')
const { promisify } = require('node:util')
const { validateSignedUpdateConfig } = require('../release/signed-update-config.cjs')

const execFileAsync = promisify(execFile)
const projectRoot = resolve(__dirname, '..', '..')

function parseArguments(argv) {
  const options = {
    release: resolve('release'),
    unpacked: '',
    e2e: '',
    updateConfig: '',
    output: resolve('release', 'windows-release-acceptance.json')
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--release') options.release = resolve(argv[++index] ?? '')
    else if (argument === '--unpacked') options.unpacked = resolve(argv[++index] ?? '')
    else if (argument === '--e2e') options.e2e = resolve(argv[++index] ?? '')
    else if (argument === '--update-config') options.updateConfig = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.unpacked) options.unpacked = join(options.release, 'win-unpacked')
  if (!options.e2e || !options.updateConfig) {
    throw new Error('--e2e and --update-config are required')
  }
  return options
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function selectReleaseFiles(names, version) {
  const installer = names.find((name) => name.includes(version) && /\.msi$/i.test(name))
  const portable = names.find((name) => name.includes(version) && /\.exe$/i.test(name) && !/setup/i.test(name))
  const zip = names.find((name) => name.includes(version) && /\.zip$/i.test(name))
  if (!installer || !portable || !zip) {
    throw new Error('Signed Windows release requires versioned MSI, portable EXE and ZIP artifacts')
  }
  return { installer, portable, zip }
}

function updateConfigsMatch(expected, embedded) {
  return expected.schemaVersion === embedded.schemaVersion
    && expected.channel === embedded.channel
    && expected.distributionMode === embedded.distributionMode
    && expected.manifestUrl === embedded.manifestUrl
    && expected.publicKey === embedded.publicKey
}

async function readAuthenticode(path) {
  const command = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:ZBROWSER_SIGN_FILE',
    '[pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { "" }',
    '  timestampThumbprint = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Thumbprint } else { "" }',
    '} | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      env: { ...process.env, ZBROWSER_SIGN_FILE: path },
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
  )
  const value = JSON.parse(stdout.trim())
  return {
    status: value.status,
    thumbprint: value.thumbprint || '',
    timestamped: Boolean(value.timestampThumbprint)
  }
}

function signaturesPass(files) {
  const requiredRoles = new Set(['installer', 'portable', 'app'])
  const roles = new Set(files.map((file) => file.role))
  return files.length >= requiredRoles.size
    && [...requiredRoles].every((role) => roles.has(role))
    && files.every((file) => file.status === 'Valid' && file.timestamped === true && Boolean(file.thumbprint))
}

async function runAcceptance(options) {
  if (process.platform !== 'win32') throw new Error('Signed Windows acceptance must run on Windows')
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const version = packageJson.version
  const names = (await readdir(options.release, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const selected = selectReleaseFiles(names, version)

  const appPath = join(options.unpacked, 'ZBrowser.exe')
  const embeddedConfigPath = join(options.unpacked, 'resources', 'update-config.json')
  const [e2e, expectedConfig, embeddedConfig] = await Promise.all([
    readFile(options.e2e, 'utf8').then(JSON.parse),
    Promise.resolve(validateSignedUpdateConfig(options.updateConfig).value),
    Promise.resolve(validateSignedUpdateConfig(embeddedConfigPath).value)
  ])
  if (e2e?.schemaVersion !== 1 || e2e?.passed !== true || e2e?.appMode !== 'packaged') {
    throw new Error('Packaged-app E2E evidence is missing or did not pass')
  }
  if (!updateConfigsMatch(expectedConfig, embeddedConfig)) {
    throw new Error('Embedded signed update config does not match the release input')
  }

  const signedInputs = [
    { role: 'installer', path: join(options.release, selected.installer) },
    { role: 'portable', path: join(options.release, selected.portable) },
    { role: 'app', path: appPath }
  ]
  const files = []
  for (const item of signedInputs) {
    const info = await stat(item.path)
    if (!info.isFile() || info.size <= 0) throw new Error(`Signed file is missing or empty: ${item.path}`)
    const signature = await readAuthenticode(item.path)
    files.push({
      file: basename(item.path),
      role: item.role,
      status: signature.status,
      timestamped: signature.timestamped,
      thumbprint: signature.thumbprint,
      size: info.size,
      sha256: await sha256(item.path)
    })
  }

  const artifacts = []
  for (const [kind, name] of Object.entries(selected)) {
    const path = join(options.release, name)
    const info = await stat(path)
    artifacts.push({ file: name, kind, size: info.size, sha256: await sha256(path) })
  }

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: signaturesPass(files),
    version,
    target: 'win32-x64',
    updateConfigVerified: true,
    packagedAppE2EVerified: true,
    packagedAppE2ESha256: await sha256(options.e2e),
    files,
    artifacts
  }
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await runAcceptance(options)
  process.stdout.write(`Windows signed release acceptance: ${report.passed ? 'PASS' : 'FAIL'}\n`)
  for (const file of report.files) {
    process.stdout.write(`${file.status === 'Valid' && file.timestamped ? 'PASS' : 'FAIL'}  ${file.role}: ${file.file}\n`)
  }
  process.stdout.write(`Report: ${options.output}\n`)
  if (!report.passed) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  parseArguments,
  selectReleaseFiles,
  signaturesPass,
  updateConfigsMatch,
  runAcceptance
}
