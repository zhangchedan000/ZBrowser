#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const app = resolve('node_modules/electron/dist/electron.exe')
const output = resolve(process.env.ZBROWSER_KERNEL_UI_E2E_OUTPUT ?? 'test-results/kernel-manager-ui.json')

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve renderer debugging port')
  await new Promise((resolveClose) => server.close(resolveClose))
  return address.port
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(timeoutMs)])
  return child.exitCode !== null || child.signalCode !== null
}

async function rendererSocket(port, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('ZBrowser exited before renderer became ready')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) return target.webSocketDebuggerUrl
      }
    } catch {
      // Electron is still starting.
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for ZBrowser renderer')
}

async function openCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('Renderer CDP connection timed out')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Renderer CDP connection failed')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  return {
    async evaluate(expression) {
      const id = ++sequence
      const result = await new Promise((resolveCommand, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Runtime.evaluate timed out'))
        }, 30_000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolveCommand(value) },
          reject: (error) => { clearTimeout(timer); reject(error) }
        })
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed')
      return result.result.value
    },
    close() { socket.close() }
  }
}

async function main() {
  await access(app)
  const dataRoot = await mkdtemp(`${tmpdir()}\\zbrowser-kernel-ui-`)
  const port = await reservePort()
  const child = spawn(app, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, resolve('.')], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PRISM_E2E: '1',
      PRISM_E2E_USER_DATA: dataRoot,
      PRISM_E2E_BROWSER_HEADLESS: '1',
      ZBROWSER_LOCAL_API_PORT: '0'
    }
  })
  let cdp
  try {
    cdp = await openCdp(await rendererSocket(port, child))
    let apiReady = false
    for (let attempt = 0; attempt < 200; attempt += 1) {
      apiReady = await cdp.evaluate('Boolean(window.browserApi?.engine) && document.readyState === "complete"').catch(() => false)
      if (apiReady) break
      await delay(100)
    }
    if (!apiReady) throw new Error('Renderer API did not become ready')

    const checks = await cdp.evaluate(`(async () => {
      const releases = await window.browserApi.engine.releases()
      const catalogRelease = releases.find((release) => release.version === '144.0.7559.132')
      const entry = document.querySelector('button.engine-card')
      if (!entry) return { entryVisible: false, modalVisible: false, controlsVisible: false }
      entry.click()
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const text = document.querySelector('.ant-modal')?.textContent ?? ''
        if (text.includes('浏览器内核') && text.includes('Fingerprint Chromium') && text.includes('刷新版本')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const modal = document.querySelector('.ant-modal')
      const text = modal?.textContent ?? ''
      modal?.querySelector('button.ant-modal-close')?.click()

      const automationEntry = [...document.querySelectorAll('button.sidebar-action')]
        .find((button) => button.textContent?.includes('自动化 API'))
      automationEntry?.click()
      let automationText = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        automationText = [...document.querySelectorAll('.ant-modal')]
          .map((item) => item.textContent ?? '')
          .find((value) => value.includes('本机自动化 API')) ?? ''
        if (automationText.includes('127.0.0.1') && automationText.includes('Token 文件')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const automationModal = [...document.querySelectorAll('.ant-modal')]
        .find((item) => (item.textContent ?? '').includes('本机自动化 API'))
      automationModal?.querySelector('button.ant-modal-close')?.click()

      return {
        entryVisible: true,
        modalVisible: text.includes('浏览器内核') && text.includes('Fingerprint Chromium'),
        controlsVisible: text.includes('刷新版本') && text.includes('导入本地构建'),
        catalogReleaseAvailable: Boolean(catalogRelease?.remoteAvailable),
        catalogSha256Valid: /^[a-f\\d]{64}$/i.test(catalogRelease?.sha256 ?? ''),
        catalogReleaseVisible: text.includes('Chromium 144.0.7559.132') && text.includes('开源发行版'),
        installStateVisible: catalogRelease?.installed ? text.includes('已安装') : text.includes('下载并安装'),
        automationEntryVisible: Boolean(automationEntry),
        automationModalVisible: automationText.includes('本机自动化 API 正在运行'),
        automationLoopbackVisible: automationText.includes('127.0.0.1'),
        automationTokenPathVisible: automationText.includes('local-api.token'),
        automationTokenNotExposed: !automationText.includes('Authorization: Bearer ey')
      }
    })()`)
    const passed = Object.values(checks).every(Boolean)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify({ checkedAt: new Date().toISOString(), checks, passed }, null, 2)}\n`)
    for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!passed) throw new Error('Kernel Manager UI smoke failed')
  } finally {
    if (cdp) {
      await cdp.evaluate('window.browserApi?.diagnostics?.e2eQuit?.()').catch(() => undefined)
      cdp.close()
    }
    if (!await waitForExit(child, 10_000)) child.kill('SIGTERM')
    if (!await waitForExit(child, 3_000)) child.kill('SIGKILL')
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
