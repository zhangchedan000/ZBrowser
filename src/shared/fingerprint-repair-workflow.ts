import type { IdentityConfigSource } from './types'
import type { FingerprintComponent } from './fingerprint-health-model'

export type RepairWorkflowStatus =
  | 'draft'
  | 'awaiting_confirmation'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rolled_back'
  | 'failed'

export interface RepairAction {
  id: string
  component: FingerprintComponent
  description: string
  requiresBackup: boolean
  reversible: boolean
  mutatesConfiguration?: boolean
  configSources?: IdentityConfigSource[]
}

export interface RepairWorkflow {
  id: string
  status: RepairWorkflowStatus
  actions: RepairAction[]
  createdAt: string
  approvedByUser: boolean
}

export interface RepairExecutionResult {
  success: boolean
  status: RepairWorkflowStatus
  message: string
}

export function createRepairWorkflow(actions: RepairAction[]): RepairWorkflow {
  return {
    id: `repair-${Date.now()}`,
    status: 'awaiting_confirmation',
    actions,
    createdAt: new Date().toISOString(),
    approvedByUser: false
  }
}

export function approveRepairWorkflow(workflow: RepairWorkflow): RepairWorkflow {
  return {
    ...workflow,
    status: 'approved',
    approvedByUser: true
  }
}

export function validateRepairSafety(workflow: RepairWorkflow): boolean {
  return workflow.approvedByUser && workflow.actions.every((action) => {
    const protectedUserConfig = action.mutatesConfiguration === true
      && action.configSources?.includes('user') === true
    if (protectedUserConfig) return false
    return action.reversible || action.requiresBackup
  })
}
