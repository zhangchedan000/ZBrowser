import { app, BrowserWindow, dialog, shell } from 'electron'
import { isAbsolute, join } from 'node:path'
import { BrowserLauncher } from './browser-launcher'
import { registerIpc } from './ipc'
import { ProfileStore } from './profile-store'
import { ElectronSecretCodec } from './secret-codec'
import { SettingsStore } from './settings-store'
import { ManagedKernelManager } from './kernel/managed-kernel-manager'
import { KernelRegistry } from './kernel/kernel-registry'
import { AppLogger } from './app-logger'
import { ExtensionStore } from './extension-store'
import { CookieManager } from './cookie-manager'
import { publicProfile } from './profile-secrets'
import { ProfileBackupManager } from './profile-backup'
import { AppSessionTracker } from './app-session'
import { UpdateManager } from './update-manager'
import { migrateMacLegacyKernelSelection } from './browser-locator'
import { WorkspaceMigrationManager } from './workspace-migration'
import { EnvironmentCheckHistoryStore } from './environment-check-history'
import { LocalApiServer, localApiPortFromEnvironment } from './local-api-server'
import { ProxyPoolStore } from './proxy-pool-store'
import { runMcpStdio } from './mcp-stdio-server'

let mainWindow: BrowserWindow | null = null
let launcher: BrowserLauncher | null = null
let logger: AppLogger | null = null
let appSession: AppSessionTracker | null = null
let localApi: LocalApiServer | null = null

if (process.platform === 'win32') app.setAppUserModelId('com.zbrowser.desktop')

const e2eUserData = process.env.ZBROWSER_E2E_USER_DATA ?? process.env.PRISM_E2E_USER_DATA
if ((process.env.ZBROWSER_E2E === '1' || process.env.PRISM_E2E === '1') && e2eUserData && isAbsolute(e2eUserData)) {
  app.setPath('userData', e2eUserData)
}

const mcpStdioMode = process.env.ZBROWSER_MCP_STDIO === '1' || process.argv.includes('--mcp-stdio') || app.commandLine.hasSwitch('mcp-stdio')

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'ZBrowser',
    backgroundColor: '#f3f5f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') logger?.error('Renderer console error', event.message)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger?.error('Renderer load failed', { code, description, url })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = mcpStdioMode ? true : app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.whenReady().then(async () => {
  const vaultPath = join(app.getPath('userData'), 'vault')
  if (mcpStdioMode) {
    await runMcpStdio(vaultPath, app.getVersion())
    app.quit()
    return
  }
  logger = new AppLogger(vaultPath)
  appSession = new AppSessionTracker(vaultPath)
  const secrets = new ElectronSecretCodec()
  const profiles = new ProfileStore(vaultPath, secrets)
  const proxyPool = new ProxyPoolStore(vaultPath, secrets)
  const settings = new SettingsStore(vaultPath)
  const extensions = new ExtensionStore(vaultPath, logger)
  const kernelRegistry = new KernelRegistry(join(vaultPath, 'kernels'))
  await logger.initialize()
  await kernelRegistry.list()
  const appSessionSnapshot = await appSession.begin(app.getVersion())
  if (appSessionSnapshot.previousUnclean) logger.error('检测到上次 ZBrowser 未正常退出', appSessionSnapshot.previousUnclean)
  await Promise.all([profiles.initialize(), proxyPool.initialize(), settings.initialize(), extensions.initialize()])
  const kernelMigration = await migrateMacLegacyKernelSelection(settings, vaultPath)
  if (kernelMigration.migrated) logger.info('已迁移旧版内核选择', kernelMigration)
  const purgedTrashCount = await profiles.purgeTrashOlderThan(settings.get().recycleRetentionDays)
  if (purgedTrashCount) logger.info('已自动清理环境回收站', { count: purgedTrashCount })
  logger.info('ZBrowser 已启动', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  launcher = new BrowserLauncher(
    profiles,
    settings,
    (profile) => {
      mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
    },
    extensions,
    logger,
    undefined,
    undefined,
    3,
    undefined,
    5 * 60_000,
    proxyPool
  )
  await launcher.initialize()
  const kernels = new ManagedKernelManager(
    vaultPath,
    settings,
    (progress) => mainWindow?.webContents.send('engine:install-progress', progress),
    logger,
    (version, family) => profiles.kernelUsers(version, family),
    kernelRegistry
  )
  await kernels.initialize()
  const cookies = new CookieManager(profiles, settings, logger)
  const backups = new ProfileBackupManager(profiles, app.getVersion(), logger)
  const workspaceMigration = new WorkspaceMigrationManager(profiles, extensions, app.getVersion(), logger)
  const updater = new UpdateManager(vaultPath, app.getVersion(), process.resourcesPath, (status) => {
    mainWindow?.webContents.send('updates:changed', status)
  }, logger)
  const environmentChecks = new EnvironmentCheckHistoryStore(vaultPath)
  const automationApi = new LocalApiServer(vaultPath, profiles, launcher, logger, {
    port: localApiPortFromEnvironment(process.env.ZBROWSER_LOCAL_API_PORT),
    token: process.env.ZBROWSER_LOCAL_API_TOKEN
  })
  localApi = automationApi
  registerIpc({
    profiles, settings, launcher, kernels, extensions, cookies, logger, backups,
    workspaceMigration, appSession, updater, environmentChecks, localApi: automationApi, proxyPool
  })
  try {
    const api = await automationApi.start()
    logger.info('Local API 已启动', { url: api.url, tokenPath: api.tokenPath, metadataPath: api.metadataPath })
  } catch (error) {
    logger.error('Local API 启动失败；桌面功能继续可用', error)
    localApi = null
  }
  mainWindow = createWindow()
  if (app.isPackaged && process.env.ZBROWSER_E2E !== '1' && process.env.PRISM_E2E !== '1') setTimeout(() => void updater.check().catch(() => undefined), 10_000)
}).catch(async (error) => {
  if (mcpStdioMode) {
    process.stderr.write(`ZBrowser MCP stdio failed: ${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
    return
  }
  logger?.error('ZBrowser 启动失败', error)
  await logger?.flush()
  dialog.showErrorBox('ZBrowser 无法启动', '应用启动失败，请查看日志。')
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
})

app.on('before-quit', (event) => {
  if (!launcher && !localApi) return
  event.preventDefault()
  const current = launcher
  const api = localApi
  launcher = null
  localApi = null
  void Promise.allSettled([
    current?.closeAll() ?? Promise.resolve(),
    api?.close() ?? Promise.resolve()
  ]).finally(async () => {
    await appSession?.complete().catch(() => undefined)
    await logger?.flush()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtExceptionMonitor', (error) => logger?.error('主进程未捕获异常', error))
process.on('unhandledRejection', (reason) => logger?.error('主进程未处理 Promise 拒绝', reason))
