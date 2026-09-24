import type { IdentityIntent } from './types'

export function normalizeIdentityIntent(value: IdentityIntent | undefined): IdentityIntent {
  const targetCountryCode = value?.targetCountryCode?.trim().toUpperCase() || undefined
  if (targetCountryCode && !/^[A-Z]{2}$/.test(targetCountryCode)) {
    throw new Error('目标国家必须使用 ISO 两位国家代码，例如 US、GB、DE')
  }
  const strategy = value?.strategy === 'ai_assisted' ? 'ai_assisted' : 'manual'
  const selfHealingMode = value?.selfHealingMode === 'manual' || value?.selfHealingMode === 'auto'
    ? value.selfHealingMode
    : 'assisted'
  const lastGeneratedAt = value?.lastGeneratedAt
  if (lastGeneratedAt !== undefined && !Number.isFinite(Date.parse(lastGeneratedAt))) {
    throw new Error('Identity Intent 生成时间无效')
  }
  const lastGeneratedCountryCode = value?.lastGeneratedCountryCode?.trim().toUpperCase() || undefined
  if (lastGeneratedCountryCode && !/^[A-Z]{2}$/.test(lastGeneratedCountryCode)) {
    throw new Error('Identity Intent 生成国家无效')
  }
  return {
    schemaVersion: 1,
    targetCountryCode,
    strategy,
    selfHealingMode,
    ...(lastGeneratedAt ? { lastGeneratedAt } : {}),
    ...(value?.lastGenerator === 'identity-ai-v1' ? { lastGenerator: value.lastGenerator } : {}),
    ...(value?.lastGeneratedPersonaId?.trim() ? { lastGeneratedPersonaId: value.lastGeneratedPersonaId.trim() } : {}),
    ...(lastGeneratedCountryCode ? { lastGeneratedCountryCode } : {})
  }
}
