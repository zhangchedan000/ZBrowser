import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserProfileView, EngineStatus, EnvironmentCheckRecord } from '../shared/types'
import { buildEnvironmentChecks, environmentCheckSummary } from '../shared/environment-check'

const MAX_RECORDS = 50
const MAX_URLS = 12

function validRecord(value: unknown): value is EnvironmentCheckRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EnvironmentCheckRecord>
  return typeof item.checkedAt === 'string'
    && Number.isFinite(Date.parse(item.checkedAt))
    && typeof item.timezone === 'string'
    && typeof item.language === 'string'
    && (item.platform === 'windows' || item.platform === 'macos')
    && typeof item.hardwareProfileId === 'string'
    && Number.isInteger(item.seed)
    && typeof item.screenWidth === 'number'
    && typeof item.screenHeight === 'number'
    && ['proxy_only', 'public_only', 'default'].includes(item.webrtcPolicy ?? '')
    && Boolean(item.localSummary)
    && Array.isArray(item.externalUrls)
}

function safeUrls(urls: string[]): string[] {
  if (!Array.isArray(urls) || urls.length > MAX_URLS) throw new Error('环境检测网址参数无效')
  return urls.map((value) => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('环境检测网址参数无效')
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('环境检测网址格式无效')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('环境检测网址只允许 HTTP/HTTPS')
    return parsed.toString()
  })
}

export class EnvironmentCheckHistoryStore {
  private readonly root: string

  constructor(vaultPath: string) {
    this.root = join(vaultPath, 'environment-check-history')
  }

  private file(profileId: string): string {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(profileId)) throw new Error('环境 ID 无效')
    return join(this.root, `${profileId}.json`)
  }

  async list(profileId: string): Promise<EnvironmentCheckRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file(profileId), 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(validRecord).slice(-MAX_RECORDS).reverse()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return []
    }
  }

  async record(
    profile: BrowserProfileView,
    engine: EngineStatus | null,
    urls: string[]
  ): Promise<EnvironmentCheckRecord[]> {
    const externalUrls = safeUrls(urls)
    const localSummary = environmentCheckSummary(buildEnvironmentChecks(profile, engine))
    const record: EnvironmentCheckRecord = {
      checkedAt: new Date().toISOString(),
      proxyIp: profile.proxyCheck?.ip,
      countryCode: profile.proxyCheck?.countryCode,
      proxyCheckedAt: profile.proxyCheck?.checkedAt,
      timezone: profile.fingerprint.timezone,
      language: profile.fingerprint.language,
      platform: profile.fingerprint.platform,
      hardwareProfileId: profile.fingerprint.hardwareProfileId,
      seed: profile.fingerprint.seed,
      kernelVersion: profile.kernelVersion || engine?.version,
      screenWidth: profile.fingerprint.screenWidth,
      screenHeight: profile.fingerprint.screenHeight,
      webrtcPolicy: profile.fingerprint.webrtcPolicy,
      localSummary,
      externalUrls
    }
    const existing = (await this.list(profile.id)).reverse()
    const next = [...existing, record].slice(-MAX_RECORDS)
    await mkdir(this.root, { recursive: true })
    const path = this.file(profile.id)
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    return [...next].reverse()
  }

  async clear(profileId: string): Promise<void> {
    await rm(this.file(profileId), { force: true })
  }
}
