export type AiConfigSource =
  | 'system'
  | 'ai_generated'
  | 'user_override'
  | 'imported'

export interface ConfigValue<T> {
  value: T
  source: AiConfigSource
  updatedAt: string
}

/**
 * AI can generate and suggest configuration, but user overrides always win.
 */
export interface EffectiveConfigLayer<T> {
  system?: ConfigValue<T>
  aiGenerated?: ConfigValue<T>
  userOverride?: ConfigValue<T>
  imported?: ConfigValue<T>
}

export function resolveEffectiveConfig<T>(layer: EffectiveConfigLayer<T>): ConfigValue<T> | undefined {
  return (
    layer.userOverride ??
    layer.imported ??
    layer.aiGenerated ??
    layer.system
  )
}

export interface AiAgentToolPermission {
  tool:
    | 'diagnose'
    | 'inspect'
    | 'suggest_fix'
    | 'apply_fix'
  requiresConfirmation: boolean
}

export const DEFAULT_AI_AGENT_PERMISSIONS: AiAgentToolPermission[] = [
  {
    tool: 'diagnose',
    requiresConfirmation: false
  },
  {
    tool: 'inspect',
    requiresConfirmation: false
  },
  {
    tool: 'suggest_fix',
    requiresConfirmation: false
  },
  {
    tool: 'apply_fix',
    requiresConfirmation: true
  }
]
