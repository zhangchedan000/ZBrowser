export type RuntimeIdentitySnapshot = {
  capturedAt: string;
  browser?: {
    userAgent?: string;
    platform?: string;
    language?: string;
    languages?: string[];
  };
  hardware?: {
    cpuCores?: number;
    deviceMemory?: number;
    screen?: {
      width?: number;
      height?: number;
      pixelRatio?: number;
    };
  };
  graphics?: {
    webglVendor?: string;
    webglRenderer?: string;
    webgpuAdapter?: string;
  };
  timezone?: string;
};

export type RuntimeIdentitySnapshotSource = {
  getSnapshot(): Promise<RuntimeIdentitySnapshot>;
};

/**
 * Normalizes runtime identity observations into the same shape consumed by
 * fingerprint health diagnostics. The adapter deliberately only accepts
 * observed runtime values; it does not mutate profile configuration.
 */
export class RuntimeIdentitySnapshotAdapter {
  constructor(private readonly source: RuntimeIdentitySnapshotSource) {}

  async capture(): Promise<RuntimeIdentitySnapshot> {
    const snapshot = await this.source.getSnapshot();

    return {
      capturedAt: snapshot.capturedAt || new Date().toISOString(),
      browser: snapshot.browser,
      hardware: snapshot.hardware,
      graphics: snapshot.graphics,
      timezone: snapshot.timezone,
    };
  }
}
