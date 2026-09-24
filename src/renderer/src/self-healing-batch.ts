import type {
  BrowserProfileView,
  FingerprintRuntimeDiagnosticReport,
  IdentityProfileHealthSummary
} from '../../shared/types'

export interface SelfHealingBatchCheckSuccess {
  profile: BrowserProfileView
  report: FingerprintRuntimeDiagnosticReport
  health: IdentityProfileHealthSummary
}

export interface SelfHealingBatchCheckFailure {
  profileId: string
  profileName: string
  message: string
}

export interface SelfHealingBatchCheckResult {
  candidates: number
  successes: SelfHealingBatchCheckSuccess[]
  failures: SelfHealingBatchCheckFailure[]
}

export function selfHealingBatchCandidates(profiles: BrowserProfileView[]): BrowserProfileView[] {
  return profiles.filter((profile) => profile.status === 'closed' || profile.status === 'error')
}

export async function runSelfHealingBatchChecks(
  profiles: BrowserProfileView[],
  diagnose: (profile: BrowserProfileView) => Promise<FingerprintRuntimeDiagnosticReport>,
  identityHealth: (profile: BrowserProfileView) => Promise<IdentityProfileHealthSummary>
): Promise<SelfHealingBatchCheckResult> {
  const candidates = selfHealingBatchCandidates(profiles)
  const successes: SelfHealingBatchCheckSuccess[] = []
  const failures: SelfHealingBatchCheckFailure[] = []

  for (const profile of candidates) {
    try {
      const report = await diagnose(profile)
      const health = await identityHealth(profile)
      successes.push({ profile, report, health })
    } catch (error) {
      failures.push({
        profileId: profile.id,
        profileName: profile.name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { candidates: candidates.length, successes, failures }
}
