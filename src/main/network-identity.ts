import type { ProxyCheckSummary, ProxyConfig } from '../shared/types'

export type NetworkIdentityStatus = 'active' | 'warning' | 'conflict' | 'disabled'

export interface NetworkIdentity {
  id: string
  name: string

  /** Optional managed proxy pool binding. */
  proxyPoolEntryId?: string
  proxy?: ProxyConfig

  verifiedIp?: string
  country?: string
  countryCode?: string
  region?: string
  city?: string
  timezone?: string
  language?: string
  isp?: string
  asn?: number

  webrtcPolicy?: 'proxy_only' | 'public_only' | 'default'

  score: number
  status: NetworkIdentityStatus

  lastVerifiedAt?: string
  createdAt: string
  updatedAt: string

  lastCheck?: ProxyCheckSummary
}

export interface NetworkIdentitySnapshot {
  checkedAt: string
  ip?: string
  countryCode?: string
  city?: string
  timezone?: string
  isp?: string
  asn?: number
}

export interface NetworkIdentityConflict {
  type:
    | 'ip_changed'
    | 'geo_changed'
    | 'isp_changed'
    | 'asn_changed'
    | 'timezone_changed'
  previous?: NetworkIdentitySnapshot
  current?: NetworkIdentitySnapshot
  message: string
}

export function createNetworkIdentity(input: Pick<NetworkIdentity, 'id' | 'name'>): NetworkIdentity {
  const now = new Date().toISOString()

  return {
    id: input.id,
    name: input.name,
    score: 0,
    status: 'warning',
    createdAt: now,
    updatedAt: now
  }
}

export function detectIdentityDrift(
  previous: NetworkIdentitySnapshot,
  current: NetworkIdentitySnapshot
): NetworkIdentityConflict[] {
  const conflicts: NetworkIdentityConflict[] = []

  if (previous.ip && current.ip && previous.ip !== current.ip) {
    conflicts.push({
      type: 'ip_changed',
      previous,
      current,
      message: 'Exit IP changed'
    })
  }

  if (previous.countryCode && current.countryCode && previous.countryCode !== current.countryCode) {
    conflicts.push({
      type: 'geo_changed',
      previous,
      current,
      message: 'Country changed'
    })
  }

  if (previous.isp && current.isp && previous.isp !== current.isp) {
    conflicts.push({
      type: 'isp_changed',
      previous,
      current,
      message: 'ISP changed'
    })
  }

  if (previous.asn && current.asn && previous.asn !== current.asn) {
    conflicts.push({
      type: 'asn_changed',
      previous,
      current,
      message: 'ASN changed'
    })
  }

  if (previous.timezone && current.timezone && previous.timezone !== current.timezone) {
    conflicts.push({
      type: 'timezone_changed',
      previous,
      current,
      message: 'Timezone changed'
    })
  }

  return conflicts
}
