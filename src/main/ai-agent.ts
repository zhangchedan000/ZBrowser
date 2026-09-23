export type AiConfigSource =
  | 'system'
  | 'ai_generated'
  | 'user_override'
  | 'imported'

export interface AiConfigValue<T> {
  value: T
  source: AiConfigSource
  updatedAt: string
}

export interface AiToolPermission {
  tool: string
  requiresConfirmation: boolean
}

export interface AiAgentAction {
  id: string
  type: 'diagnose' | 'suggest' | 'repair'
  description: string
  requiresConfirmation: boolean
}

export interface AiAgentContext {
  profileId: string
  allowAutoRepair: boolean
}

export interface AiAgentCapability {
  name:
    | 'profile_diagnose'
    | 'fingerprint_check'
    | 'network_check'
    | 'suggest_fix'
    | 'apply_fix'
  description: string
  requiresConfirmation: boolean
}

/**
 * Foundation layer for future LLM integrations.
 * The model should call controlled tools instead of modifying browser state directly.
 */
export interface AiAgentProvider {
  capabilities(): AiAgentCapability[]
  diagnose(context: AiAgentContext): Promise<AiAgentAction[]>
}

export const defaultAiCapabilities: AiAgentCapability[] = [
  {
    name: 'profile_diagnose',
    description: 'Analyze browser profile state',
    requiresConfirmation: false
  },
  {
    name: 'fingerprint_check',
    description: 'Run fingerprint consistency checks',
    requiresConfirmation: false
  },
  {
    name: 'network_check',
    description: 'Analyze network identity state',
    requiresConfirmation: false
  },
  {
    name: 'suggest_fix',
    description: 'Generate repair suggestions',
    requiresConfirmation: false
  },
  {
    name: 'apply_fix',
    description: 'Apply browser configuration changes',
    requiresConfirmation: true
  }
]
