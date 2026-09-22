#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const APP_E2E_TOOL_VERSION = 5
const RETRYABLE_CLEANUP_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

function cleanupRetryDelay(attempt) {
  return Math.min(2_000, 100 * (2 ** attempt))
}

async function removeTemporaryTree(path, dependencies = {}) {
  const remove = dependencies.remove ?? rm
  const wait = dependencies.wait ?? delay
  const attempts = dependencies.attempts ?? 12
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await remove(path, { recursive: true, force: true })
      return
    } catch (error) {
      const retryable = RETRYABLE_CLEANUP_CODES.has(error?.code)
      if (!retryable || attempt === attempts - 1) throw error
      await wait(cleanupRetryDelay(attempt))
    }
  }
}

function defaultElectronExecutable() {
  if (process.platform === 'darwin') {
    return resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  }
  if (process.platform === 'win32') return resolve('node_modules/electron/dist/electron.exe')
  return resolve('node_modules/electron/dist/electron')
}

function parseArguments(argv) {
  const options = {
    app: defaultElectronExecutable(),
    browser: '',
    output: resolve('app-e2e.json'),
    packaged: false,
    keepData: false,
    expectedKernelVersions: [],
    installKernelVersion: '',
    requireCustomKernelSurfaces: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--app') options.app = resolve(argv[++index] ?? '')
    else if (argument === '--browser') options.browser = resolve(argv[++index] ?? '')
    else if (argument === '--output') options.output = resolve(argv[++index] ?? '')
    else if (argument === '--packaged') options.packaged = true
    else if (argument === '--keep-data') options.keepData = true
    else if (argument === '--expected-kernel-version') options.expectedKernelVersions.push(argv[++index] ?? '')
    else if (argument === '--install-kernel-version') options.installKernelVersion = argv[++index] ?? ''
    else if (argument === '--require-custom-kernel-surfaces') options.requireCustomKernelSurfaces = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.browser && !options.installKernelVersion) {
    throw new Error('Usage: npm run audit:app-e2e -- (--browser /path/to/Chromium | --install-kernel-version 144.0.7559.132) [--app /path/to/ZBrowser] [--packaged]')
  }
  return options
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a debugging port')
  await new Promise((resolveClose) => server.close(resolveClose))
  return address.port
}

function syntheticUpgradeVersion(version) {
  const major = Number(String(version).split('.')[0])
  return Number.isInteger(major) && major > 0 ? `${major + 1}.0.0.1` : ''
}

function syntheticPreviousVersion(version) {
  const major = Number(String(version).split('.')[0])
  return Number.isInteger(major) && major > 1 ? `${major - 1}.0.0.1` : ''
}
async function startSiteServer() {
  const server = createServer((_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><body><h1>Prism app E2E</h1><input aria-label="E2E input"><button aria-label="E2E button" onclick="document.body.dataset.clicked=\'yes\'">Save</button><script>localStorage.setItem("prism-app-e2e","ready")</script></body></html>')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start local E2E site')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeIdleConnections()
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    }
  }
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.sequence = 0
    this.pending = new Map()
  }
  async open() {
    if (typeof WebSocket !== 'function') throw new Error('App E2E requires Node.js 22 or newer')
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => this.onMessage(event.data))
    this.socket.addEventListener('close', () => this.rejectAll(new Error('App renderer CDP closed')))
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('App renderer CDP connection timed out')), 15_000)
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('App renderer CDP connection failed')) }, { once: true })
    })
  }
  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.sequence
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveCommand(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  onMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
  close() {
    this.socket?.close()
    this.rejectAll(new Error('App renderer CDP closed'))
  }
}

async function waitForRenderer(port, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Prism exited during startup (code=${child.exitCode ?? '-'}, signal=${child.signalCode ?? '-'})`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /Prism Browser|index\.html/i.test(`${item.title} ${item.url}`))
          ?? targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) return target.webSocketDebuggerUrl
      }
    } catch {
      // Electron is still starting.
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Prism renderer')
}

async function evaluate(client, expression, timeoutMs = 30_000) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, timeoutMs)
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed')
  }
  return response.result.value
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(milliseconds)])
  return child.exitCode !== null || child.signalCode !== null
}

async function probeMcpStdio(options, userDataPath, expectedProfileId) {
  const args = options.packaged ? ['--mcp-stdio'] : [resolve('.'), '--mcp-stdio']
  const child = spawn(options.app, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PRISM_E2E: '1',
      PRISM_E2E_USER_DATA: userDataPath
    }
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  let transcript = ''

  const receive = async () => {
    const result = await Promise.race([
      iterator.next(),
      delay(15_000).then(() => { throw new Error('MCP stdio response timed out') })
    ])
    if (result.done) throw new Error('MCP stdio closed before sending a response')
    transcript += result.value + '\n'
    return JSON.parse(result.value)
  }
  const send = (message) => {
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'zbrowser-e2e', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}
  }

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } })
    const discover = await receive()
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } })
    const tools = await receive()
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'profiles_list', arguments: {}, _meta: meta }
    })
    const profiles = await receive()

    const token = (await readFile(join(userDataPath, 'vault', 'local-api.token'), 'utf8')).trim()
    const toolNames = Array.isArray(tools?.result?.tools) ? tools.result.tools.map((tool) => tool?.name).filter(Boolean) : []
    const profileIds = Array.isArray(profiles?.result?.structuredContent?.profiles)
      ? profiles.result.structuredContent.profiles.map((profile) => profile?.id).filter(Boolean)
      : []

    child.stdin.end()
    const cleanExit = await waitForExit(child, 10_000)
    if (!cleanExit) child.kill('SIGKILL')
    return {
      modernDiscovery: Array.isArray(discover?.result?.supportedVersions)
        && discover.result.supportedVersions.includes('2026-07-28')
        && discover.result.resultType === 'complete'
        && tools?.result?.resultType === 'complete'
        && profiles?.result?.resultType === 'complete',
      toolNames,
      profileIds,
      expectedProfileVisible: profileIds.includes(expectedProfileId),
      tokenExposed: Boolean(token && transcript.includes(token)),
      localTokenPathExposed: transcript.includes('local-api.token'),
      cleanExit: cleanExit && child.exitCode === 0
    }
  } catch (error) {
    child.stdin.end()
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL')
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\nMCP stderr:\n${stderr}` : ''}`)
  } finally {
    lines.close()
  }
}

async function launchAppOnce(options, userDataPath) {
  const port = await reservePort()
  const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`]
  if (!options.packaged) args.push(resolve('.'))
  const child = spawn(options.app, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PRISM_E2E: '1',
      PRISM_E2E_USER_DATA: userDataPath,
      PRISM_E2E_BROWSER_HEADLESS: '1',
      ZBROWSER_LOCAL_API_PORT: '0'
    }
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768) })
  try {
    const client = new CdpClient(await waitForRenderer(port, child))
    await client.open()
    let appReady = false
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Prism exited before renderer API became ready (code=${child.exitCode ?? '-'}, signal=${child.signalCode ?? '-'})`)
      }
      try {
        appReady = await evaluate(client, 'Boolean(window.browserApi?.engine) && document.readyState === "complete"')
        if (appReady) break
      } catch {
        // Packaged Electron may still be navigating the renderer target.
      }
      await delay(100)
    }
    if (!appReady) throw new Error('Timed out waiting for app renderer API')
    return { child, client, stderr: () => stderr }
  } catch (error) {
    child.kill('SIGKILL')
    await waitForExit(child, 5_000).catch(() => undefined)
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\nPrism stderr:\n${stderr}` : ''}`)
  }
}

async function launchApp(options, userDataPath) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await launchAppOnce(options, userDataPath)
    } catch (error) {
      lastError = error
      if (attempt < 2) await delay(2_000)
    }
  }
  throw lastError
}

async function quitApp(instance) {
  await evaluate(instance.client, 'window.browserApi.diagnostics.e2eQuit()').catch(() => undefined)
  instance.client.close()
  if (!await waitForExit(instance.child, 15_000)) instance.child.kill('SIGTERM')
  if (!await waitForExit(instance.child, 3_000)) instance.child.kill('SIGKILL')
  await waitForExit(instance.child, 2_000)
}

function draft(name, seed, startUrl) {
  const isWindows = process.platform === 'win32'
  return {
    name,
    note: 'app-e2e',
    group: '端到端',
    tags: ['自动验收'],
    extensionIds: [],
    color: '#5965e8',
    startUrls: [startUrl],
    kernelVersion: '',
    window: { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 },
    proxy: { protocol: 'direct', host: '', username: '', password: '' },
    fingerprint: {
      seed,
      hardwareProfileId: isWindows ? 'windows-host' : 'macos-host',
      platform: isWindows ? 'windows' : 'macos',
      platformVersion: isWindows ? '10.0.0' : '15.0.0',
      brand: 'Chrome',
      brandVersion: '',
      hardwareConcurrency: 8,
      language: 'zh-CN',
      acceptLanguages: 'zh-CN,zh,en-US,en',
      timezone: 'Asia/Shanghai',
      webrtcPolicy: 'proxy_only',
      networkIdentityMode: 'manual',
      proxyExitPolicy: 'block',
      screenWidth: isWindows ? 1920 : 1440,
      screenHeight: isWindows ? 1080 : 900,
      disabledSpoofing: []
    }
  }
}

async function readOwner(userDataPath, id) {
  return JSON.parse(await readFile(join(userDataPath, 'vault', 'profiles', id, 'profile-owner.json'), 'utf8'))
}

async function readLastLaunch(userDataPath, id) {
  return JSON.parse(await readFile(join(userDataPath, 'vault', 'profiles', id, 'runtime', 'last-launch.json'), 'utf8'))
}

async function probeLocalApi(userDataPath, profileId, pageUrl) {
  const vault = join(userDataPath, 'vault')
  const metadata = JSON.parse(await readFile(join(vault, 'local-api.json'), 'utf8'))
  const token = (await readFile(join(vault, 'local-api.token'), 'utf8')).trim()
  if (!metadata?.url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(metadata.url)) {
    throw new Error('Local API metadata did not expose a loopback URL')
  }
  if (token.length < 32) throw new Error('Local API token file is missing or invalid')

  const authorization = { Authorization: 'Bearer ' + token }
  const jsonHeaders = { ...authorization, 'Content-Type': 'application/json' }
  const profilePath = '/api/v1/profiles/' + encodeURIComponent(profileId)
  const unauthorized = await fetch(metadata.url + '/api/v1/health', {
    signal: AbortSignal.timeout(5_000)
  })
  const authorized = await fetch(metadata.url + '/api/v1/profiles', {
    headers: authorization,
    signal: AbortSignal.timeout(5_000)
  })
  const payload = authorized.ok ? await authorized.json() : {}
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : []

  const opened = await fetch(metadata.url + profilePath + '/page/open', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ url: pageUrl }),
    signal: AbortSignal.timeout(15_000)
  })
  const firstSnapshotResponse = await fetch(metadata.url + profilePath + '/page/snapshot', {
    headers: authorization,
    signal: AbortSignal.timeout(10_000)
  })
  const firstSnapshot = firstSnapshotResponse.ok ? await firstSnapshotResponse.json() : {}
  const firstElements = Array.isArray(firstSnapshot.page?.elements) ? firstSnapshot.page.elements : []
  const textbox = firstElements.find((element) => element.role === 'textbox' && element.name === 'E2E input' && typeof element.ref === 'string')

  let typeStatus = 0
  if (textbox?.ref) {
    const typed = await fetch(metadata.url + profilePath + '/page/type', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ref: textbox.ref, text: 'zbrowser-local-api' }),
      signal: AbortSignal.timeout(10_000)
    })
    typeStatus = typed.status
  }

  const secondSnapshotResponse = await fetch(metadata.url + profilePath + '/page/snapshot', {
    headers: authorization,
    signal: AbortSignal.timeout(10_000)
  })
  const secondSnapshot = secondSnapshotResponse.ok ? await secondSnapshotResponse.json() : {}
  const secondElements = Array.isArray(secondSnapshot.page?.elements) ? secondSnapshot.page.elements : []
  const button = secondElements.find((element) => element.role === 'button' && element.name === 'E2E button' && typeof element.ref === 'string')

  let clickStatus = 0
  if (button?.ref) {
    const clicked = await fetch(metadata.url + profilePath + '/page/click', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ref: button.ref }),
      signal: AbortSignal.timeout(10_000)
    })
    clickStatus = clicked.status
  }

  const launchDiagnosticResponse = await fetch(metadata.url + profilePath + '/diagnostics/launch', {
    method: 'POST',
    headers: authorization,
    signal: AbortSignal.timeout(15_000)
  })
  const launchDiagnostic = launchDiagnosticResponse.ok ? await launchDiagnosticResponse.json() : {}

  return {
    unauthorizedStatus: unauthorized.status,
    authorizedStatus: authorized.status,
    profileIds: profiles.map((profile) => profile.id).filter((id) => typeof id === 'string'),
    profileCount: profiles.length,
    pageOpenStatus: opened.status,
    pageSnapshotStatus: firstSnapshotResponse.status,
    textboxFound: Boolean(textbox?.ref),
    typeStatus,
    secondSnapshotStatus: secondSnapshotResponse.status,
    buttonFound: Boolean(button?.ref),
    clickStatus,
    launchDiagnosticStatus: launchDiagnosticResponse.status,
    launchDiagnosticProfileId: launchDiagnostic.profileId,
    launchDiagnosticChecks: Array.isArray(launchDiagnostic.report?.checks)
      ? launchDiagnostic.report.checks.length
      : 0
  }
}

async function connectProfilePage(userDataPath, profileId) {
  const profileData = join(userDataPath, 'vault', 'profiles', profileId, 'user-data')
  const activePortPath = join(profileData, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const active = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/)
      const port = Number(active[0])
      if (!Number.isInteger(port) || port <= 0) throw new Error('invalid DevToolsActivePort')
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`)
      const targets = await response.json()
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /^https?:/i.test(item.url))
        ?? targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) {
        const client = new CdpClient(target.webSocketDebuggerUrl)
        await client.open()
        return client
      }
    } catch {
      // Fingerprint Chromium is still starting.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for profile browser CDP: ${profileId}`)
}

async function probeRuntimeFingerprint(userDataPath, profileId) {
  const client = await connectProfilePage(userDataPath, profileId)
  try {
    return await evaluate(client, `(async () => {
      const uaData = navigator.userAgentData
      const highEntropy = uaData?.getHighEntropyValues
        ? await uaData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList'])
        : {}
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        devicePixelRatio: window.devicePixelRatio,
        window: {
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        },
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          pixelDepth: screen.pixelDepth
        },
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uaData: uaData ? {
          platform: uaData.platform,
          mobile: uaData.mobile,
          brands: uaData.brands,
          architecture: highEntropy.architecture,
          bitness: highEntropy.bitness,
          platformVersion: highEntropy.platformVersion,
          fullVersionList: highEntropy.fullVersionList
        } : null
      }
    })()`)
  } finally {
    client.close()
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await access(options.app)
  if (options.browser) await access(options.browser)
  const root = await mkdtemp(join(tmpdir(), 'prism-app-e2e-'))
  const appData = join(root, 'app-data')
  const vault = join(appData, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'settings.json'), JSON.stringify({
    browserExecutable: options.browser,
    fingerprintKernel: Boolean(options.browser),
    enginePreference: 'auto',
    recycleRetentionDays: 0
  }, null, 2))
  const site = await startSiteServer()
  const syntheticKernelVersion = options.installKernelVersion ? syntheticUpgradeVersion(options.installKernelVersion) : ''
  const previousKernelVersion = options.installKernelVersion ? syntheticPreviousVersion(options.installKernelVersion) : ''
  let first
  let second
  let primaryError
  try {
    first = await launchApp(options, appData)
    // This single renderer transaction intentionally exercises the complete managed-kernel
    // lifecycle. Packaged Windows builds can take longer than the default CDP command timeout
    // while downloading/verifying a kernel and launching the runtime version probe; keep every
    // assertion, but give this long-running transaction enough time to finish.
    const firstRun = await evaluate(first.client, `(async () => {
      const expectedKernelVersions = ${JSON.stringify(options.expectedKernelVersions)}
      const installKernelVersion = ${JSON.stringify(options.installKernelVersion)}
      const syntheticKernelVersion = ${JSON.stringify(syntheticKernelVersion)}
      const previousKernelVersion = ${JSON.stringify(previousKernelVersion)}
      let managedKernelInstall = null
      let remoteCatalog = []
      if (installKernelVersion) {
        remoteCatalog = await window.browserApi.engine.releases()
        if (!remoteCatalog.some(kernel => kernel.version === installKernelVersion)) {
          throw new Error('Requested managed kernel is not present in the release catalog: ' + installKernelVersion)
        }
        managedKernelInstall = await window.browserApi.engine.install(installKernelVersion)
        const health = await window.browserApi.engine.verify(installKernelVersion)
        if (health.status === 'corrupt') throw new Error('Managed kernel failed integrity verification: ' + health.message)
      }
      const kernelCatalog = await window.browserApi.engine.installed()
      let communityKernelActivated = expectedKernelVersions.length === 0
      let proKernelLockedWithoutLicense = expectedKernelVersions.length < 2
      if (expectedKernelVersions[0]) {
        const selected = await window.browserApi.engine.activate(expectedKernelVersions[0])
        communityKernelActivated = selected.version === expectedKernelVersions[0]
      }
      if (expectedKernelVersions[1]) {
        try {
          await window.browserApi.engine.activate(expectedKernelVersions[1])
          proKernelLockedWithoutLicense = false
        } catch {
          proKernelLockedWithoutLicense = true
        }
      }
      const engineStatus = await window.browserApi.engine.status()
      let upgradeFlow = { exercised: false, backupCreated: false, runtimeVersionDiagnosed: false, runtimeFingerprintDiagnosed: false, rollbackRestored: false, checkpointCleared: false }
      if (installKernelVersion && previousKernelVersion) {
        const upgradeProbeDraft = ${JSON.stringify(draft('E2E 内核升级回滚', 300003, site.url))}
        upgradeProbeDraft.kernelVersion = previousKernelVersion
        upgradeProbeDraft.kernelFamily = 'fingerprint-chromium'
        const upgradeProbe = await window.browserApi.profiles.create(upgradeProbeDraft)
        const upgradedResult = await window.browserApi.profiles.upgradeKernel(upgradeProbe.id, installKernelVersion, 'fingerprint-chromium')
        const checkpoint = await window.browserApi.profiles.kernelUpgradeCheckpoint(upgradeProbe.id)
        const runtimeDiagnostic = await window.browserApi.profiles.diagnoseKernelRuntime(upgradeProbe.id)
        const runtimeFingerprintDiagnostic = await window.browserApi.profiles.diagnoseFingerprintRuntime(upgradeProbe.id)
        const rolledBack = await window.browserApi.profiles.rollbackKernelUpgrade(upgradeProbe.id)
        const cleared = await window.browserApi.profiles.kernelUpgradeCheckpoint(upgradeProbe.id)
        upgradeFlow = {
          exercised: true,
          backupCreated: Boolean(checkpoint
            && upgradedResult.checkpoint?.fromVersion === previousKernelVersion
            && checkpoint.fromVersion === previousKernelVersion
            && checkpoint.toVersion === installKernelVersion),
          runtimeVersionDiagnosed: runtimeDiagnostic.ready
            && runtimeDiagnostic.checks.some(check => check.key === 'runtime-user-agent-version' && check.status === 'pass')
            && runtimeDiagnostic.checks.some(check => check.key === 'runtime-ua-ch-version' && check.status === 'pass'),
          runtimeFingerprintDiagnosed: runtimeFingerprintDiagnostic.ready
            && Boolean(runtimeFingerprintDiagnostic.snapshot)
            && runtimeFingerprintDiagnostic.snapshot?.webgl?.available === true
            && Boolean(
              runtimeFingerprintDiagnostic.snapshot?.webgl?.unmaskedRenderer
              || runtimeFingerprintDiagnostic.snapshot?.webgl?.renderer
            )
            && Boolean(
              runtimeFingerprintDiagnostic.snapshot?.webgl?.unmaskedVendor
              || runtimeFingerprintDiagnostic.snapshot?.webgl?.vendor
            )
            && runtimeFingerprintDiagnostic.checks.some(check => check.key === 'runtime-webgl-renderer')
            && Boolean(
              runtimeFingerprintDiagnostic.snapshot?.systemGpu?.glRenderer
              || runtimeFingerprintDiagnostic.snapshot?.systemGpu?.devices?.length
            )
            && runtimeFingerprintDiagnostic.checks.some(check => check.key === 'runtime-system-gpu')
            && runtimeFingerprintDiagnostic.checks.some(check => check.key === 'runtime-language' && check.status === 'pass')
            && runtimeFingerprintDiagnostic.checks.some(check => check.key === 'runtime-timezone' && check.status === 'pass')
            && runtimeFingerprintDiagnostic.checks.some(check => check.key === 'runtime-user-agent-version' && check.status === 'pass'),
          rollbackRestored: upgradedResult.profile?.kernelVersion === installKernelVersion
            && rolledBack.kernelVersion === previousKernelVersion
            && rolledBack.kernelFamily === 'fingerprint-chromium',
          checkpointCleared: cleared === null,
          upgradedVersion: upgradedResult.profile?.kernelVersion,
          rolledBackVersion: rolledBack.kernelVersion,
          runtimeDiagnosticChecks: runtimeDiagnostic.checks,
          runtimeFingerprintDiagnosticChecks: runtimeFingerprintDiagnostic.checks,
          runtimeFingerprintSnapshot: runtimeFingerprintDiagnostic.snapshot
        }
        await window.browserApi.profiles.remove(upgradeProbe.id)
      }
      const a = await window.browserApi.profiles.create(${JSON.stringify(draft('E2E 环境 A', 100001, site.url))})
      const b = await window.browserApi.profiles.create(${JSON.stringify(draft('E2E 环境 B', 200002, site.url))})
      const copy = await window.browserApi.profiles.duplicate(a.id)
      const editedFingerprint = {
        ...a.fingerprint,
        seed: 345678901,
        hardwareProfileId: 'windows-11-rtx4070',
        gpuBucket: 34,
        renderIdentityVersion: 4,
        platform: 'windows',
        platformVersion: '10.0.0',
        brand: 'Chrome',
        brandVersion: '',
        hardwareConcurrency: 16,
        language: 'en-US',
        acceptLanguages: 'en-US,en',
        timezone: 'America/New_York',
        webrtcPolicy: 'proxy_only',
        networkIdentityMode: 'manual',
        proxyExitPolicy: 'block',
        screenWidth: 2560,
        screenHeight: 1440,
        disabledSpoofing: ['canvas', 'audio']
      }
      const editedA = await window.browserApi.profiles.update(a.id, {
        ...a,
        name: 'E2E 环境 A 指纹已修改',
        fingerprint: editedFingerprint
      })
      const updated = await window.browserApi.profiles.update(b.id, { ...b, name: 'E2E 环境 B 已编辑' })
      const launched = await Promise.all([
        window.browserApi.profiles.launch(editedA.id),
        window.browserApi.profiles.launch(updated.id)
      ])
      await new Promise(resolve => setTimeout(resolve, 1500))
      const running = await window.browserApi.profiles.list()
      let runningKernelUpgradeBlocked = false
      try {
        await window.browserApi.profiles.upgradeKernel(editedA.id, syntheticKernelVersion || '999.0.0.1', 'fingerprint-chromium')
      } catch (error) {
        runningKernelUpgradeBlocked = String(error?.message || error).includes('请先关闭浏览器环境再升级内核')
      }
      return {
        a, editedA, updated, copy, kernelCatalog, remoteCatalog, managedKernelInstall, communityKernelActivated, proKernelLockedWithoutLicense,
        engineStatus, upgradeFlow, runningKernelUpgradeBlocked,
        launchedStatuses: launched.map(profile => profile.status),
        runningStatuses: running.filter(profile => [a.id, updated.id].includes(profile.id)).map(profile => profile.status),
        crashHistory: await window.browserApi.profiles.crashHistory(a.id)
      }
    })()`, 120_000)

    const localApiProbe = await probeLocalApi(appData, firstRun.editedA.id, site.url)
    const mcpProbe = await probeMcpStdio(options, appData, firstRun.editedA.id)
    const runtimeFingerprint = await probeRuntimeFingerprint(appData, firstRun.editedA.id)
    const cleanupRun = await evaluate(first.client, `(async () => {
      await window.browserApi.profiles.closeAll()
      const closed = await window.browserApi.profiles.list()
      await window.browserApi.profiles.remove(${JSON.stringify(firstRun.copy.id)})
      return {
        closedStatuses: closed.filter(profile => [${JSON.stringify(firstRun.a.id)}, ${JSON.stringify(firstRun.updated.id)}].includes(profile.id)).map(profile => profile.status),
        remaining: (await window.browserApi.profiles.list()).map(profile => ({ id: profile.id, name: profile.name, seed: profile.fingerprint.seed })),
        trash: await window.browserApi.profiles.trash()
      }
    })()`)
    Object.assign(firstRun, cleanupRun)
    await quitApp(first)
    first = undefined

    const editedLaunch = await readLastLaunch(appData, firstRun.editedA.id)

    second = await launchApp(options, appData)
    const secondRun = await evaluate(second.client, `(async () => ({
      profiles: (await window.browserApi.profiles.list()).map(profile => ({
        id: profile.id,
        name: profile.name,
        seed: profile.fingerprint.seed,
        status: profile.status
      })),
      recovery: await window.browserApi.diagnostics.sessionHealth()
    }))()`)
    await quitApp(second)
    second = undefined

    const owners = await Promise.all(secondRun.profiles.map((profile) => readOwner(appData, profile.id)))
    const runtimeBaseFingerprintVisible = runtimeFingerprint.hardwareConcurrency === 16
      && runtimeFingerprint.devicePixelRatio === 1
      && runtimeFingerprint.screen.colorDepth === 24
      && runtimeFingerprint.screen.pixelDepth === 24
      && runtimeFingerprint.platform === 'Win32'
      && runtimeFingerprint.language === 'en-US'
      && runtimeFingerprint.timezone === 'America/New_York'
    const runtimeCustomKernelHardwareFingerprintVisible = runtimeFingerprint.deviceMemory === 8
      && runtimeFingerprint.screen.width === 2560
      && runtimeFingerprint.screen.height === 1440
      && runtimeFingerprint.uaData?.platform === 'Windows'
      && runtimeFingerprint.uaData?.architecture === 'x86'
      && runtimeFingerprint.uaData?.bitness === '64'
    const runtimeKernelVersion = firstRun.engineStatus?.fingerprintKernel ? firstRun.engineStatus.version : undefined
    const runtimeKernelMajor = runtimeKernelVersion?.split('.')[0]
    const runtimeUserAgentKernelVersionSynced = !runtimeKernelMajor
      || new RegExp(`(?:Chrome|Chromium)/${runtimeKernelMajor}\\.`).test(runtimeFingerprint.userAgent ?? '')
    const runtimeUaChExposed = Boolean(runtimeFingerprint.uaData)
    const runtimeUaChFullVersionSynced = !runtimeKernelVersion
      || !runtimeUaChExposed
      || Boolean(runtimeFingerprint.uaData?.fullVersionList?.some((item) => item.version === runtimeKernelVersion))
    const checks = {
      createdIndependentProfiles: firstRun.a.id !== firstRun.updated.id,
      duplicatedWithNewIdentityAndSeed: firstRun.copy.id !== firstRun.a.id
        && firstRun.copy.fingerprint.seed !== firstRun.a.fingerprint.seed,
      editApplied: firstRun.updated.name === 'E2E 环境 B 已编辑',
      fingerprintEditPersisted: firstRun.editedA.name === 'E2E 环境 A 指纹已修改'
        && firstRun.editedA.fingerprint.seed === 345678901
        && firstRun.editedA.fingerprint.hardwareProfileId === 'windows-11-rtx4070'
        && firstRun.editedA.fingerprint.hardwareConcurrency === 16
        && firstRun.editedA.fingerprint.screenWidth === 2560
        && firstRun.editedA.fingerprint.screenHeight === 1440
        && firstRun.editedA.fingerprint.language === 'en-US'
        && firstRun.editedA.fingerprint.acceptLanguages === 'en-US,en'
        && firstRun.editedA.fingerprint.timezone === 'America/New_York'
        && firstRun.editedA.fingerprint.webrtcPolicy === 'proxy_only'
        && firstRun.editedA.fingerprint.disabledSpoofing.includes('canvas')
        && firstRun.editedA.fingerprint.disabledSpoofing.includes('audio'),
      runtimeHardwareFingerprintVisible: runtimeBaseFingerprintVisible
        && (!options.requireCustomKernelSurfaces || runtimeCustomKernelHardwareFingerprintVisible),
      fingerprintEditReachedLaunchArgs: Array.isArray(editedLaunch.args)
        && editedLaunch.args.includes('--fingerprint-platform=windows')
        && editedLaunch.args.includes('--fingerprint-platform-version=10.0.0')
        && editedLaunch.args.includes('--fingerprint-hardware-concurrency=16')
        && editedLaunch.args.includes('--fingerprint-screen-width=2560')
        && editedLaunch.args.includes('--fingerprint-screen-height=1440')
        && editedLaunch.args.includes('--fingerprint-device-scale-factor=1')
        && editedLaunch.args.includes('--window-size=1200,800')
        && editedLaunch.args.includes('--fingerprint-language=en-US')
        && editedLaunch.args.includes('--lang=en-US')
        && editedLaunch.args.includes('--accept-lang=en-US,en')
        && editedLaunch.args.includes('--timezone=America/New_York')
        && editedLaunch.args.includes('--fingerprint-render-identity=v4')
        && editedLaunch.args.includes('--disable-spoofing=canvas,audio')
        && editedLaunch.args.includes('--disable-non-proxied-udp')
        && editedLaunch.args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp')
        && (!runtimeKernelVersion || editedLaunch.args.includes(`--fingerprint-brand-version=${runtimeKernelVersion}`)),
      runtimeUserAgentKernelVersionSynced,
      runtimeUaChFullVersionSynced,
      localApiRequiresBearerAuth: localApiProbe.unauthorizedStatus === 401,
      localApiProfileListAvailable: localApiProbe.authorizedStatus === 200
        && localApiProbe.profileIds.includes(firstRun.editedA.id)
        && localApiProbe.profileIds.includes(firstRun.updated.id),
      localApiPageOpen: localApiProbe.pageOpenStatus === 200,
      localApiPageSnapshot: localApiProbe.pageSnapshotStatus === 200 && localApiProbe.textboxFound === true,
      localApiPageType: localApiProbe.typeStatus === 200,
      localApiPageClick: localApiProbe.secondSnapshotStatus === 200
        && localApiProbe.buttonFound === true
        && localApiProbe.clickStatus === 200,
      localApiLaunchDiagnostic: localApiProbe.launchDiagnosticStatus === 200
        && localApiProbe.launchDiagnosticProfileId === firstRun.editedA.id
        && localApiProbe.launchDiagnosticChecks > 0,
      mcpStdioModernDiscovery: mcpProbe.modernDiscovery === true,
      mcpStdioToolsAvailable: mcpProbe.toolNames.includes('profiles_list')
        && mcpProbe.toolNames.includes('profile_status')
        && mcpProbe.toolNames.includes('page_snapshot')
        && mcpProbe.toolNames.includes('page_click'),
      mcpStdioLocalApiBridge: mcpProbe.expectedProfileVisible === true,
      mcpStdioSecretsHidden: mcpProbe.tokenExposed === false && mcpProbe.localTokenPathExposed === false,
      mcpStdioCleanExit: mcpProbe.cleanExit === true,
      runningKernelUpgradeBlocked: firstRun.runningKernelUpgradeBlocked === true,
      kernelUpgradeAutoBackupAndRollback: !options.installKernelVersion || (firstRun.upgradeFlow?.exercised === true
        && firstRun.upgradeFlow.backupCreated === true
        && firstRun.upgradeFlow.rollbackRestored === true
        && firstRun.upgradeFlow.checkpointCleared === true),
      kernelUpgradeRuntimeVersionDiagnosed: !options.installKernelVersion || firstRun.upgradeFlow?.runtimeVersionDiagnosed === true,
      kernelUpgradeRuntimeFingerprintDiagnosed: !options.installKernelVersion || firstRun.upgradeFlow?.runtimeFingerprintDiagnosed === true,
      realBrowsersStarted: firstRun.launchedStatuses.every((status) => status === 'running')
        && firstRun.runningStatuses.every((status) => status === 'running'),
      allBrowsersClosed: firstRun.closedStatuses.every((status) => status === 'closed'),
      crashHistoryApiAvailable: Array.isArray(firstRun.crashHistory),
      deletedProfileMovedToTrash: firstRun.trash.some((item) => item.profileId === firstRun.copy.id),
      cleanRestartDetected: secondRun.recovery.previousUnclean === false,
      restartPersistence: secondRun.profiles.length === 2
        && secondRun.profiles.some((profile) => profile.name === 'E2E 环境 A 指纹已修改' && profile.seed === 345678901)
        && secondRun.profiles.some((profile) => profile.name === 'E2E 环境 B 已编辑' && profile.seed === 200002)
        && secondRun.profiles.every((profile) => profile.status === 'closed'),
      ownerMarkersMatch: owners.every((owner, index) => owner.profileId === secondRun.profiles[index].id),
      bundledKernelCatalogVisible: options.expectedKernelVersions.every((version) => firstRun.kernelCatalog
        .some((kernel) => kernel.version === version && kernel.origin === 'bundled')),
      managedKernelInstalled: !options.installKernelVersion
        || (firstRun.managedKernelInstall?.version === options.installKernelVersion
          && firstRun.kernelCatalog.some(kernel => kernel.version === options.installKernelVersion && kernel.installed)),
      managedKernelCatalogAvailable: !options.installKernelVersion
        || firstRun.remoteCatalog.some(kernel => kernel.version === options.installKernelVersion),
      communityKernelActivated: firstRun.communityKernelActivated,
      proKernelLockedWithoutLicense: firstRun.proKernelLockedWithoutLicense
    }
    const report = {
      schemaVersion: 1,
      tool: {
        name: 'app-e2e',
        version: APP_E2E_TOOL_VERSION,
        cleanupContract: 'windows-lock-retry-backoff-v1'
      },
      checkedAt: new Date().toISOString(),
      app: options.app,
      appMode: options.packaged ? 'packaged' : 'development-runtime',
      browser: options.browser || `managed:${options.installKernelVersion}`,
      requireCustomKernelSurfaces: options.requireCustomKernelSurfaces,
      runtimeFingerprint,
      runtimeSurfaceDiagnostics: {
        baseFingerprintVisible: runtimeBaseFingerprintVisible,
        customKernelHardwareFingerprintVisible: runtimeCustomKernelHardwareFingerprintVisible,
        expectedKernelVersion: runtimeKernelVersion,
        userAgentKernelVersionSynced: runtimeUserAgentKernelVersionSynced,
        uaChExposed: runtimeUaChExposed,
        uaChFullVersionSynced: runtimeUaChFullVersionSynced,
        uaChStatus: runtimeUaChExposed ? 'exposed-and-checked' : 'not-exposed-by-runtime'
      },
      localApiDiagnostics: localApiProbe,
      mcpDiagnostics: mcpProbe,
      kernelUpgradeDiagnostics: firstRun.upgradeFlow,
      checks,
      passed: Object.values(checks).every(Boolean),
      retainedDataPath: options.keepData ? root : undefined
    }
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Prism app E2E: ${report.passed ? 'PASS' : 'FAIL'}`)
    for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
    console.log(`App: ${basename(options.app)} (${report.appMode})`)
    console.log(`Report: ${options.output}`)
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (first) await quitApp(first).catch(() => first.child.kill('SIGKILL'))
    if (second) await quitApp(second).catch(() => second.child.kill('SIGKILL'))
    await site.close()
    if (!options.keepData) {
      try {
        await removeTemporaryTree(root)
      } catch (error) {
        if (!primaryError) throw error
        console.error(`App E2E temporary-data cleanup also failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}

export { cleanupRetryDelay, removeTemporaryTree }