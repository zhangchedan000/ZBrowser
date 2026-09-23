import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserApi, BrowserProfileView, ProfileBatchClassification, ProfileDraft, ProfileLaunchOptions, ProxyPoolEntryInput } from '../shared/types'

const api: BrowserApi = {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (draft: ProfileDraft) => ipcRenderer.invoke('profiles:create', draft),
    update: (id: string, draft: ProfileDraft) => ipcRenderer.invoke('profiles:update', id, draft),
    upgradeKernel: (id, version, family) => ipcRenderer.invoke('profiles:upgrade-kernel', id, version, family),
    kernelUpgradeCheckpoint: (id: string) => ipcRenderer.invoke('profiles:kernel-upgrade-checkpoint', id),
    rollbackKernelUpgrade: (id: string) => ipcRenderer.invoke('profiles:rollback-kernel-upgrade', id),
    duplicate: (id: string) => ipcRenderer.invoke('profiles:duplicate', id),
    exportConfig: (id: string) => ipcRenderer.invoke('profiles:export-config', id),
    importConfig: () => ipcRenderer.invoke('profiles:import-config'),
    importBatchCsv: () => ipcRenderer.invoke('profiles:import-batch-csv'),
    exportBatchTemplate: () => ipcRenderer.invoke('profiles:export-batch-template'),
    storageHealth: () => ipcRenderer.invoke('profiles:storage-health'),
    identityHealth: (id: string) => ipcRenderer.invoke('profiles:identity-health', id),
    identityHealthAll: () => ipcRenderer.invoke('profiles:identity-health-all'),
    storageInfo: (id: string) => ipcRenderer.invoke('profiles:storage-info', id),
    storageOverview: () => ipcRenderer.invoke('profiles:storage-overview'),
    openDataFolder: (id: string) => ipcRenderer.invoke('profiles:open-data-folder', id),
    clearCache: (id: string) => ipcRenderer.invoke('profiles:clear-cache', id),
    exportBackup: (id: string) => ipcRenderer.invoke('profiles:export-backup', id),
    importBackup: () => ipcRenderer.invoke('profiles:import-backup'),
    exportWorkspace: (password: string) => ipcRenderer.invoke('profiles:export-workspace', password),
    importWorkspace: (password: string, conflictPolicy: 'rename' | 'skip') => ipcRenderer.invoke('profiles:import-workspace', password, conflictPolicy),
    trash: () => ipcRenderer.invoke('profiles:trash'),
    restore: (trashId: string) => ipcRenderer.invoke('profiles:restore', trashId),
    purgeTrash: (trashId: string) => ipcRenderer.invoke('profiles:purge-trash', trashId),
    emptyTrash: () => ipcRenderer.invoke('profiles:empty-trash'),
    recycleRetention: () => ipcRenderer.invoke('profiles:recycle-retention'),
    setRecycleRetention: (days) => ipcRenderer.invoke('profiles:set-recycle-retention', days),
    exportCookies: (id: string) => ipcRenderer.invoke('profiles:export-cookies', id),
    importCookies: (id: string) => ipcRenderer.invoke('profiles:import-cookies', id),
    remove: (id: string) => ipcRenderer.invoke('profiles:remove', id),
    launch: (id: string, options?: ProfileLaunchOptions) => ipcRenderer.invoke('profiles:launch', id, options),
    close: (id: string) => ipcRenderer.invoke('profiles:close', id),
    closeAll: () => ipcRenderer.invoke('profiles:close-all'),
    testProxy: (id: string) => ipcRenderer.invoke('profiles:test-proxy', id),
    diagnose: (id: string) => ipcRenderer.invoke('profiles:diagnose', id),
    diagnoseKernelRuntime: (id: string) => ipcRenderer.invoke('profiles:diagnose-kernel-runtime', id),
    diagnoseFingerprintRuntime: (id: string) => ipcRenderer.invoke('profiles:diagnose-fingerprint-runtime', id),
    planFingerprintRepair: (id: string) => ipcRenderer.invoke('profiles:plan-fingerprint-repair', id),
    repairFingerprintIdentity: (id: string, approvedByUser: boolean, planId: string, sections) =>
      ipcRenderer.invoke('profiles:repair-fingerprint-identity', id, approvedByUser, planId, sections),
    fingerprintRepairHistory: (id: string) => ipcRenderer.invoke('profiles:fingerprint-repair-history', id),
    crashHistory: (id: string) => ipcRenderer.invoke('profiles:crash-history', id),
    environmentCheckHistory: (id: string) => ipcRenderer.invoke('profiles:environment-check-history', id),
    recordEnvironmentCheck: (id: string, urls: string[]) => ipcRenderer.invoke('profiles:record-environment-check', id, urls),
    clearEnvironmentCheckHistory: (id: string) => ipcRenderer.invoke('profiles:clear-environment-check-history', id),
    setFavorite: (id: string, favorite: boolean) => ipcRenderer.invoke('profiles:set-favorite', id, favorite),
    classifyMany: (ids: string[], patch: ProfileBatchClassification) => ipcRenderer.invoke('profiles:classify-many', ids, patch),
    removeMany: (ids: string[]) => ipcRenderer.invoke('profiles:remove-many', ids),
    onChanged: (listener: (profile: BrowserProfileView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, profile: BrowserProfileView): void => listener(profile)
      ipcRenderer.on('profiles:changed', handler)
      return () => ipcRenderer.removeListener('profiles:changed', handler)
    }
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    bundled: () => ipcRenderer.invoke('engine:bundled'),
    activateBundled: () => ipcRenderer.invoke('engine:activate-bundled'),
    select: () => ipcRenderer.invoke('engine:select'),
    importLocal: () => ipcRenderer.invoke('engine:import-local'),
    useSystem: () => ipcRenderer.invoke('engine:use-system'),
    installed: () => ipcRenderer.invoke('engine:installed'),
    releases: () => ipcRenderer.invoke('engine:releases'),
    install: (version: string) => ipcRenderer.invoke('engine:install', version),
    cancelInstall: (version: string) => ipcRenderer.invoke('engine:cancel-install', version),
    onInstallProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
      ipcRenderer.on('engine:install-progress', handler)
      return () => ipcRenderer.removeListener('engine:install-progress', handler)
    },
    activate: (version: string) => ipcRenderer.invoke('engine:activate', version),
    rollbackAvailable: () => ipcRenderer.invoke('engine:rollback-available'),
    rollback: () => ipcRenderer.invoke('engine:rollback'),
    remove: (version: string) => ipcRenderer.invoke('engine:remove', version),
    verify: (version: string) => ipcRenderer.invoke('engine:verify', version)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    openInstaller: () => ipcRenderer.invoke('updates:open-installer'),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on('updates:changed', handler)
      return () => ipcRenderer.removeListener('updates:changed', handler)
    }
  },
  proxyPool: {
    list: () => ipcRenderer.invoke('proxy-pool:list'),
    create: (input: ProxyPoolEntryInput) => ipcRenderer.invoke('proxy-pool:create', input),
    update: (id: string, input: ProxyPoolEntryInput) => ipcRenderer.invoke('proxy-pool:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('proxy-pool:remove', id),
    test: (id: string) => ipcRenderer.invoke('proxy-pool:test', id),
    testMany: (ids?: string[]) => ipcRenderer.invoke('proxy-pool:test-many', ids),
    assign: (proxyId: string, profileId: string) => ipcRenderer.invoke('proxy-pool:assign', proxyId, profileId),
    assignBest: (profileId: string) => ipcRenderer.invoke('proxy-pool:assign-best', profileId)
  },
  proxy: {
    test: (config, profileId) => ipcRenderer.invoke('proxy:test', config, profileId)
  },
  automation: {
    status: () => ipcRenderer.invoke('automation-api:status')
  },
  diagnostics: {
    sessionHealth: () => ipcRenderer.invoke('diagnostics:session-health'),
    exportBundle: () => ipcRenderer.invoke('diagnostics:export-bundle'),
    e2eQuit: () => ipcRenderer.invoke('diagnostics:e2e-quit')
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    importDirectory: () => ipcRenderer.invoke('extensions:import-directory'),
    openSourceFolder: (id: string) => ipcRenderer.invoke('extensions:open-source-folder', id),
    setGlobalEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-global-enabled', id, enabled),
    remove: (id: string) => ipcRenderer.invoke('extensions:remove', id)
  }
}

contextBridge.exposeInMainWorld('browserApi', api)
