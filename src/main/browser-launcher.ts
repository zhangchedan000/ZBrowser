import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { BrowserCrashRecord, BrowserProfile, FingerprintRuntimeDiagnosticReport, LaunchDiagnosticCheck, LaunchDiagnosticReport, ProfileLaunchOptions, ProxyConfig, ProxyPoolEntry, ProxyTestResult } from '../shared/types'
import { locateBrowserForProfile } from './browser-locator'
import { buildLaunchArgs } from './launch-args'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { closeProxyBridge, openProxyBridge } from './proxy-bridge'
import type { Logger } from './app-logger'
import type { ExtensionStore } from './extension-store'
import { findManagedProcess, SystemProcessInspector, type ProcessInspector } from './process-inspector'
import { assertFingerprintKernelCompatibility } from '../shared/fingerprint-consistency'
import { safeErrorText } from './redaction'
import { hardwareProfile, hardwareProfileSummary } from '../shared/hardware-profiles'
import { hostHardwareSnapshot } from './host-hardware'
import { classifyProxyFailure, testProxy } from './proxy-tester'
import { GEOIP_CONFLICT_CONFIRMATION_PREFIX, hasCompleteProxyIdentity, proxyLaunchError } from '../shared/network-identity'
import { sameProxyIdentity } from './profile-secrets'
import { BrowserControlSession, PipeCdpTransport, WebSocketCdpTransport } from './browser-control-session'
import { buildRuntimeFingerprintChecks } from '../shared/runtime-fingerprint-diagnostics'
import { buildRuntimeIdentitySnapshot } from '../shared/runtime-identity-snapshot'
import { evaluateIdentityIntentConsistency, identityIntentConsistencyChecks } from '../shared/identity-intent-consistency'
import { resolveIdentityRepairStrategy } from '../shared/identity-repair-strategy'
import { selectBestProxyPoolEntryForCountry } from './proxy-pool-selection'
import { IdentityBaselineStore } from './identity-baseline-store'
import { evaluateRuntimeIdentity } from './identity-drift-runtime'
import { buildIdentityDriftIntelligence } from '../shared/identity-drift-health'
import { IdentityHealthHistoryStore } from './identity-health-history'
import { summarizeIdentityHealthTrend } from '../shared/identity-health-trend'
import type { Readable, Writable } from 'node:stream'

type ProxyTester = (config: ProxyConfig) => Promise<ProxyTestResult>

interface InternalProfileLaunchOptions extends ProfileLaunchOptions {
  /** Internal-only: starts Chromium headlessly with a secure CDP pipe for version checks. */
  runtimeVersionProbe?: boolean
  /** Internal-only: starts a normal headed Chromium with a secure CDP pipe for real render/font checks. */
  runtimeFingerprintProbe?: boolean
}

interface RunningBrowser {
  process: ChildProcess
  automation?: BrowserControlSession
  loopbackDebugging: boolean
  proxyUrl?: string
  proxyIdentityIp?: string
  proxyMonitor?: ReturnType<typeof setInterval>
  proxyMonitorRunning: boolean
  identityMonitor?: ReturnType<typeof setInterval>
  identityMonitorRunning: boolean
  proxyQuarantined: boolean
  proxyIdentityMismatch: boolean
  expectedExit: boolean
  exited: Promise<void>
  proxyFailureTimes: number[]
  proxyWarningIssued: boolean
  finalize: (status: 'closed' | 'error', lastError?: string) => Promise<void>
}

export interface LauncherRuntimeSnapshot {
  managedProcesses: number
  orphanProcesses: number
  launchOperations: number
  closeOperations: number
  activeLaunches: number
  queuedLaunches: number
  closingAll: boolean
}

export interface LocalApiProfileRuntime {
  status: BrowserProfile['status']
  pid?: number
  cdp?: {
    port: number
    httpUrl: string
    webSocketDebuggerUrl?: string
  }
}

export type { BrowserCrashRecord } from '../shared/types'

const MAX_PROFILE_CRASH_RECORDS = 20
const MAX_CLOSE_ALL_ROUNDS = 4
const MAX_STAGNANT_CLOSE_ALL_ROUNDS = 2

function validCrashHistory(value: unknown): BrowserCrashRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((record): record is BrowserCrashRecord => Boolean(
    record && typeof record === 'object'
    && typeof (record as BrowserCrashRecord).occurredAt === 'string'
    && ((record as BrowserCrashRecord).code === null || typeof (record as BrowserCrashRecord).code === 'number')
    && ((record as BrowserCrashRecord).signal === null || typeof (record as BrowserCrashRecord).signal === 'string')
    && ['starting', 'running'].includes((record as BrowserCrashRecord).phase)
  )).slice(-MAX_PROFILE_CRASH_RECORDS)
}

export class BrowserLauncher {
  private readonly processes = new Map<string, RunningBrowser>()
  private readonly orphanProcesses = new Map<string, number>()
  private readonly launchOperations = new Map<string, Promise<BrowserProfile>>()
  private readonly closeOperations = new Map<string, Promise<BrowserProfile>>()
  private activeLaunches = 0
  private readonly launchWaiters: Array<() => void> = []
  private closeAllOperation?: Promise<void>

  constructor(
    private readonly profiles: ProfileStore,
    private readonly settings: SettingsStore,
    private readonly onChanged: (profile: BrowserProfile) => void,
    private readonly extensions: ExtensionStore,
    private readonly logger?: Logger,
    private readonly processInspector: ProcessInspector = new SystemProcessInspector(),
    private readonly proxyTester: ProxyTester = testProxy,
    private readonly maxConcurrentLaunches = 3,
    private readonly browserSpawner: typeof spawn = spawn,
    private readonly proxyMonitorIntervalMs = 5 * 60_000,
    private readonly proxyPoolRecorder?: {
      recordResult(id: string, result: ProxyTestResult): Promise<unknown>
      list?(): ProxyPoolEntry[]
    },
    private readonly identityMonitorIntervalMs = 5 * 60_000
  ) {
    if (!Number.isInteger(maxConcurrentLaunches) || maxConcurrentLaunches < 1 || maxConcurrentLaunches > 20) {
      throw new Error('浏览器并发启动数必须在 1 到 20 之间')
    }
    if (!Number.isInteger(proxyMonitorIntervalMs) || proxyMonitorIntervalMs < 10) {
      throw new Error('代理出口复检间隔不能小于 10 毫秒')
    }
    if (!Number.isInteger(identityMonitorIntervalMs) || identityMonitorIntervalMs < 10) {
      throw new Error('身份监控间隔不能小于 10 毫秒')
    }
  }

  async initialize(): Promise<void> {
    let systemProcesses
    try {
      systemProcesses = await this.processInspector.list()
    } catch (error) {
      this.logger?.error('启动时无法扫描 Chromium 遗留进程', error)
      await Promise.allSettled(this.profiles.list().map(async (profile) => {
          const processMarker = join(this.profiles.profileRuntimePath(profile.id), 'process.json')
          const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false)
          if (!hadProcessMarker && (profile.status === 'closed' || profile.status === 'error')) return
          const next = await this.profiles.setRuntime(profile.id, {
            status: 'error',
            lastError: '应用重启后无法扫描系统进程，请先执行启动诊断再重新打开环境'
          })
          this.onChanged(next)
        }))
      return
    }
    for (const profile of this.profiles.list()) {
      const process = findManagedProcess(systemProcesses, this.profiles.profileDataPath(profile.id))
      if (process) {
        this.orphanProcesses.set(profile.id, process.pid)
        await this.profiles.setRuntime(profile.id, {
          status: 'orphaned',
          lastError: `检测到上次异常退出遗留的浏览器进程（PID ${process.pid}）`
        })
        this.logger?.error('检测到遗留浏览器进程', { profileId: profile.id, pid: process.pid })
      } else {
        const processMarker = join(this.profiles.profileRuntimePath(profile.id), 'process.json')
        const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false)
        await rm(processMarker, { force: true })
        if (hadProcessMarker || (profile.status !== 'closed' && profile.status !== 'error')) {
          const next = await this.profiles.setRuntime(profile.id, {
            status: 'error',
            lastError: '上次运行未正常结束，但当前未发现占用数据目录的浏览器进程'
          })
          this.onChanged(next)
          this.logger?.error('浏览器环境状态已从异常中断中恢复', { profileId: profile.id })
        }
      }
    }
  }

  async launch(id: string, options: InternalProfileLaunchOptions = {}): Promise<BrowserProfile> {
    if (this.closeAllOperation) throw new Error('正在关闭全部浏览器环境，请等待操作完成后再启动')
    const existing = this.launchOperations.get(id)
    if (existing) return existing
    const operation = (async () => {
      const closing = this.closeOperations.get(id)
      if (closing) await closing.catch(() => undefined)
      return this.withLaunchSlot(() => this.launchProfile(id, options))
    })()
    this.launchOperations.set(id, operation)
    try {
      return await operation
    } finally {
      if (this.launchOperations.get(id) === operation) this.launchOperations.delete(id)
    }
  }

  private async launchProfile(id: string, options: InternalProfileLaunchOptions): Promise<BrowserProfile> {
    if (this.processes.has(id)) return this.profiles.get(id)
    if (this.orphanProcesses.has(id)) throw new Error('该环境仍有异常遗留进程，请先点击“结束遗留”')
    let profile = this.profiles.get(id)
    await this.guardProfileAvailable(id)
    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion, profile.kernelFamily)
    if (!engine.executable) {
      throw new Error(profile.kernelVersion
        ? `环境绑定的内核 ${profile.kernelVersion} 不可用，请先安装该版本或修改环境配置`
        : '没有找到浏览器内核，请先选择 Fingerprint Chromium 可执行文件')
    }
    if (profile.proxy.protocol !== 'direct') profile = await this.refreshProxyForLaunch(profile, options.allowGeoConflict === true)
    const hostHardware = hostHardwareSnapshot()
    const selectedHardware = hardwareProfile(profile.fingerprint.hardwareProfileId)
    if (selectedHardware?.hostMatched && selectedHardware.platform !== hostHardware.platform) {
      throw new Error(`${selectedHardware.label} 只能在对应系统上使用；请改用本机模板或成套模拟模板`)
    }
    assertFingerprintKernelCompatibility(profile, engine)
    this.logger?.info('准备启动浏览器环境', { profileId: id, engine: engine.label })

    this.onChanged(await this.profiles.setRuntime(id, { status: 'starting', lastError: undefined }))
    let localProxyUrl: string | undefined
    try {
      localProxyUrl = await openProxyBridge(profile.proxy, {
        onFailure: (error) => {
          void this.noteProxyBridgeFailure(id, error).catch((callbackError) => {
            this.logger?.error('记录代理桥失败状态时出错', {
              profileId: id,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError)
            })
          })
        },
        onTraffic: () => {
          void this.noteProxyBridgeTraffic(id).catch((error) => {
            this.logger?.error('记录代理桥恢复状态时出错', {
              profileId: id,
              error: error instanceof Error ? error.message : String(error)
            })
          })
        }
      })
      const runtimePath = this.profiles.profileRuntimePath(id)
      await mkdir(runtimePath, { recursive: true })
      const args = buildLaunchArgs(profile, {
        userDataDir: this.profiles.profileDataPath(id),
        proxyUrl: localProxyUrl,
        extensionPaths: this.extensions.paths(profile.extensionIds),
        engineVersion: engine.version,
        fingerprintKernel: engine.fingerprintKernel,
        hostHardwareConcurrency: hostHardware.hardwareConcurrency,
        hostPlatformVersion: hostHardware.platformVersion,
        proxyIdentity: profile.proxyCheck,
        allowGeoConflict: options.allowGeoConflict === true,
        startUrls: options.startUrls
      })
      const e2eEnabled = process.env.ZBROWSER_E2E === '1' || process.env.PRISM_E2E === '1'
      const e2eHeadless = process.env.ZBROWSER_E2E_BROWSER_HEADLESS === '1' || process.env.PRISM_E2E_BROWSER_HEADLESS === '1'
      if (e2eEnabled && e2eHeadless) {
        args.push('--headless=new')
        if (options.runtimeFingerprintProbe) {
          // CI must exercise the WebGL read/compare chain even without a physical GPU.
          // Force an explicit software adapter so vendor/renderer are observable; the
          // diagnostic layer still treats these surfaces as non-representative warnings.
          args.push('--enable-webgl')
          args.push('--ignore-gpu-blocklist')
          args.push('--enable-unsafe-swiftshader')
          args.push('--use-angle=swiftshader')
        }
        if (process.platform === 'darwin') args.push('--use-mock-keychain')
      }
      if (options.runtimeVersionProbe && !args.includes('--headless=new')) args.push('--headless=new')
      const pipeControlEnabled = process.platform !== 'win32'
        || options.runtimeVersionProbe === true
        || options.runtimeFingerprintProbe === true
      const loopbackDebugging = process.platform === 'win32' && !pipeControlEnabled
      const devToolsActivePortPath = join(this.profiles.profileDataPath(id), 'DevToolsActivePort')
      if (pipeControlEnabled) {
        args.push('--remote-debugging-pipe')
      } else if (loopbackDebugging) {
        // Local API / Playwright / Puppeteer integration uses Chromium's ephemeral
        // debugging port, but it is bound to loopback only and never exposed on LAN.
        args.push('--remote-debugging-address=127.0.0.1')
        args.push('--remote-debugging-port=0')
        await rm(devToolsActivePortPath, { force: true })
      }
      await writeFile(
        join(runtimePath, 'last-launch.json'),
        JSON.stringify({ executable: engine.executable, args, launchedAt: new Date().toISOString() }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      )

      const child = this.browserSpawner(engine.executable, args, {
        stdio: pipeControlEnabled ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore',
        windowsHide: false,
        env: { ...process.env }
      })
      let automation: BrowserControlSession | undefined
      if (pipeControlEnabled && Array.isArray(child.stdio)) {
        const writable = child.stdio[3] as Writable | null
        const readable = child.stdio[4] as Readable | null
        if (readable && writable) automation = new BrowserControlSession(new PipeCdpTransport(readable, writable))
      }
      let resolveExited!: () => void
      const exited = new Promise<void>((resolve) => { resolveExited = resolve })
      let resolveStarted!: () => void
      let rejectStarted!: (error: Error) => void
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve
        rejectStarted = reject
      })
      let startSettled = false
      const markStarted = (): void => {
        if (startSettled) return
        startSettled = true
        resolveStarted()
      }
      const markStartFailed = (error: unknown): void => {
        if (startSettled) return
        startSettled = true
        rejectStarted(error instanceof Error ? error : new Error(String(error)))
      }
      let finalized = false

      const finalize = async (status: 'closed' | 'error', lastError?: string): Promise<void> => {
        if (finalized) return
        finalized = true
        automation?.close()
        if (running?.proxyMonitor) clearInterval(running.proxyMonitor)
        if (running?.identityMonitor) clearInterval(running.identityMonitor)
        this.processes.delete(id)
        this.orphanProcesses.delete(id)
        try {
          const cleanup = await Promise.allSettled([
            closeProxyBridge(localProxyUrl),
            rm(join(runtimePath, 'process.json'), { force: true }),
            ...(running?.loopbackDebugging ? [rm(devToolsActivePortPath, { force: true })] : [])
          ])
          for (const result of cleanup) {
            if (result.status === 'rejected') {
              this.logger?.error('浏览器退出资源清理失败', {
                profileId: id,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason)
              })
            }
          }
          const next = await this.profiles.setRuntime(id, { status, lastError })
          this.onChanged(next)
        } catch (error) {
          this.logger?.error('浏览器退出状态持久化失败', {
            profileId: id,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          resolveExited()
        }
      }
      const running: RunningBrowser = {
        process: child,
        automation,
        loopbackDebugging,
        proxyUrl: localProxyUrl,
        proxyIdentityIp: profile.proxyCheck?.ip,
        proxyMonitorRunning: false,
        identityMonitorRunning: false,
        proxyQuarantined: false,
        proxyIdentityMismatch: false,
        expectedExit: false,
        exited,
        proxyFailureTimes: [],
        proxyWarningIssued: false,
        finalize
      }
      this.processes.set(id, running)

      child.once('spawn', () => {
        void (async () => {
          try {
            this.logger?.info('浏览器环境已启动', { profileId: id, pid: child.pid })
            await writeFile(join(runtimePath, 'process.json'), JSON.stringify({
              pid: child.pid,
              executable: engine.executable,
              userDataDir: this.profiles.profileDataPath(id),
              startedAt: new Date().toISOString()
            }, null, 2), { mode: 0o600 })
            let next = await this.profiles.setRuntime(id, {
              status: 'running',
              lastOpenedAt: new Date().toISOString(),
              lastError: undefined
            })
            if (profile.kernelVersion && profile.kernelFamily && engine.version && engine.version !== profile.kernelVersion) {
              next = await this.profiles.advanceKernelFloor(id, engine.version, profile.kernelFamily)
              profile = next
              this.logger?.info('环境已自动推进同主版本内核补丁下限', {
                profileId: id,
                kernelMajor: engine.version.split('.')[0],
                kernelVersion: engine.version
              })
            }
            this.onChanged(next)
            if (localProxyUrl) this.startProxyMonitor(id, profile.proxy)
            if (!options.runtimeVersionProbe && !options.runtimeFingerprintProbe) {
              this.startIdentityMonitor(id, engine)
            }
            markStarted()
          } catch (error) {
            markStartFailed(error)
            running.expectedExit = true
            child.kill('SIGTERM')
            await finalize('error', safeErrorText(error))
          }
        })()
      })

      child.once('error', (error) => {
        this.logger?.error('浏览器进程启动失败', { profileId: id, error: error.message })
        markStartFailed(error)
        void finalize('error', error.message)
      })

      child.once('exit', (code, signal) => {
        const unexpected = !running.expectedExit && code !== 0
        const phase: BrowserCrashRecord['phase'] = startSettled ? 'running' : 'starting'
        if (!startSettled) {
          this.logger?.error('浏览器在启动完成前退出', { profileId: profile.id, code, signal })
          markStartFailed(new Error('浏览器在启动完成前退出，请重试或运行启动诊断'))
        }
        this.logger?.info('浏览器环境已退出', { profileId: id, code, signal, expected: !unexpected })
        void (async () => {
          if (unexpected) {
            await this.recordCrash(id, {
              occurredAt: new Date().toISOString(),
              pid: child.pid,
              code,
              signal,
              phase
            }).catch((error) => {
              this.logger?.error('浏览器崩溃历史写入失败', {
                profileId: id,
                error: error instanceof Error ? error.message : String(error)
              })
            })
          }
          await finalize(
            unexpected ? 'error' : 'closed',
            unexpected ? `浏览器异常退出（code=${code ?? '-'}, signal=${signal ?? '-'}）` : undefined
          )
        })()
      })

      await started
      return this.profiles.get(id)
    } catch (error) {
      this.logger?.error('浏览器环境启动流程失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      await closeProxyBridge(localProxyUrl)
      const safeError = safeErrorText(error)
      const next = await this.profiles.setRuntime(id, {
        status: 'error',
        lastError: safeError
      })
      this.onChanged(next)
      throw new Error(safeError)
    }
  }

  async close(id: string): Promise<BrowserProfile> {
    const existing = this.closeOperations.get(id)
    if (existing) return existing
    const operation = (async () => {
      const launching = this.launchOperations.get(id)
      if (launching) await launching.catch(() => undefined)
      return this.closeProfile(id)
    })()
    this.closeOperations.set(id, operation)
    try {
      return await operation
    } finally {
      if (this.closeOperations.get(id) === operation) this.closeOperations.delete(id)
    }
  }

  private async closeProfile(id: string): Promise<BrowserProfile> {
    const orphanPid = this.orphanProcesses.get(id)
    if (orphanPid) return this.closeOrphan(id, orphanPid)
    const running = this.processes.get(id)
    if (!running) {
      const profile = await this.profiles.setRuntime(id, { status: 'closed', lastError: undefined })
      this.onChanged(profile)
      return profile
    }

    running.expectedExit = true
    this.logger?.info('正在关闭浏览器环境', { profileId: id, pid: running.process.pid })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'stopping', lastError: undefined }))
    running.process.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const forceTimer = setTimeout(() => {
        running.process.kill('SIGKILL')
      }, 5000)
      const giveUpTimer = setTimeout(() => {
        clearTimeout(forceTimer)
        resolve(false)
      }, 8000)
      void running.exited.then(() => {
        clearTimeout(forceTimer)
        clearTimeout(giveUpTimer)
        resolve(true)
      })
    })
    if (!exited && this.processes.get(id) === running) {
      let managedProcess
      try {
        managedProcess = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
      } catch (error) {
        const message = '浏览器关闭超时，且无法重新扫描进程；请稍后重试或执行启动诊断'
        this.onChanged(await this.profiles.setRuntime(id, { status: 'error', lastError: message }))
        this.logger?.error('浏览器关闭超时且进程扫描失败', {
          profileId: id,
          error: error instanceof Error ? error.message : String(error)
        })
        throw new Error(message)
      }
      if (managedProcess) {
        this.processes.delete(id)
        this.orphanProcesses.set(id, managedProcess.pid)
        const message = `浏览器关闭超时，仍检测到占用数据目录的进程（PID ${managedProcess.pid}）`
        const profile = await this.profiles.setRuntime(id, { status: 'orphaned', lastError: message })
        this.onChanged(profile)
        this.logger?.error('浏览器关闭后转为遗留进程', { profileId: id, pid: managedProcess.pid })
        return profile
      }
      await running.finalize('closed')
    }
    return this.profiles.get(id)
  }

  closeAll(): Promise<void> {
    if (this.closeAllOperation) return this.closeAllOperation
    const operation = (async () => {
      const failures = new Map<string, unknown>()
      let stagnantRounds = 0
      for (let round = 0; round < MAX_CLOSE_ALL_ROUNDS; round += 1) {
        const ids = new Set([
          ...this.processes.keys(),
          ...this.orphanProcesses.keys(),
          ...this.launchOperations.keys(),
          ...this.closeOperations.keys()
        ])
        if (!ids.size) return
        const before = this.closeAllState()
        const orderedIds = [...ids].sort()
        const results = await Promise.allSettled(orderedIds.map((id) => this.close(id)))
        results.forEach((result, index) => {
          if (result.status === 'rejected') failures.set(orderedIds[index], result.reason)
          else failures.delete(orderedIds[index])
        })
        const after = this.closeAllState()
        if (!after.length) return
        if (after.join('\n') === before.join('\n')) stagnantRounds += 1
        else stagnantRounds = 0
        if (stagnantRounds >= MAX_STAGNANT_CLOSE_ALL_ROUNDS) break
      }
      const remaining = [...new Set([
        ...this.processes.keys(),
        ...this.orphanProcesses.keys(),
        ...this.launchOperations.keys(),
        ...this.closeOperations.keys()
      ])].sort()
      const causes = remaining.map((id) => failures.get(id) ?? new Error(`环境 ${id} 仍有未结束的浏览器进程`))
      throw new AggregateError(causes, `仍有 ${remaining.length} 个浏览器环境无法关闭，请查看启动诊断或手动结束遗留进程`)
    })()
    this.closeAllOperation = operation
    const clearOperation = (): void => {
      if (this.closeAllOperation === operation) this.closeAllOperation = undefined
    }
    void operation.then(clearOperation, clearOperation)
    return operation
  }

  private closeAllState(): string[] {
    return [
      ...[...this.processes.keys()].map((id) => `managed:${id}`),
      ...[...this.orphanProcesses.keys()].map((id) => `orphan:${id}`),
      ...[...this.launchOperations.keys()].map((id) => `launch:${id}`),
      ...[...this.closeOperations.keys()].map((id) => `close:${id}`)
    ].sort()
  }

  isRunning(id: string): boolean {
    return this.processes.has(id) || this.orphanProcesses.has(id)
      || this.launchOperations.has(id) || this.closeOperations.has(id)
  }

  hasRunning(): boolean {
    return this.processes.size > 0 || this.orphanProcesses.size > 0
      || this.launchOperations.size > 0 || this.closeOperations.size > 0
  }

  async openPage(id: string, url: string): Promise<{ url: string; title: string; readyState: string }> {
    await this.launch(id)
    return (await this.controlSession(id)).open(url)
  }

  async pageSnapshot(id: string): ReturnType<BrowserControlSession['snapshot']> {
    return (await this.controlSession(id)).snapshot()
  }

  async clickPageElement(id: string, ref: string): ReturnType<BrowserControlSession['click']> {
    return (await this.controlSession(id)).click(ref)
  }

  async typePageElement(id: string, ref: string, text: string, clear = true): ReturnType<BrowserControlSession['type']> {
    return (await this.controlSession(id)).type(ref, text, clear)
  }

  async testProfileProxy(id: string): Promise<BrowserProfile> {
    const testedProfile = this.profiles.get(id)
    const result = await this.proxyTester(testedProfile.proxy)
    await this.recordProxyPoolResult(testedProfile, result)
    const current = this.profiles.get(id)
    if (!sameProxyIdentity(testedProfile.proxy, current.proxy) || testedProfile.proxy.password !== current.proxy.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    const profile = await this.profiles.setProxyCheck(id, { ...result, checkedAt: new Date().toISOString() })
    this.onChanged(profile)
    return profile
  }

  runtimeSnapshot(): LauncherRuntimeSnapshot {
    return {
      managedProcesses: this.processes.size,
      orphanProcesses: this.orphanProcesses.size,
      launchOperations: this.launchOperations.size,
      closeOperations: this.closeOperations.size,
      activeLaunches: this.activeLaunches,
      queuedLaunches: this.launchWaiters.length,
      closingAll: Boolean(this.closeAllOperation)
    }
  }

  async localApiRuntime(id: string): Promise<LocalApiProfileRuntime> {
    const profile = this.profiles.get(id)
    const running = this.processes.get(id)
    const runtime: LocalApiProfileRuntime = {
      status: profile.status,
      pid: running?.process.pid ?? this.orphanProcesses.get(id)
    }
    if (!running?.loopbackDebugging) return runtime

    try {
      const lines = (await readFile(join(this.profiles.profileDataPath(id), 'DevToolsActivePort'), 'utf8'))
        .trim()
        .split(/\r?\n/)
      const port = Number(lines[0])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return runtime
      const path = lines[1]?.trim()
      runtime.cdp = {
        port,
        httpUrl: 'http://127.0.0.1:' + port,
        webSocketDebuggerUrl: path?.startsWith('/')
          ? 'ws://127.0.0.1:' + port + path
          : undefined
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.error('读取 Local API CDP 端点失败', { profileId: id, error: safeErrorText(error) })
      }
    }
    return runtime
  }

  private async controlSession(id: string): Promise<BrowserControlSession> {
    const running = this.processes.get(id)
    if (!running) throw new Error('浏览器环境尚未启动')
    if (running.automation) return running.automation
    if (!running.loopbackDebugging) {
      throw new Error('当前浏览器内核没有建立安全页面控制通道，请关闭环境后重新启动')
    }

    let endpoint: string | undefined
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const runtime = await this.localApiRuntime(id)
      endpoint = runtime.cdp?.webSocketDebuggerUrl
      if (endpoint) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!endpoint) throw new Error('浏览器 CDP 调试端点尚未就绪，请稍后重试')

    const transport = await WebSocketCdpTransport.connect(endpoint)
    const current = this.processes.get(id)
    if (current !== running) {
      transport.close()
      throw new Error('浏览器环境已在建立页面控制连接时关闭')
    }
    if (running.automation) {
      transport.close()
      return running.automation
    }
    const session = new BrowserControlSession(transport)
    running.automation = session
    return session
  }

  async crashHistory(id: string): Promise<BrowserCrashRecord[]> {
    this.profiles.get(id)
    try {
      return validCrashHistory(JSON.parse(await readFile(
        join(this.profiles.profileRuntimePath(id), 'crash-history.json'),
        'utf8'
      )))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
      throw error
    }
  }

  async crashHistorySnapshot(): Promise<Record<string, BrowserCrashRecord[]>> {
    return Object.fromEntries(await Promise.all(this.profiles.list().map(async (profile) => [
      profile.id,
      await this.crashHistory(profile.id)
    ] as const)))
  }

  async diagnose(id: string): Promise<LaunchDiagnosticReport> {
    const profile = this.profiles.get(id)
    const checks: LaunchDiagnosticCheck[] = []
    const add = (key: string, label: string, status: LaunchDiagnosticCheck['status'], message: string): void => {
      checks.push({ key, label, status, message })
    }

    if (this.isRunning(id) || !['closed', 'error'].includes(profile.status)) {
      add('process', '进程状态', 'error', profile.status === 'orphaned' ? '存在异常遗留进程，需先结束遗留' : '环境当前正在运行或切换状态')
    } else {
      try {
        const process = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
        add('process', '进程状态', process ? 'error' : 'pass', process ? `数据目录被 PID ${process.pid} 占用` : '未发现数据目录占用')
      } catch {
        add('process', '进程状态', 'error', '无法扫描系统进程，为保护数据不建议启动')
      }
    }

    try {
      await this.profiles.assertProfileDataIdentity(id)
      add('data-identity', '数据目录身份', 'pass', '环境 ID、用户数据目录与运行目录对应一致')
    } catch (error) {
      add('data-identity', '数据目录身份', 'error', error instanceof Error ? error.message : String(error))
    }

    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion, profile.kernelFamily)
    if (!engine.executable) {
      add('engine', '浏览器内核', 'error', engine.label)
    } else {
      try {
        await access(engine.executable, constants.X_OK)
        add('engine', '浏览器内核', engine.fingerprintKernel ? 'pass' : 'warning', engine.fingerprintKernel
          ? `${engine.label}${engine.version ? ` ${engine.version}` : ''} 可执行`
          : `${engine.label} 可执行，但不会应用指纹参数`)
      } catch {
        add('engine', '浏览器内核', 'error', '内核文件不存在、不可执行或权限不足')
      }
      try {
        assertFingerprintKernelCompatibility(profile, engine)
        add('version', '版本一致性', 'pass', engine.fingerprintKernel && engine.version
          ? `UA、UA-CH 与请求头版本将统一使用实际内核 ${engine.version}`
          : '兼容模式使用浏览器自身版本')
      } catch (error) {
        add('version', '版本一致性', 'error', error instanceof Error ? error.message : String(error))
      }
    }

    try {
      const paths = this.extensions.paths(profile.extensionIds)
      await Promise.all(paths.map((path) => access(path)))
      add('extensions', '浏览器扩展', 'pass', paths.length ? `${paths.length} 个扩展配置完整` : '未加载额外扩展')
    } catch (error) {
      add('extensions', '浏览器扩展', 'error', error instanceof Error ? error.message : String(error))
    }

    try {
      const fileSystem = await statfs(this.profiles.profileDataPath(id))
      const availableBytes = fileSystem.bavail * fileSystem.bsize
      const availableMb = Math.floor(availableBytes / 1024 / 1024)
      const status = availableBytes < 200 * 1024 * 1024 ? 'error' : availableBytes < 1024 * 1024 * 1024 ? 'warning' : 'pass'
      add('disk', '数据磁盘', status, `数据目录所在磁盘可用 ${availableMb.toLocaleString()} MB`)
    } catch {
      add('disk', '数据磁盘', 'error', '无法读取数据目录磁盘空间')
    }

    if (profile.proxy.protocol === 'direct') {
      add('proxy', '代理网络', 'warning', '当前使用本地直连网络，多个环境可能共享同一出口 IP')
    } else if (!profile.proxyCheck) {
      add('proxy', '代理网络', 'warning', '代理尚未检测，建议先确认出口 IP 和地区')
    } else if (!profile.proxyCheck.ok) {
      add('proxy', '代理网络', 'error', `最近一次代理检测失败：${safeErrorText(profile.proxyCheck.error ?? '连接失败')}`)
    } else {
      const stale = Date.now() - Date.parse(profile.proxyCheck.checkedAt) > 24 * 60 * 60 * 1000
      const geoConflict = profile.proxyCheck.geoConfidence === 'conflict'
      add('proxy', '代理网络', stale || profile.proxyCheck.degraded ? 'warning' : 'pass',
        `${profile.proxyCheck.ip ?? '代理可用'} · ${profile.proxyCheck.latencyMs} ms${stale ? ' · 结果已超过 24 小时' : ''}${profile.proxyCheck.geoConfidence === 'consensus' ? ' · GeoIP 双源一致' : ''}`)
      if (profile.proxyCheck.exitChanged) {
        add('proxy-exit', '出口稳定性', profile.fingerprint.proxyExitPolicy === 'block' ? 'error' : 'warning',
          `代理出口已从 ${profile.proxyCheck.previousIp ?? '原地址'} 变为 ${profile.proxyCheck.ip ?? '新地址'}`)
      } else {
        add('proxy-exit', '出口稳定性', 'pass', '最近两次检测未发现出口 IP 变化')
      }
      if (geoConflict) {
        add('timezone', '时区一致性', 'warning', `${profile.proxyCheck.geoConflict ?? 'GeoIP 数据源对代理地区或时区判断不一致'}；启动时将要求用户确认风险`)
      } else if (profile.proxyCheck.timezone && profile.proxyCheck.timezone !== profile.fingerprint.timezone) {
        add('timezone', '时区一致性', profile.fingerprint.networkIdentityMode === 'proxy' ? 'pass' : 'warning',
          profile.fingerprint.networkIdentityMode === 'proxy'
            ? `启动时自动使用代理时区 ${profile.proxyCheck.timezone}`
            : `代理为 ${profile.proxyCheck.timezone}，指纹为 ${profile.fingerprint.timezone}`)
      } else {
        add('timezone', '时区一致性', 'pass', '代理地区与指纹时区未发现冲突')
      }
      if (profile.fingerprint.networkIdentityMode === 'proxy') {
        const geoReady = Boolean(profile.proxyCheck.countryCode && profile.proxyCheck.timezone
          && profile.proxyCheck.latitude !== undefined && profile.proxyCheck.longitude !== undefined)
        add('geolocation', '地理身份', geoReady ? (geoConflict ? 'warning' : 'pass') : 'error', geoReady
          ? `${profile.proxyCheck.countryCode} · ${profile.proxyCheck.timezone} · 浏览器位置使用代理城市级坐标`
          : profile.proxyCheck.geoConflict ?? '自动网络身份缺少国家、时区或坐标，请重新检测代理')
      }
    }
    if (profile.proxy.protocol !== 'direct' && profile.fingerprint.webrtcPolicy !== 'proxy_only') {
      add('webrtc', 'WebRTC', 'warning', '当前兼容策略可能暴露代理之外的公网或本地地址')
    } else {
      add('webrtc', 'WebRTC', 'pass', '已启用非代理 UDP 防泄漏策略')
    }
    if (profile.proxy.protocol !== 'direct') {
      add('dns', 'DNS 路由', 'pass', '域名解析、预取与 QUIC 均限制在代理路径，回环地址除外')
      add('ipv6', 'IPv6 路由', 'pass', profile.proxyCheck?.ipVersion === 6
        ? '代理出口已检测为 IPv6，WebRTC 不允许绕过代理'
        : '当前出口为 IPv4，宿主 IPv6 不允许通过 WebRTC 或直连 DNS 旁路')
    }

    const hardware = hardwareProfile(profile.fingerprint.hardwareProfileId)
    const hostPlatform = hostHardwareSnapshot().platform
    if (!hardware) {
      add('hardware', '硬件一致性', 'warning', '旧版自定义组合保持不变；新账号建议改用成套硬件模板')
    } else if (hardware.hostMatched && hardware.platform !== hostPlatform) {
      add('hardware', '硬件一致性', 'error', `${hardware.label} 不能在当前系统上使用`)
    } else if (hardware.platform !== hostPlatform) {
      add('hardware', '硬件一致性', 'warning', `${hardware.label} 与当前 ${hostPlatform === 'windows' ? 'Windows' : 'macOS'} 宿主跨系统；为保护旧环境不会自动改写，但不建议继续用于重要账号`)
      add('rendering', '渲染策略', 'warning', '跨系统 Persona 可能在字体、Emoji、Canvas/WebGL 和系统 UI 细节暴露宿主系统；请运行实际指纹检测确认')
    } else {
      add('hardware', '硬件一致性', 'pass', `${hardware.label} · ${hardwareProfileSummary(hardware.id)}`)
      add('rendering', '渲染策略', 'pass', hardware.hostMatched
        ? 'GPU、字体、Canvas、Audio、ClientRects 使用本机原生结果'
        : `GPU 固定为 ${hardware.gpuModel}；Canvas、Audio、ClientRects 使用稳定原生结果`)
    }

    return {
      profileId: id,
      checkedAt: new Date().toISOString(),
      ready: !checks.some((check) => check.status === 'error'),
      checks
    }
  }

  async diagnoseKernelRuntime(id: string): Promise<LaunchDiagnosticReport> {
    const base = await this.diagnose(id)
    const checks = [...base.checks]
    const add = (key: string, label: string, status: LaunchDiagnosticCheck['status'], message: string): void => {
      checks.push({ key, label, status, message })
    }

    if (!base.ready) {
      add('runtime-version-probe', '升级后运行时版本', 'error', '基础启动诊断未通过，未继续启动浏览器检查 UA / UA-CH')
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks
      }
    }

    const profile = this.profiles.get(id)
    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion, profile.kernelFamily)
    if (!engine.fingerprintKernel || !engine.version) {
      add('runtime-version-probe', '升级后运行时版本', 'error', '当前环境没有可核验版本的 Fingerprint Chromium 内核')
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks
      }
    }

    try {
      await this.launch(id, { startUrls: [], runtimeVersionProbe: true })
      const runtime = await (await this.controlSession(id)).runtimeVersionSnapshot()
      const expectedVersion = engine.version
      const expectedMajor = expectedVersion.split('.')[0]
      const uaMatches = Boolean(expectedMajor)
        && new RegExp(`(?:Chrome|Chromium)/${expectedMajor}\\.`).test(runtime.userAgent)
      add(
        'runtime-user-agent-version',
        'User-Agent 运行时版本',
        uaMatches ? 'pass' : 'error',
        uaMatches
          ? `navigator.userAgent 已与实际内核主版本 ${expectedMajor} 同步`
          : `navigator.userAgent 未体现实际内核主版本 ${expectedMajor}：${safeErrorText(runtime.userAgent || '空值')}`
      )

      if (!runtime.uaChExposed) {
        add('runtime-ua-ch-version', 'UA-CH 运行时版本', 'pass', '当前内核未暴露 navigator.userAgentData，不存在旧 UA-CH 版本泄漏面')
      } else {
        const fullVersionMatch = runtime.fullVersionList.some((item) => item.version === expectedVersion)
        add(
          'runtime-ua-ch-version',
          'UA-CH 运行时版本',
          fullVersionMatch ? 'pass' : 'error',
          fullVersionMatch
            ? `fullVersionList 已与实际内核 ${expectedVersion} 同步`
            : `fullVersionList 未找到实际内核版本 ${expectedVersion}`
        )
      }
    } catch (error) {
      add('runtime-version-probe', '升级后运行时版本', 'error', error instanceof Error ? error.message : String(error))
    } finally {
      if (this.isRunning(id)) {
        await this.close(id).catch((error) => {
          this.logger?.error('运行时版本诊断后关闭浏览器失败', {
            profileId: id,
            error: error instanceof Error ? error.message : String(error)
          })
        })
      }
    }

    return {
      profileId: id,
      checkedAt: new Date().toISOString(),
      ready: !checks.some((check) => check.status === 'error'),
      checks
    }
  }

  async diagnoseFingerprintRuntime(id: string): Promise<FingerprintRuntimeDiagnosticReport> {
    const profile = this.profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') {
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks: [{
          key: 'runtime-fingerprint-probe',
          label: '浏览器实际指纹',
          status: 'error',
          message: '请先关闭当前环境再运行实际指纹检测'
        }]
      }
    }

    const base = await this.diagnose(id)
    if (!base.ready) {
      const blocking = base.checks.filter((check) => check.status === 'error')
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks: blocking.length ? blocking : [{
          key: 'runtime-fingerprint-probe',
          label: '浏览器实际指纹',
          status: 'error',
          message: '基础启动诊断未通过，未继续启动浏览器读取实际指纹'
        }]
      }
    }

    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion, profile.kernelFamily)
    if (!engine.fingerprintKernel || !engine.version) {
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks: [{
          key: 'runtime-fingerprint-probe',
          label: '浏览器实际指纹',
          status: 'error',
          message: '当前环境没有可核验实际指纹的 Fingerprint Chromium 内核'
        }]
      }
    }

    try {
      await this.launch(id, { startUrls: [], runtimeFingerprintProbe: true })
      const snapshot = await (await this.controlSession(id)).runtimeFingerprintSnapshot()
      const e2eHeadless = process.env.ZBROWSER_E2E_BROWSER_HEADLESS === '1'
        || process.env.PRISM_E2E_BROWSER_HEADLESS === '1'
      return await this.evaluateRuntimeFingerprintSnapshot(id, snapshot, engine, !e2eHeadless)
    } catch (error) {
      return {
        profileId: id,
        checkedAt: new Date().toISOString(),
        ready: false,
        checks: [{
          key: 'runtime-fingerprint-probe',
          label: '浏览器实际指纹',
          status: 'error',
          message: error instanceof Error ? error.message : String(error)
        }]
      }
    } finally {
      if (this.isRunning(id)) {
        await this.close(id).catch((error) => {
          this.logger?.error('实际指纹诊断后关闭浏览器失败', {
            profileId: id,
            error: error instanceof Error ? error.message : String(error)
          })
        })
      }
    }
  }

  private async withLaunchSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeLaunches >= this.maxConcurrentLaunches) {
      await new Promise<void>((resolve) => this.launchWaiters.push(resolve))
    }
    this.activeLaunches += 1
    try {
      return await operation()
    } finally {
      this.activeLaunches -= 1
      this.launchWaiters.shift()?.()
    }
  }

  private async recordCrash(id: string, record: BrowserCrashRecord): Promise<void> {
    const path = join(this.profiles.profileRuntimePath(id), 'crash-history.json')
    const temporary = `${path}.tmp`
    const history = [...await this.crashHistory(id), record].slice(-MAX_PROFILE_CRASH_RECORDS)
    await writeFile(temporary, JSON.stringify(history, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rm(path, { force: true })
    await rename(temporary, path)
  }

  private async recordProxyPoolResult(profile: BrowserProfile, result: ProxyTestResult): Promise<void> {
    if (!profile.proxyPoolEntryId || !this.proxyPoolRecorder) return
    await this.proxyPoolRecorder.recordResult(profile.proxyPoolEntryId, result).catch((error) => {
      this.logger?.error('同步代理池健康状态失败', {
        profileId: profile.id,
        proxyPoolEntryId: profile.proxyPoolEntryId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  private async guardProfileAvailable(id: string): Promise<void> {
    await this.profiles.assertProfileDataIdentity(id)
    let process
    try {
      process = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
    } catch (error) {
      this.logger?.error('无法确认环境数据目录是否被占用', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      throw new Error('无法检查浏览器进程占用状态，为保护环境数据已取消启动')
    }
    if (!process) return
    this.orphanProcesses.set(id, process.pid)
    const profile = await this.profiles.setRuntime(id, {
      status: 'orphaned',
      lastError: `环境数据目录正被遗留浏览器进程占用（PID ${process.pid}）`
    })
    this.onChanged(profile)
    throw new Error('环境数据目录正被其他浏览器进程占用，请先结束遗留进程')
  }

  private async refreshProxyForLaunch(profile: BrowserProfile, allowGeoConflict: boolean): Promise<BrowserProfile> {
    const result = await this.proxyTester(profile.proxy)
    await this.recordProxyPoolResult(profile, result)
    const current = this.profiles.get(profile.id)
    if (!sameProxyIdentity(profile.proxy, current.proxy) || profile.proxy.password !== current.proxy.password) {
      throw new Error('启动检测期间代理配置已变更，请重新启动环境')
    }
    const updated = await this.profiles.setProxyCheck(profile.id, { ...result, checkedAt: new Date().toISOString() })
    this.onChanged(updated)
    const error = proxyLaunchError(updated.proxyCheck!, updated.fingerprint.proxyExitPolicy)
    if (error) throw new Error(error)
    if (updated.fingerprint.networkIdentityMode === 'proxy' && updated.proxyCheck?.geoConfidence === 'conflict' && !allowGeoConflict) {
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} ${updated.proxyCheck.geoConflict ?? 'GeoIP 数据源对代理地区判断不一致'}；继续使用可能导致 IP 地区与时区、语言或地理位置不一致，影响指纹效果。是否仍要启动？`)
    }
    if (updated.fingerprint.networkIdentityMode === 'proxy' && !hasCompleteProxyIdentity(updated.proxyCheck, { allowGeoConflict })) {
      throw new Error('代理地理信息不完整，无法生成一致的时区、语言和地理位置；请重新检测或改用手动网络身份')
    }
    if (updated.proxyCheck?.geoConfidence === 'conflict' && allowGeoConflict) {
      this.logger?.error('用户已确认在 GeoIP 数据源冲突下继续启动', {
        profileId: profile.id,
        geoConflict: updated.proxyCheck.geoConflict
      })
    }
    if (updated.proxyCheck?.exitChanged) {
      this.logger?.error('代理出口 IP 已变化但策略允许继续', { profileId: profile.id })
    }
    return updated
  }

  private async noteProxyBridgeFailure(id: string, error: unknown): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.expectedExit || running.proxyWarningIssued) return
    const failureKind = classifyProxyFailure(error)
    if (failureKind === 'unknown') return
    const now = Date.now()
    running.proxyFailureTimes = running.proxyFailureTimes.filter((time) => now - time <= 60_000)
    running.proxyFailureTimes.push(now)
    if (failureKind !== 'authentication' && running.proxyFailureTimes.length < 3) return
    running.proxyWarningIssued = true
    const message = failureKind === 'authentication'
      ? '代理认证在运行期间失败，请检查账号或代理授权；浏览器会继续尝试重连'
      : '代理连接在 60 秒内连续失败，出口网络可能已断开；浏览器会继续尝试重连'
    this.logger?.error('浏览器代理桥运行异常', {
      profileId: id,
      failureKind,
      error: safeErrorText(error)
    })
    if (this.profiles.get(id).fingerprint.proxyExitPolicy === 'block') {
      await this.quarantineProxyNetwork(id, message)
      return
    }
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
  }

  private async noteProxyBridgeTraffic(id: string): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.proxyQuarantined || running.proxyIdentityMismatch) return
    running.proxyFailureTimes = []
    if (!running.proxyWarningIssued) return
    running.proxyWarningIssued = false
    this.logger?.info('浏览器代理桥已恢复传输', { profileId: id })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: undefined }))
  }

  private async evaluateRuntimeFingerprintSnapshot(
    id: string,
    snapshot: import('../shared/types').RuntimeFingerprintSnapshot,
    engine: Awaited<ReturnType<typeof locateBrowserForProfile>>,
    renderSurfacesRepresentative: boolean
  ): Promise<FingerprintRuntimeDiagnosticReport> {
    const current = this.profiles.get(id)
    const checks = buildRuntimeFingerprintChecks(current, snapshot, engine, {
      renderSurfacesRepresentative
    })
    const identity = buildRuntimeIdentitySnapshot({
      runtime: snapshot,
      engine,
      network: current.proxyCheck
    })
    const baselineStore = new IdentityBaselineStore(this.profiles.vaultPath)
    const existingBaseline = await baselineStore.get(id)
    const preliminaryIntentConsistency = evaluateIdentityIntentConsistency({
      intent: current.identityIntent,
      proxyProtocol: current.proxy.protocol,
      proxyCheck: current.proxyCheck,
      runtimeSnapshot: identity.snapshot,
      baselineSnapshot: existingBaseline?.snapshot
    })
    const preliminaryIntentChecks = identityIntentConsistencyChecks(preliminaryIntentConsistency)
    const ready = ![...checks, ...preliminaryIntentChecks].some((check) => check.status === 'error')
    const identityState = await evaluateRuntimeIdentity(
      baselineStore,
      id,
      identity.snapshot,
      current.identityConfigProvenance,
      { allowCreateBaseline: ready }
    )
    const identityIntentConsistency = evaluateIdentityIntentConsistency({
      intent: current.identityIntent,
      proxyProtocol: current.proxy.protocol,
      proxyCheck: current.proxyCheck,
      runtimeSnapshot: identity.snapshot,
      baselineSnapshot: identityState.baseline?.snapshot
    })
    const intentChecks = identityIntentConsistencyChecks(identityIntentConsistency)
    const identityIntelligence = identityState.drift
      ? buildIdentityDriftIntelligence(
          identityState.drift,
          identity.snapshot,
          current.identityConfigProvenance
        )
      : undefined
    const targetCountryCode = identityIntentConsistency.targetCountryCode
    const replacementProxy = targetCountryCode && this.proxyPoolRecorder?.list
      ? selectBestProxyPoolEntryForCountry(
          this.proxyPoolRecorder.list().filter((entry) => entry.id !== current.proxyPoolEntryId),
          targetCountryCode
        )
      : undefined
    const identityRepairStrategy = resolveIdentityRepairStrategy({
      consistency: identityIntentConsistency,
      drift: identityState.drift,
      diagnosis: identityIntelligence?.diagnosis,
      baselineStatus: identityState.baseline?.status,
      replacementProxy: replacementProxy && replacementProxy.check?.countryCode
        ? {
            id: replacementProxy.id,
            name: replacementProxy.name,
            countryCode: replacementProxy.check.countryCode.toUpperCase(),
            score: replacementProxy.score
          }
        : undefined
    })
    const healthHistory = new IdentityHealthHistoryStore(this.profiles.vaultPath)
    const identityHealthTrend = identityState.baseline
      ? summarizeIdentityHealthTrend(await healthHistory.record(id, identityState.drift && identityIntelligence
        ? {
            checkedAt: identity.capturedAt,
            baselineId: identityState.baseline.id,
            score: identityIntelligence.health.score,
            risk: identityIntelligence.health.risk,
            driftDetected: identityState.drift.driftDetected,
            driftSeverity: identityState.drift.severity,
            changeCount: identityState.drift.changes.length
          }
        : {
            checkedAt: identity.capturedAt,
            baselineId: identityState.baseline.id,
            score: 100,
            risk: 'low',
            driftDetected: false,
            driftSeverity: 'low',
            changeCount: 0
          }))
      : undefined

    return {
      profileId: id,
      checkedAt: identity.capturedAt,
      ready,
      snapshot,
      identityCapturedAt: identity.capturedAt,
      identitySnapshot: identity.snapshot,
      identityBaseline: identityState.baseline
        ? {
            id: identityState.baseline.id,
            version: identityState.baseline.version,
            status: identityState.baseline.status,
            lastVerifiedAt: identityState.baseline.lastVerifiedAt
          }
        : undefined,
      identityBaselineCreated: identityState.baselineCreated,
      identityDrift: identityState.drift,
      identityHealth: identityIntelligence?.health,
      identityDiagnosis: identityIntelligence?.diagnosis,
      identityHealthTrend,
      identityIntentConsistency,
      identityRepairStrategy,
      checks: [...checks, ...intentChecks]
    }
  }

  private startIdentityMonitor(
    id: string,
    engine: Awaited<ReturnType<typeof locateBrowserForProfile>>
  ): void {
    const running = this.processes.get(id)
    if (!running || running.identityMonitor || !engine.fingerprintKernel || !engine.version) return

    running.identityMonitor = setInterval(() => {
      void this.monitorRuntimeIdentity(id, engine).catch((error) => {
        this.logger?.error('运行中身份监控失败', {
          profileId: id,
          error: safeErrorText(error)
        })
      })
    }, this.identityMonitorIntervalMs)
    running.identityMonitor.unref()
  }

  private async monitorRuntimeIdentity(
    id: string,
    engine: Awaited<ReturnType<typeof locateBrowserForProfile>>
  ): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.expectedExit || running.identityMonitorRunning) return
    running.identityMonitorRunning = true

    try {
      const snapshot = await (await this.controlSession(id)).runtimeFingerprintSnapshot()
      const report = await this.evaluateRuntimeFingerprintSnapshot(id, snapshot, engine, true)
      this.onChanged(this.profiles.get(id))
      if (!report.identityDrift?.driftDetected) return

      const details = {
        profileId: id,
        severity: report.identityDrift.severity,
        healthScore: report.identityHealth?.score,
        healthRisk: report.identityHealth?.risk,
        changes: report.identityDrift.changes.map((change) => ({
          component: change.component,
          field: change.field,
          severity: change.severity
        }))
      }

      if (report.identityDrift.severity === 'critical' || report.identityDrift.severity === 'high') {
        this.logger?.error('运行中检测到身份漂移', details)
      } else {
        this.logger?.info('运行中检测到身份漂移', details)
      }
    } finally {
      running.identityMonitorRunning = false
    }
  }

  private startProxyMonitor(id: string, proxy: ProxyConfig): void {
    const running = this.processes.get(id)
    if (!running || running.proxyMonitor) return
    running.proxyMonitor = setInterval(() => {
      void this.monitorProxyIdentity(id, proxy).catch((error) => {
        this.logger?.error('运行中代理出口复检失败', {
          profileId: id,
          error: safeErrorText(error)
        })
      })
    }, this.proxyMonitorIntervalMs)
    running.proxyMonitor.unref()
  }

  private async monitorProxyIdentity(id: string, proxy: ProxyConfig): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.expectedExit || running.proxyMonitorRunning || running.proxyQuarantined) return
    running.proxyMonitorRunning = true
    try {
      const current = this.profiles.get(id)
      if (!sameProxyIdentity(proxy, current.proxy) || proxy.password !== current.proxy.password) return
      const result = await this.proxyTester(proxy)
      await this.recordProxyPoolResult(current, result)
      const latest = this.profiles.get(id)
      if (!sameProxyIdentity(proxy, latest.proxy) || proxy.password !== latest.proxy.password) return
      const updated = await this.profiles.setProxyCheck(
        id,
        { ...result, checkedAt: new Date().toISOString() },
        running.proxyIdentityIp
      )
      this.onChanged(updated)
      if (!result.ok) {
        const message = `运行期间代理出口复检失败：${result.error ?? '无法连接代理'}`
        if (updated.fingerprint.proxyExitPolicy === 'block') {
          await this.quarantineProxyNetwork(id, message)
          return
        }
        await this.noteProxyBridgeFailure(id, new Error(result.error ?? result.failureKind ?? '代理出口复检失败'))
        return
      }
      if (!updated.proxyCheck?.exitChanged) {
        if (running.proxyIdentityMismatch && result.ip === running.proxyIdentityIp) {
          running.proxyIdentityMismatch = false
          running.proxyWarningIssued = false
          this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: undefined }))
        }
        return
      }
      running.proxyIdentityMismatch = true
      const message = `运行期间代理出口已从 ${updated.proxyCheck.previousIp ?? '启动地址'} 变为 ${updated.proxyCheck.ip ?? '新地址'}，当前浏览器网络身份已不一致`
      this.logger?.error('运行期间代理出口发生变化', { profileId: id })
      if (updated.fingerprint.proxyExitPolicy === 'block') {
        await this.quarantineProxyNetwork(id, message)
      } else {
        running.proxyWarningIssued = true
        this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
      }
    } finally {
      running.proxyMonitorRunning = false
    }
  }

  private async quarantineProxyNetwork(id: string, reason: string): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.proxyQuarantined) return
    running.proxyQuarantined = true
    running.proxyWarningIssued = true
    if (running.proxyMonitor) {
      clearInterval(running.proxyMonitor)
      running.proxyMonitor = undefined
    }
    await closeProxyBridge(running.proxyUrl)
    const message = `${reason}；已停止该环境的代理网络以防止身份泄漏，请关闭并重新启动环境`
    this.logger?.error('浏览器代理网络已隔离', { profileId: id, reason })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
  }

  private async closeOrphan(id: string, pid: number): Promise<BrowserProfile> {
    this.onChanged(await this.profiles.setRuntime(id, { status: 'stopping', lastError: undefined }))
    try {
      await this.processInspector.terminate(pid, this.profiles.profileDataPath(id))
      this.orphanProcesses.delete(id)
      await rm(join(this.profiles.profileRuntimePath(id), 'process.json'), { force: true })
      const profile = await this.profiles.setRuntime(id, { status: 'closed', lastError: undefined })
      this.onChanged(profile)
      this.logger?.info('遗留浏览器进程已结束', { profileId: id, pid })
      return profile
    } catch (error) {
      const profile = await this.profiles.setRuntime(id, {
        status: 'orphaned',
        lastError: error instanceof Error ? error.message : String(error)
      })
      this.onChanged(profile)
      throw error
    }
  }

}
