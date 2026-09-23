import type { IdentityBaseline, IdentityBaselineSnapshot, IdentityDriftReport } from '../shared/identity-baseline-model'
import { compareIdentityBaseline } from '../shared/identity-drift-engine'
import { normalizeIdentityConfigProvenance } from '../shared/identity-config-provenance'
import type { IdentityConfigProvenance } from '../shared/types'
import type { IdentityBaselineReplacementRequest, IdentityBaselineStore } from './identity-baseline-store'

export interface RuntimeIdentityEvaluation {
  baseline?: IdentityBaseline
  baselineCreated: boolean
  drift?: IdentityDriftReport
  replacementRequest?: IdentityBaselineReplacementRequest
  baselineReplaced?: boolean
}

export interface RuntimeIdentityEvaluationOptions {
  allowCreateBaseline?: boolean
}

/**
 * Connects normalized runtime observations to the persisted Profile baseline.
 * A new baseline is only established from a runtime that passed the caller's
 * health gate. Once a baseline exists, every runtime observation is compared
 * so risky states (for example SwiftShader fallback) cannot be hidden by the
 * same health gate.
 */
export async function evaluateRuntimeIdentity(
  store: IdentityBaselineStore,
  profileId: string,
  snapshot: IdentityBaselineSnapshot,
  provenance: IdentityConfigProvenance | undefined,
  options: RuntimeIdentityEvaluationOptions = {}
): Promise<RuntimeIdentityEvaluation> {
  let baseline = await store.get(profileId)
  const replacementRequest = await store.pendingReplacement(profileId)

  if (!baseline) {
    if (options.allowCreateBaseline === false) {
      return { baselineCreated: false }
    }
    baseline = await store.create(
      profileId,
      snapshot,
      normalizeIdentityConfigProvenance(provenance)
    )
    return {
      baseline,
      baselineCreated: true
    }
  }

  if (replacementRequest) {
    if (options.allowCreateBaseline === false) {
      return {
        baseline,
        baselineCreated: false,
        replacementRequest,
        baselineReplaced: false
      }
    }

    baseline = await store.create(
      profileId,
      snapshot,
      normalizeIdentityConfigProvenance(provenance)
    )
    return {
      baseline,
      baselineCreated: true,
      replacementRequest,
      baselineReplaced: true
    }
  }

  const drift = compareIdentityBaseline(
    profileId,
    baseline.id,
    baseline.snapshot,
    snapshot
  )

  baseline = drift.driftDetected
    ? (await store.markStale(profileId)) ?? baseline
    : (await store.markVerified(profileId)) ?? baseline

  return {
    baseline,
    baselineCreated: false,
    drift
  }
}
