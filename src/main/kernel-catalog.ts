import { kernelFamilyForRelease } from '../shared/kernel-version'
import type { EngineStatus, KernelFamily, KernelRelease } from '../shared/types'

function catalogKey(version: string, family: KernelFamily): string {
  return `${family}:${version}`
}

/**
 * The copy shipped with ZBrowser is authoritative for the bundled
 * fingerprint-chromium family at a version. A custom/local build with the same
 * Chromium version is a distinct kernel identity and must remain selectable.
 */
export function mergeKernelCatalog(managed: KernelRelease[], bundled: EngineStatus[]): KernelRelease[] {
  const byIdentity = new Map(
    managed.map((kernel) => [catalogKey(kernel.version, kernelFamilyForRelease(kernel)), kernel] as const)
  )
  for (const engine of bundled) {
    if (!engine.version || !engine.executable) continue
    byIdentity.set(catalogKey(engine.version, 'fingerprint-chromium'), {
      version: engine.version,
      publishedAt: '',
      assetName: 'bundled-with-zbrowser',
      downloadUrl: '',
      size: 0,
      sha256: '',
      installed: true,
      remoteAvailable: false,
      origin: 'bundled',
      executable: engine.executable
    })
  }
  return [...byIdentity.values()]
    .sort((first, second) => {
      const versionOrder = second.version.localeCompare(first.version, undefined, { numeric: true })
      if (versionOrder !== 0) return versionOrder
      return kernelFamilyForRelease(first).localeCompare(kernelFamilyForRelease(second))
    })
}
