import { isDeepStrictEqual } from 'node:util'
import type { BrowserProfile, ProfileDraft, ProxyConfig } from '../shared/types'
import type {
  IdentityBaselineReplacementReason,
  IdentityBaselineStore
} from './identity-baseline-store'

type IdentityRelevantProfile = Pick<
  BrowserProfile,
  'kernelVersion' | 'kernelFamily' | 'proxy' | 'fingerprint'
>

type IdentityRelevantDraft = Pick<
  ProfileDraft,
  'kernelVersion' | 'kernelFamily' | 'proxy' | 'fingerprint'
>

function proxyRoute(proxy: ProxyConfig): Pick<ProxyConfig, 'protocol' | 'host' | 'port' | 'username'> {
  return {
    protocol: proxy.protocol,
    host: proxy.host.trim(),
    port: proxy.port,
    username: proxy.username
  }
}

export function identityRelevantProfileChanged(
  before: IdentityRelevantProfile,
  after: IdentityRelevantProfile | IdentityRelevantDraft
): boolean {
  return before.kernelVersion !== after.kernelVersion
    || before.kernelFamily !== after.kernelFamily
    || !isDeepStrictEqual(proxyRoute(before.proxy), proxyRoute(after.proxy))
    || !isDeepStrictEqual(before.fingerprint, after.fingerprint)
}

export async function requestBaselineReplacementForChange(
  store: IdentityBaselineStore,
  before: IdentityRelevantProfile,
  after: IdentityRelevantProfile | IdentityRelevantDraft,
  reason: IdentityBaselineReplacementReason
): Promise<boolean> {
  if (!identityRelevantProfileChanged(before, after)) return false
  return Boolean(await store.requestReplacement((before as BrowserProfile).id, reason))
}
