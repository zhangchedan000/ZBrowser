import {
  buildRuntimeIdentitySnapshot,
  type RuntimeIdentitySnapshotInput,
  type RuntimeIdentitySnapshotResult
} from '../shared/runtime-identity-snapshot'

export type RuntimeIdentitySnapshot = RuntimeIdentitySnapshotResult

export type RuntimeIdentitySnapshotSource = {
  getSnapshot(): Promise<RuntimeIdentitySnapshotInput>
}

/**
 * Main-process wrapper for runtime snapshot sources. Collection remains owned by
 * existing BrowserControlSession/CDP diagnostics; normalization is centralized
 * in the shared adapter so baseline/drift consumers see one canonical shape.
 */
export class RuntimeIdentitySnapshotAdapter {
  constructor(private readonly source: RuntimeIdentitySnapshotSource) {}

  async capture(): Promise<RuntimeIdentitySnapshotResult> {
    return buildRuntimeIdentitySnapshot(await this.source.getSnapshot())
  }
}
