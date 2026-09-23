export type IdentityConfigSource = 'default' | 'ai' | 'user'

export interface IdentityConfigValue<T = unknown> {
  value: T
  source: IdentityConfigSource
  updatedAt?: string
}

export interface IdentityConfigProfile {
  fingerprint: Record<string, IdentityConfigValue>
  network: Record<string, IdentityConfigValue>
  locale: Record<string, IdentityConfigValue>
  browser: Record<string, IdentityConfigValue>
}

const priority: Record<IdentityConfigSource, number> = {
  default: 0,
  ai: 1,
  user: 2
}

export function resolveIdentityConfigValue<T>(
  values: Array<IdentityConfigValue<T> | undefined>
): IdentityConfigValue<T> | undefined {
  return values
    .filter((item): item is IdentityConfigValue<T> => Boolean(item))
    .sort((a, b) => priority[b.source] - priority[a.source])[0]
}

export function resolveIdentityConfig(
  defaults: IdentityConfigProfile,
  ai: Partial<IdentityConfigProfile>,
  user: Partial<IdentityConfigProfile>
): IdentityConfigProfile {
  const resolveSection = (
    section: keyof IdentityConfigProfile
  ): Record<string, IdentityConfigValue> => {
    const keys = new Set([
      ...Object.keys(defaults[section] ?? {}),
      ...Object.keys(ai[section] ?? {}),
      ...Object.keys(user[section] ?? {})
    ])
    const resolved: Record<string, IdentityConfigValue> = {}

    for (const key of keys) {
      const value = resolveIdentityConfigValue([
        defaults[section][key],
        ai[section]?.[key],
        user[section]?.[key]
      ])
      if (value) resolved[key] = value
    }

    return resolved
  }

  return {
    fingerprint: resolveSection('fingerprint'),
    network: resolveSection('network'),
    locale: resolveSection('locale'),
    browser: resolveSection('browser')
  }
}
