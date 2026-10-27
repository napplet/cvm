/**
 * Production worker controls deliberately do not reuse the immutable Phase 2
 * fixture. A live worker must remain available for the ten-minute continuity
 * grace window, while the Phase 2 fixture retains its historical 20/2 limits.
 *
 * Provider SDKs are intentionally given only fields they document. Controls
 * without a provider API (read-only toolchain ownership and capability
 * dropping) are established by the sealed image and checked by the trusted
 * probe before readiness can be reported.
 */
export const PRODUCTION_WORKER_POLICY = Object.freeze({
  version: "production-worker-policy-2026-10-27",
  cpu: 1,
  cpuLimit: 2,
  memoryMiB: 1_024,
  memoryLimitMiB: 2_048,
  /** Active agent/build work is independently bounded.  This is not the
   * continuity window: an insufficient-balance pause may retain an otherwise
   * idle worker for a further ten minutes. */
  activeWorkTimeoutMs: 600_000,
  idleGraceMs: 600_000,
  totalLifetimeMs: 1_200_000,
  // Compatibility aliases for SDK adapters; both retain their historical
  // meaning and must never be used to collapse active work and pause grace.
  timeoutMs: 1_200_000,
  idleTimeoutMs: 600_000,
  blockNetwork: true as const,
  noInboundPorts: true as const,
  nonRootUid: 65_532,
  workspaceRoot: "/workspace",
  readinessCommand: Object.freeze(["/usr/local/bin/napplet-cvm-worker", "ready"]),
  probeCommand: Object.freeze(["/usr/local/bin/napplet-cvm-probe", "observe-isolation"]),
  requiredChecks: Object.freeze([
    "toolchain_readonly",
    "workspace_bounded",
    "non_root",
    "no_ambient_credentials",
    "network_denied",
    "no_inbound_ports",
    "minimal_capabilities",
  ]),
});

export type ProductionWorkerPolicy = typeof PRODUCTION_WORKER_POLICY;
