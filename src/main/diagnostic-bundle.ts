import type { BrowserProfile } from '../shared/types'
import { redactSensitiveText } from './redaction'

export interface DiagnosticZipEntry {
  name: string
  data: string | Buffer
}

export function diagnosticProfileSummary(profile: BrowserProfile): Record<string, unknown> {
  const check = profile.proxyCheck
  return {
    id: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    group: profile.group,
    tags: [...profile.tags],
    status: profile.status,
    kernelVersion: profile.kernelVersion || undefined,
    kernelFamily: profile.kernelFamily,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastOpenedAt: profile.lastOpenedAt,
    lastError: profile.lastError ? redactSensitiveText(profile.lastError) : undefined,
    proxy: {
      protocol: profile.proxy.protocol,
      credentialsConfigured: Boolean(profile.proxy.username || profile.proxy.password || profile.proxy.passwordStored),
      check: check ? {
        ok: check.ok,
        ip: check.ip,
        latencyMs: check.latencyMs,
        error: check.error ? redactSensitiveText(check.error) : undefined,
        warning: check.warning ? redactSensitiveText(check.warning) : undefined,
        degraded: check.degraded,
        countryCode: check.countryCode,
        region: check.region,
        city: check.city,
        timezone: check.timezone,
        ipVersion: check.ipVersion,
        asn: check.asn,
        organization: check.organization,
        isp: check.isp,
        networkRisk: check.networkRisk,
        geoConfidence: check.geoConfidence,
        geoConflict: check.geoConflict,
        checkedAt: check.checkedAt,
        exitChanged: check.exitChanged,
        previousIp: check.previousIp
      } : undefined
    },
    fingerprint: {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
  }
}

export function redactDiagnosticText(value: string, privateValues: string[] = []): string {
  let redacted = redactSensitiveText(value)
    .replace(/("(?:password|passwd|secret|token|authorization)"\s*:\s*)"(?:\\.|[^"])*"/gi, '$1"[REDACTED]"')
  const unique = [...new Set(privateValues.filter((item) => item.length >= 3))].sort((a, b) => b.length - a.length)
  for (const privateValue of unique) {
    for (const variant of [privateValue, privateValue.replace(/\\/g, '\\\\')]) {
      redacted = redacted.split(variant).join('[REDACTED_LOCAL]')
    }
  }
  return redacted
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function safeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('../') || normalized === '..') throw new Error('诊断包文件名无效')
  return normalized
}

function dosTimestamp(date: Date): { time: number; day: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

export function createStoredZip(entries: DiagnosticZipEntry[], now = new Date()): Buffer {
  if (!entries.length) throw new Error('诊断包没有可写入的内容')
  if (entries.length > 1000) throw new Error('诊断包文件数量过多')
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const stamp = dosTimestamp(now)

  for (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error('诊断包单个文件过大')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.day, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.day, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}
