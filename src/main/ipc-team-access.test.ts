import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ipcSource = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function handlerBlock(channel: string): string {
  const marker = `ipcMain.handle('${channel}'`
  const start = ipcSource.indexOf(marker)
  if (start < 0) throw new Error(`IPC handler not found: ${channel}`)
  const next = ipcSource.indexOf("ipcMain.handle('", start + marker.length)
  return ipcSource.slice(start, next < 0 ? ipcSource.length : next)
}

describe('team member runtime access boundaries', () => {
  const ownerOnlyChannels = [
    'profiles:identity-self-healing-all',
    'profiles:export-config',
    'profiles:storage-overview',
    'profiles:export-backup',
    'profiles:export-workspace',
    'profiles:trash',
    'profiles:export-cookies',
    'profiles:repair-fingerprint-identity',
    'profiles:execute-identity-repair-strategy',
    'proxy-pool:list',
    'proxy-pool:create',
    'proxy-pool:update',
    'proxy-pool:remove',
    'proxy-pool:test',
    'proxy-pool:test-many',
    'proxy-pool:assign',
    'proxy-pool:assign-best',
    'automation-api:attention-dashboard',
    'automation-api:attention-audit',
    'automation-api:attention-patrol-status',
    'automation-api:attention-patrol-configure',
    'automation-api:attention-confirm',
    'diagnostics:export-bundle',
    'extensions:import-directory',
    'extensions:open-source-folder',
    'extensions:set-global-enabled',
    'extensions:remove'
  ]

  it.each(ownerOnlyChannels)('%s requires the owner session', (channel) => {
    expect(handlerBlock(channel)).toContain('assertRuntimeOwner()')
  })

  it.each([
    'profiles:identity-health',
    'profiles:identity-self-healing',
    'profiles:identity-self-healing-history',
    'profiles:storage-info',
    'profiles:diagnose-fingerprint-runtime',
    'profiles:plan-fingerprint-repair',
    'profiles:fingerprint-repair-history',
    'profiles:crash-history',
    'profiles:environment-check-history'
  ])('%s checks access to the assigned profile', (channel) => {
    expect(handlerBlock(channel)).toContain('assertRuntimeCanUse(')
  })

  it('shuts down owner automation immediately when a device imports a member enrollment', () => {
    const block = handlerBlock('team:import-enrollment')
    expect(block).toContain('attentionPatrol.stop()')
    expect(block).toContain('await localApi.close()')
  })

  it('does not start Local API or automatic patrol on member devices', () => {
    expect(indexSource).toContain("if (teamSession.deviceRole === 'owner')")
    expect(indexSource).toContain("子账号设备已禁用 Local API 与自动巡检")
  })
})
