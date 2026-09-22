import type { KernelFamily, KernelRelease } from './types'

const KERNEL_VERSION_PATTERN = /^\d+(?:\.\d+){3}$/

export function validKernelVersion(version: string): boolean {
  return KERNEL_VERSION_PATTERN.test(version.trim())
}

export function compareKernelVersions(first: string, second: string): number {
  if (!validKernelVersion(first) || !validKernelVersion(second)) {
    throw new Error('内核版本号无效')
  }
  const left = first.trim().split('.').map(Number)
  const right = second.trim().split('.').map(Number)
  for (let index = 0; index < 4; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function isKernelDowngrade(currentVersion: string, nextVersion: string): boolean {
  const current = currentVersion.trim()
  const next = nextVersion.trim()
  if (!current || !next) return false
  return compareKernelVersions(next, current) < 0
}

export function latestKernelVersion(versions: string[]): string | undefined {
  const valid = versions.map((version) => version.trim()).filter(validKernelVersion)
  if (!valid.length) return undefined
  return valid.reduce((latest, version) => compareKernelVersions(version, latest) > 0 ? version : latest)
}

export function newerKernelVersion(currentVersion: string, candidates: string[]): string | undefined {
  const current = currentVersion.trim()
  if (!validKernelVersion(current)) return undefined
  const latest = latestKernelVersion(candidates)
  return latest && compareKernelVersions(latest, current) > 0 ? latest : undefined
}

export function kernelFamilyForRelease(release: Pick<KernelRelease, 'origin'>): KernelFamily {
  return release.origin === 'local-build' ? 'custom' : 'fingerprint-chromium'
}

export function kernelReleaseMatchesPin(
  release: Pick<KernelRelease, 'version' | 'origin' | 'executable'>,
  version: string,
  family?: KernelFamily
): boolean {
  if (release.version !== version || !release.executable) return false
  return !family || kernelFamilyForRelease(release) === family
}

export function newerCompatibleKernelVersion(
  currentVersion: string,
  family: KernelFamily | undefined,
  releases: Array<Pick<KernelRelease, 'version' | 'origin' | 'executable'>>
): string | undefined {
  return newerKernelVersion(
    currentVersion,
    releases
      .filter((release) => Boolean(release.executable) && (!family || kernelFamilyForRelease(release) === family))
      .map((release) => release.version)
  )
}
