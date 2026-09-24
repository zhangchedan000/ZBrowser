import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { lstat, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityConfigSection, ProfileDraft, ProxyPoolEntry, ProxyPoolEntryInput } from '../shared/types'
import { compareKernelVersions, kernelFamilyForRelease } from '../shared/kernel-version'
import type { KernelManager } from './kernel-manager'
import { listBundledBrowsers, locateBrowser, locateBrowserForProfile, locateBundledBrowser, normalizeBrowserSelection } from './browser-locator'
import { mergeKernelCatalog } from './kernel-catalog'
import type { BrowserLauncher } from './browser-launcher'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { testProxy } from './proxy-tester'
import { validateProxyConfig } from '../shared/validation'
import type { AppLogger } from './app-logger'
import { parseProfileConfig, safeProfileFileName, serializeProfileConfig } from './profile-transfer'
import { clearProfileCache, profileStorageInfo, storageOverview } from './profile-data'
import type { ExtensionStore } from './extension-store'
import type { CookieManager } from './cookie-manager'
import { parseCookieFile, serializeCookieFile } from './cookie-file'
import { parseBatchProfileCsv, serializeBatchProfileTemplate } from './profile-batch-csv'
import { proxyForTest, publicProfile } from './profile-secrets'
import type { ProfileBackupManager } from './profile-backup'
import type { AppSessionTracker } from './app-session'
import type { UpdateManager } from './update-manager'
import type { WorkspaceMigrationManager } from './workspace-migration'
import type { EnvironmentCheckHistoryStore } from './environment-check-history'
import type { LocalApiServer } from './local-api-server'
import type { ProxyPoolStore } from './proxy-pool-store'
import { createStoredZip, diagnosticProfileSummary, redactDiagnosticText } from './diagnostic-bundle'
import { selectBestProxyPoolEntry } from './proxy-pool-selection'
import type { FingerprintRepairExecutor } from './fingerprint-repair-executor'
import type { FingerprintRepairStateStore } from './fingerprint-repair-state'
import { IdentityHealthHistoryStore } from './identity-health-history'
import { summarizeIdentityProfileHealth } from '../shared/identity-profile-health'

interface IpcDependencies {
  profiles: ProfileStore
  settings: SettingsStore
  launcher: BrowserLauncher
  kernels: KernelManager
  extensions: ExtensionStore
  cookies: CookieManager
  logger: AppLogger
  backups: ProfileBackupManager
  workspaceMigration: WorkspaceMigrationManager
  appSession: AppSessionTracker
  updater: UpdateManager
  environmentChecks: EnvironmentCheckHistoryStore
  localApi: LocalApiServer
  proxyPool: ProxyPoolStore
  fingerprintRepair: FingerprintRepairExecutor
  fingerprintRepairState: FingerprintRepairStateStore
}

export function registerIpc({
  profiles, settings, launcher, kernels, extensions, cookies, logger, backups,
  workspaceMigration, appSession, updater, environmentChecks, localApi, proxyPool,
  fingerprintRepair, fingerprintRepairState
}: IpcDependencies): void {
  const identityHealthHistory = new IdentityHealthHistoryStore(profiles.vaultPath)

  async function identityHealthSummary(profileId: string) {
    profiles.get(profileId)
    return summarizeIdentityProfileHealth(await identityHealthHistory.list(profileId))
  }

  async function identityHealthSummaries() {
    const entries = await Promise.all(profiles.list().map(async (profile) => [
      profile.id,
      await identityHealthSummary(profile.id)
    ] as const))
    return Object.fromEntries(entries)
  }

  async function pinKernelFamily(draft: ProfileDraft): Promise<ProfileDraft> {
    const version = draft.kernelVersion.trim()
    if (!version) return { ...draft, kernelFamily: undefined }
    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    const installed = managed.find((kernel) => kernel.version === version)
    if (installed) {
      const installedFamily = kernelFamilyForRelease(installed)
      if (draft.kernelFamily && draft.kernelFamily !== installedFamily) {
        throw new Error(`固定内核 ${version} 的系列不匹配：当前安装的是 ${installedFamily}，环境要求 ${draft.kernelFamily}`)
      }
      return { ...draft, kernelFamily: installedFamily }
    }
    if (bundled.some((kernel) => kernel.version === version)) {
      if (draft.kernelFamily === 'custom') return draft
      return { ...draft, kernelFamily: 'fingerprint-chromium' }
    }
    return draft
  }

  ipcMain.handle('profiles:list', () => profiles.list().map(publicProfile))
  ipcMain.handle('profiles:storage-health', () => profiles.storageHealth())
  ipcMain.handle('profiles:identity-health', (_event, id: string) => identityHealthSummary(id))
  ipcMain.handle('profiles:identity-health-all', () => identityHealthSummaries())
  ipcMain.handle('profiles:create', async (_event, draft: ProfileDraft) => publicProfile(await profiles.create(await pinKernelFamily(draft))))
  ipcMain.handle('profiles:update', async (_event, id: string, draft: ProfileDraft) => {
    const pinned = await pinKernelFamily(draft)
    return publicProfile(await profiles.update(id, pinned))
  })
  ipcMain.handle('profiles:upgrade-kernel', async (_event, id: string, version: string, family: unknown) => {
    if (typeof version !== 'string' || !/^\d+(?:\.\d+){3}$/.test(version.trim())) throw new Error('目标内核版本号无效')
    if (family !== 'fingerprint-chromium' && family !== 'custom') throw new Error('目标内核系列无效')
    const targetVersion = version.trim()
    const current = profiles.get(id)
    if (current.status !== 'closed' && current.status !== 'error') {
      throw new Error('请先关闭浏览器环境再升级内核')
    }
    if (!current.kernelVersion || !current.kernelFamily) {
      throw new Error('当前环境尚未固定内核系列，请先在环境编辑器中选择固定内核')
    }
    if (current.kernelFamily !== family) {
      throw new Error(`环境已固定 ${current.kernelFamily} 系列，不能跨系列升级到 ${family}`)
    }
    if (compareKernelVersions(targetVersion, current.kernelVersion) <= 0) {
      throw new Error(`目标内核 ${targetVersion} 不是高于当前 ${current.kernelVersion} 的升级版本`)
    }

    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    const managedMatch = managed.some((kernel) => kernel.version === targetVersion && kernelFamilyForRelease(kernel) === family)
    const bundledMatch = family === 'fingerprint-chromium' && bundled.some((kernel) => kernel.version === targetVersion)
    if (!managedMatch && !bundledMatch) throw new Error(`目标内核 ${targetVersion}（${family}）尚未安装`)

    const checkpoint = await backups.createKernelUpgradeCheckpoint(id, targetVersion, family)
    const draft: ProfileDraft = {
      name: current.name,
      note: current.note,
      group: current.group,
      tags: [...current.tags],
      extensionIds: [...current.extensionIds],
      color: current.color,
      startUrls: [...current.startUrls],
      kernelVersion: targetVersion,
      kernelFamily: family,
      window: { ...current.window },
      proxy: { ...current.proxy },
      fingerprint: { ...current.fingerprint, disabledSpoofing: [...current.fingerprint.disabledSpoofing] }
    }
    const profile = await profiles.update(id, await pinKernelFamily(draft), 'kernel_upgrade')
    return { profile: publicProfile(profile), checkpoint }
  })
  ipcMain.handle('profiles:kernel-upgrade-checkpoint', (_event, id: string) => backups.kernelUpgradeCheckpoint(id))
  ipcMain.handle('profiles:rollback-kernel-upgrade', async (_event, id: string) => {
    return publicProfile(await backups.rollbackKernelUpgrade(id))
  })
  ipcMain.handle('profiles:duplicate', async (_event, id: string) => publicProfile(await profiles.duplicate(id)))
  ipcMain.handle('profiles:export-config', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭环境再导出配置')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '导出环境配置',
      defaultPath: safeProfileFileName(profile.name),
      filters: [{ name: 'ZBrowser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeProfileConfig(profile), { encoding: 'utf8', mode: 0o600 })
    logger.info('环境配置已导出', { profileId: id })
    return result.filePath
  })
  ipcMain.handle('profiles:import-config', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境配置',
      properties: ['openFile'],
      filters: [{ name: 'ZBrowser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 1024 * 1024) throw new Error('环境配置文件不能超过 1 MB')
    const profile = await profiles.create(await pinKernelFamily(parseProfileConfig(await readFile(path, 'utf8'))))
    logger.info('环境配置已导入', { profileId: profile.id })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:import-batch-csv', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '批量导入浏览器环境',
      properties: ['openFile'],
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('批量导入 CSV 不能超过 2 MB')
    const drafts = parseBatchProfileCsv(await readFile(path, 'utf8'), profiles.list().length + 1)
    const created = await profiles.createMany(await Promise.all(drafts.map(pinKernelFamily)))
    logger.info('已通过 CSV 批量导入浏览器环境', { count: created.length })
    return created.map(publicProfile)
  })
  ipcMain.handle('profiles:export-batch-template', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存批量导入 CSV 模板',
      defaultPath: 'zbrowser-batch-template.csv',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeBatchProfileTemplate(), { encoding: 'utf8', mode: 0o600 })
    return result.filePath
  })
  ipcMain.handle('profiles:storage-info', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    return profileStorageInfo(profiles.profileDataPath(id))
  })
  ipcMain.handle('profiles:storage-overview', () => storageOverview(profiles.vaultPath))
  ipcMain.handle('profiles:open-data-folder', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    const error = await shell.openPath(profiles.profileDataPath(id))
    if (error) throw new Error(`无法打开环境数据目录：${error}`)
  })
  ipcMain.handle('profiles:clear-cache', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) {
      throw new Error('请先关闭浏览器环境再清理缓存')
    }
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.assertProfileDataIdentity(id)
    const result = await clearProfileCache(profiles.profileDataPath(id))
    logger.info('浏览器环境缓存已清理', { profileId: id })
    return result
  })
  ipcMain.handle('profiles:export-backup', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) throw new Error('请先关闭环境再备份完整数据')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    const processCheck = (await launcher.diagnose(id)).checks.find((check) => check.key === 'process')
    if (processCheck?.status === 'error') throw new Error(`无法安全备份：${processCheck.message}`)
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择环境数据备份保存位置', properties: ['openDirectory', 'createDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return backups.export(id, result.filePaths[0])
  })
  ipcMain.handle('profiles:import-backup', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择 ZBrowser 环境数据备份目录', properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const imported = await backups.import(result.filePaths[0])
    return { profile: publicProfile(imported.profile), result: imported.result }
  })
  ipcMain.handle('profiles:export-workspace', async (_event, password: string) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导出迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: '导出全部环境加密迁移包',
      defaultPath: `ZBrowser 全部环境 ${stamp}.zbrowser-migration`,
      filters: [{ name: 'ZBrowser 加密迁移包', extensions: ['zbrowser-migration', 'prism-migration'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return workspaceMigration.exportAll(result.filePath, password)
  })
  ipcMain.handle('profiles:import-workspace', async (_event, password: string, conflictPolicy: 'rename' | 'skip') => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入全部环境加密迁移包',
      properties: ['openFile'],
      filters: [{ name: 'ZBrowser/旧版兼容迁移包', extensions: ['zbrowser-migration', 'prism-migration'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return workspaceMigration.importAll(result.filePaths[0], password, conflictPolicy)
  })
  ipcMain.handle('profiles:trash', () => profiles.listTrash())
  ipcMain.handle('profiles:restore', async (_event, trashId: string) => {
    const profile = await profiles.restore(trashId)
    logger.info('浏览器环境已从回收站恢复', { profileId: profile.id })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:purge-trash', async (_event, trashId: string) => {
    await profiles.purgeTrash(trashId)
    logger.info('回收站环境已永久删除', { trashId })
  })
  ipcMain.handle('profiles:empty-trash', async () => {
    const count = await profiles.emptyTrash()
    logger.info('环境回收站已清空', { count })
    return count
  })
  ipcMain.handle('profiles:recycle-retention', () => settings.get().recycleRetentionDays)
  ipcMain.handle('profiles:set-recycle-retention', async (_event, days: number) => {
    if (days !== 0 && days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    await settings.update({ recycleRetentionDays: days })
    logger.info('环境回收站自动清理策略已更新', { days })
    return days
  })
  ipcMain.handle('profiles:export-cookies', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导出 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const defaultPath = safeProfileFileName(profile.name).replace(/\.(?:zbrowser-profile|prism-profile)\.json$/, '.cookies.json')
    const options: Electron.SaveDialogOptions = {
      title: '导出环境 Cookie',
      defaultPath,
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const exported = await cookies.exportCookies(id)
    await writeFile(result.filePath, serializeCookieFile(profile.name, exported), { encoding: 'utf8', mode: 0o600 })
    return { count: exported.length, filePath: result.filePath }
  })
  ipcMain.handle('profiles:import-cookies', async (_event, id: string) => {
    profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导入 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境 Cookie',
      properties: ['openFile'],
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Cookie 文件不能超过 10 MB')
    const imported = parseCookieFile(await readFile(path, 'utf8'))
    const count = await cookies.importCookies(id, imported)
    return { count, filePath: path }
  })
  ipcMain.handle('profiles:remove', async (_event, id: string) => {
    if (launcher.isRunning(id)) throw new Error('请先关闭运行中的环境')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.remove(id)
  })
  ipcMain.handle('profiles:launch', (_event, id: string, options?: { allowGeoConflict?: unknown; startUrls?: unknown }) => {
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    let startUrls: string[] | undefined
    if (options?.startUrls !== undefined) {
      if (!Array.isArray(options.startUrls) || options.startUrls.length > 12) throw new Error('临时启动网址参数无效')
      startUrls = options.startUrls.map((value) => {
        if (typeof value !== 'string' || value.length > 2048) throw new Error('临时启动网址参数无效')
        let parsed: URL
        try {
          parsed = new URL(value)
        } catch {
          throw new Error('临时启动网址格式无效')
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('临时启动网址只允许 HTTP/HTTPS')
        return parsed.toString()
      })
    }
    return launcher.launch(id, {
      allowGeoConflict: options?.allowGeoConflict === true,
      startUrls
    }).then(async (profile) => {
      await backups.noteKernelUpgradeHealthyLaunch(id).catch((error) => {
        logger?.error('更新内核升级备份保留状态失败', {
          profileId: id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      return publicProfile(profile)
    })
  })
  ipcMain.handle('profiles:close', (_event, id: string) => launcher.close(id).then(publicProfile))
  ipcMain.handle('profiles:close-all', () => launcher.closeAll())
  ipcMain.handle('profiles:test-proxy', (_event, id: string) => launcher.testProfileProxy(id).then(publicProfile))
  ipcMain.handle('profiles:diagnose', (_event, id: string) => launcher.diagnose(id))
  ipcMain.handle('profiles:diagnose-kernel-runtime', (_event, id: string) => launcher.diagnoseKernelRuntime(id))
  ipcMain.handle('profiles:diagnose-fingerprint-runtime', (_event, id: string) => launcher.diagnoseFingerprintRuntime(id))
  ipcMain.handle('profiles:plan-fingerprint-repair', (_event, id: string) => fingerprintRepair.plan(id))
  ipcMain.handle('profiles:repair-fingerprint-identity', async (
    _event,
    id: string,
    approvedByUser: unknown,
    planId: unknown,
    sections: unknown
  ) => {
    if (approvedByUser !== true) throw new Error('AI 修复必须由用户明确确认后才能执行')
    if (typeof planId !== 'string' || !planId.trim()) throw new Error('AI 修复计划标识无效')
    const validSections: IdentityConfigSection[] = ['fingerprint', 'network', 'locale', 'browser']
    if (!Array.isArray(sections) || !sections.every((section) => validSections.includes(section as IdentityConfigSection))) {
      throw new Error('AI 修复区域无效')
    }
    const result = await fingerprintRepair.execute(id, true, planId, sections as IdentityConfigSection[])
    return { ...result, profile: publicProfile(result.profile) }
  })
  ipcMain.handle('profiles:fingerprint-repair-history', (_event, id: string) => fingerprintRepairState.history(id))
  ipcMain.handle('profiles:crash-history', (_event, id: string) => launcher.crashHistory(id))
  ipcMain.handle('profiles:environment-check-history', (_event, id: string) => {
    profiles.get(id)
    return environmentChecks.list(id)
  })
  ipcMain.handle('profiles:record-environment-check', async (_event, id: string, urls: string[]) => {
    const profile = profiles.get(id)
    const engine = await locateBrowserForProfile(settings, profiles.vaultPath, profile.kernelVersion, profile.kernelFamily)
    return environmentChecks.record(publicProfile(profile), engine, urls)
  })
  ipcMain.handle('profiles:clear-environment-check-history', async (_event, id: string) => {
    profiles.get(id)
    await environmentChecks.clear(id)
  })
  ipcMain.handle('profiles:set-favorite', async (_event, id: string, favorite: boolean) => publicProfile(await profiles.setFavorite(id, favorite)))
  ipcMain.handle('profiles:classify-many', async (_event, ids: string[], patch) => {
    return (await profiles.classifyMany(ids, patch)).map(publicProfile)
  })
  ipcMain.handle('profiles:remove-many', async (_event, ids: string[]) => {
    for (const id of ids) {
      if (launcher.isRunning(id)) throw new Error(`环境“${profiles.get(id).name}”正在运行，不能删除`)
      if (cookies.isBusy(id)) throw new Error(`环境“${profiles.get(id).name}”正在执行 Cookie 操作`)
    }
    await profiles.removeMany(ids)
  })

  ipcMain.handle('engine:status', () => locateBrowser(settings))
  ipcMain.handle('engine:bundled', () => locateBundledBrowser())
  ipcMain.handle('engine:activate-bundled', async () => {
    const bundled = await locateBundledBrowser()
    if (!bundled?.executable) throw new Error('当前安装包没有可用的内置指纹内核')
    return kernels.configure(
      { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:select', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择 Fingerprint Chromium 内核',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '浏览器', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    const executable = await normalizeBrowserSelection(result.filePaths[0])
    return kernels.configure({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
  })
  ipcMain.handle('engine:import-local', async () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入并切换内核')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入本地 Fingerprint Chromium 构建',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Chromium', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    return kernels.importLocal(result.filePaths[0])
  })
  ipcMain.handle('engine:use-system', async () => {
    return kernels.configure({ browserExecutable: '', fingerprintKernel: false, enginePreference: 'system' })
  })
  ipcMain.handle('engine:installed', async () => {
    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    return mergeKernelCatalog(managed, bundled)
  })
  ipcMain.handle('engine:releases', async () => {
    const [remoteAndManaged, bundled] = await Promise.all([kernels.releases(), listBundledBrowsers()])
    return mergeKernelCatalog(remoteAndManaged, bundled)
  })
  ipcMain.handle('engine:install', async (_event, version: string) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再安装并切换内核')
    return kernels.install(version)
  })
  ipcMain.handle('engine:cancel-install', (_event, version: string) => kernels.cancel(version))
  ipcMain.handle('engine:activate', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (!bundled?.executable) return kernels.activate(version)
    const primary = await locateBundledBrowser()
    return kernels.configure(
      primary?.version === version
        ? { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' }
        : { browserExecutable: bundled.executable, fingerprintKernel: true, enginePreference: 'auto' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:rollback-available', () => kernels.rollbackAvailable())
  ipcMain.handle('engine:rollback', () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再回滚内核')
    return kernels.rollback()
  })
  ipcMain.handle('engine:remove', (_event, version: string) => kernels.remove(version))
  ipcMain.handle('engine:verify', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (bundled?.executable) {
      return {
        version,
        status: 'healthy',
        message: '随当前应用发布的内核完整性正常',
        checkedAt: new Date().toISOString()
      }
    }
    return kernels.verify(version)
  })
  ipcMain.handle('updates:status', () => updater.status())
  ipcMain.handle('updates:check', () => updater.check())
  ipcMain.handle('updates:download', () => updater.download())
  ipcMain.handle('updates:open-installer', async () => {
    const error = await shell.openPath(await updater.downloadedPath())
    if (error) throw new Error(`无法打开更新安装程序：${error}`)
  })
  const proxyPoolView = (entry: ProxyPoolEntry): ProxyPoolEntry => ({
    ...entry,
    assignedProfileIds: profiles.list().filter((profile) => profile.proxyPoolEntryId === entry.id).map((profile) => profile.id)
  })
  ipcMain.handle('proxy-pool:list', () => proxyPool.list().map(proxyPoolView))
  ipcMain.handle('proxy-pool:create', async (_event, input: ProxyPoolEntryInput) => proxyPoolView(await proxyPool.create(input)))
  ipcMain.handle('proxy-pool:update', async (_event, id: string, input: ProxyPoolEntryInput) => {
    if (profiles.list().some((profile) => profile.proxyPoolEntryId === id)) {
      throw new Error('该代理已绑定环境，请先更换这些环境的代理后再修改代理地址或凭据')
    }
    return proxyPoolView(await proxyPool.update(id, input))
  })
  ipcMain.handle('proxy-pool:remove', async (_event, id: string) => {
    const bound = profiles.list().filter((profile) => profile.proxyPoolEntryId === id)
    if (bound.length) throw new Error(`该代理仍绑定 ${bound.length} 个环境，不能删除`)
    await proxyPool.remove(id)
  })
  ipcMain.handle('proxy-pool:test', async (_event, id: string) => proxyPoolView(await proxyPool.test(id)))
  ipcMain.handle('proxy-pool:test-many', async (_event, ids?: string[]) => (await proxyPool.testMany(ids)).map(proxyPoolView))
  ipcMain.handle('proxy-pool:assign', async (_event, proxyId: string, profileId: string) => {
    const entry = proxyPool.get(proxyId)
    if (entry.health === 'unchecked' || entry.health === 'failed' || entry.health === 'quarantined') {
      throw new Error('该代理当前不可分配，请先检测并确认健康状态')
    }
    const check = proxyPool.check(proxyId)
    if (!check) throw new Error('代理尚未检测')
    return publicProfile(await profiles.assignProxy(profileId, proxyPool.proxyConfig(proxyId), check, proxyId))
  })
  ipcMain.handle('proxy-pool:assign-best', async (_event, profileId: string) => {
    const profile = profiles.get(profileId)
    if ((profile.environmentType ?? 'account') !== 'temporary') {
      throw new Error('账号环境禁止自动选择或切换代理；请手动指定代理')
    }
    const candidate = selectBestProxyPoolEntry(proxyPool.list())
    if (!candidate) throw new Error('代理池中没有 24 小时内检测通过的可用代理')
    const check = proxyPool.check(candidate.id)
    if (!check) throw new Error('最佳代理缺少检测结果')
    return publicProfile(await profiles.assignProxy(profileId, proxyPool.proxyConfig(candidate.id), check, candidate.id))
  })
  ipcMain.handle('proxy:test', (_event, config, profileId?: string) => {
    const validated = validateProxyConfig(config)
    const profile = profileId ? profiles.get(profileId) : undefined
    return testProxy(proxyForTest(validated, profile))
  })
  ipcMain.handle('automation-api:status', () => localApi.publicStatus())
  ipcMain.handle('diagnostics:session-health', () => appSession.recoveryStatus())
  ipcMain.handle('diagnostics:export-bundle', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: '导出 ZBrowser 诊断包',
      defaultPath: `ZBrowser-diagnostics-${stamp}.zip`,
      filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    await logger.flush()
    const [engine, installedKernels, storage] = await Promise.all([
      locateBrowser(settings),
      kernels.installed(),
      storageOverview(profiles.vaultPath)
    ])
    const automation = localApi.publicStatus()
    const profileReports = await Promise.all(profiles.list().map(async (profile) => {
      const [launchDiagnostic, crashHistory, environmentHistory] = await Promise.all([
        launcher.diagnose(profile.id).catch((error) => ({
          error: error instanceof Error ? error.message : String(error)
        })),
        launcher.crashHistory(profile.id).catch((error) => [{
          error: error instanceof Error ? error.message : String(error)
        }]),
        environmentChecks.list(profile.id).catch((error) => [{
          error: error instanceof Error ? error.message : String(error)
        }])
      ])
      return {
        profile: diagnosticProfileSummary(profile),
        launchDiagnostic,
        crashHistory,
        environmentHistory
      }
    }))

    const health = profiles.storageHealth()
    const update = updater.status()
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node
      },
      engine: {
        source: engine.source,
        fingerprintKernel: engine.fingerprintKernel,
        label: engine.label,
        version: engine.version
      },
      installedKernels: installedKernels.map((kernel) => ({
        version: kernel.version,
        installed: kernel.installed,
        origin: kernel.origin,
        assetName: kernel.assetName
      })),
      automation: {
        running: automation.running,
        apiVersion: automation.apiVersion,
        host: automation.host,
        port: automation.port,
        capabilities: automation.capabilities
      },
      update: {
        stage: update.stage,
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        channel: update.channel,
        distributionMode: update.distributionMode,
        message: update.message
      },
      recovery: appSession.recoveryStatus(),
      profileStoreHealth: {
        recoveredFromBackup: health.recoveredFromBackup,
        recoveryMessage: health.recoveryMessage,
        backupHealthy: health.backupHealthy,
        backupError: health.backupError
      },
      storage,
      profiles: profileReports
    }

    const privateValues = [
      app.getPath('home'),
      app.getPath('userData'),
      ...profiles.list().flatMap((profile) => [
        profile.proxy.host,
        profile.proxy.username,
        profile.proxy.password
      ])
    ]
    const entries: Array<{ name: string; data: string | Buffer }> = [
      {
        name: 'diagnostics.json',
        data: redactDiagnosticText(JSON.stringify(payload, null, 2), privateValues)
      },
      {
        name: 'README.txt',
        data: [
          'ZBrowser diagnostic bundle',
          '',
          'Contains application/runtime metadata, sanitized profile diagnostics, crash history, environment-check history and redacted application logs.',
          'Does NOT intentionally include cookies, Local API tokens, proxy usernames/passwords, proxy hostnames, profile notes or saved start URLs.'
        ].join('\n')
      }
    ]

    const currentLog = await readFile(logger.path, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    if (currentLog) entries.push({
      name: 'logs/current.log',
      data: redactDiagnosticText(currentLog, privateValues)
    })
    const previousLog = await readFile(join(logger.directory, 'prism.previous.log'), 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    if (previousLog) entries.push({
      name: 'logs/previous.log',
      data: redactDiagnosticText(previousLog, privateValues)
    })

    await writeFile(result.filePath, createStoredZip(entries), { mode: 0o600 })
    logger.info('诊断包已导出', {
      fileName: result.filePath.split(/[\\/]/).pop(),
      profileCount: profileReports.length
    })
    return result.filePath
  })
  if (process.env.ZBROWSER_E2E === '1' || process.env.PRISM_E2E === '1') {
    ipcMain.handle('diagnostics:e2e-quit', () => app.quit())
  }
  ipcMain.handle('extensions:list', () => extensions.list())
  ipcMain.handle('extensions:import-directory', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择未打包的浏览器扩展目录', properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extensions.importDirectory(result.filePaths[0])
  })
  ipcMain.handle('extensions:open-source-folder', async (_event, id: string) => {
    const path = extensions.sourcePath(id)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('扩展源码目录不存在或不安全')
    const manifestPath = join(path, 'manifest.json')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('扩展源码缺少有效的 manifest.json')
    shell.showItemInFolder(manifestPath)
    logger.info('已打开扩展源码目录', { extensionId: id })
    return path
  })
  ipcMain.handle('extensions:set-global-enabled', (_event, id: string, enabled: boolean) => {
    return extensions.setGlobalEnabled(id, enabled)
  })
  ipcMain.handle('extensions:remove', async (_event, id: string) => {
    if (await profiles.usesExtension(id)) throw new Error('该扩展仍被浏览器环境使用，请先从环境配置中移除')
    await extensions.remove(id)
  })
}
