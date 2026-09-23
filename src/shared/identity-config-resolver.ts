export type IdentityConfigSource = 'default' | 'ai' | 'user'

export interface IdentityConfigValue<T = unknown> {
  value: T
  source: IdentityConfigSource
  updatedAt: string
}

export interface IdentityConfigLayer {
  fingerprint: Record<string, IdentityConfigValue>
  network: Record<string, IdentityConfigValue>
  locale: Record<string, IdentityConfigValue>
}

export interface ResolvedIdentityConfig {
  fingerprint: Record<string, unknown>
  network: Record<string, unknown>
  locale: Record<string, unknown>
}

function resolveValue(config?: IdentityConfigValue): unknown {
  return config?.value
}

function resolveLayer(layer: Record<string, IdentityConfigValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(layer).map(([key, config]) => [key, resolveValue(config)])
  )
}

export function resolveIdentityConfig(
  config: IdentityConfigLayer
): ResolvedIdentityConfig {
  return {
    fingerprint: resolveLayer(config.fingerprint),
    network: resolveLayer(config.network),
    locale: resolveLayer(config.locale)
  }
}

export function createIdentityConfigValue<T>(
  value: T,
  source: IdentityConfigSource
): IdentityConfigValue<T> {
  return {
    value,
    source,
    updatedAt: new Date().toISOString()
  }
}
