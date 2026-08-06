import type { LiveAdmissionObservationPort } from "./admission";
import type { LiveChaosFaultPort } from "./chaos";
import type { LiveContextVmPaymentModelObservationPort } from "./contextvm-payment-model";
import type { LivePublicationObservationPort } from "./publication";
import type { LiveRestorePort } from "./restore";
import type { LiveSecurityHostObservationPort } from "./security-host";
import type { LiveSupplyChainObservationPort } from "./supply-chain";
import type { LiveTelemetryObservationPort } from "./telemetry";

type Real<T> = Omit<T, "evidenceClass"> & Readonly<{ evidenceClass: "real" }>;

/** The public production shape deliberately has exactly the eight D-131 suites. */
export type ProductionLiveProtectedCertificationPorts = Readonly<{
  admission: Real<LiveAdmissionObservationPort>;
  telemetry: Real<LiveTelemetryObservationPort>;
  chaos: Real<LiveChaosFaultPort>;
  durability: Real<LiveRestorePort>;
  "security-host": Real<LiveSecurityHostObservationPort>;
  "supply-chain": Real<LiveSupplyChainObservationPort>;
  "ContextVM-payment-model": Real<LiveContextVmPaymentModelObservationPort>;
  publication: Real<LivePublicationObservationPort>;
}>;

export const PRODUCTION_LIVE_PROTECTED_PORT_KEYS = Object.freeze([
  "admission", "telemetry", "chaos", "durability", "security-host", "supply-chain", "ContextVM-payment-model", "publication",
] as const);

/**
 * Construction is pure. Real ports are supplied only by the protected runner;
 * this boundary rejects deterministic, cached, manual, and fixture adapters
 * before any evaluator receives one.
 */
export function createProductionLiveProtectedCertificationPorts(input: ProductionLiveProtectedCertificationPorts): ProductionLiveProtectedCertificationPorts {
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || (value as { evidenceClass?: unknown }).evidenceClass !== "real") {
      throw new Error("PRODUCTION_LIVE_PORT_REAL_EVIDENCE_REQUIRED");
    }
  }
  const actual = Object.keys(input).sort();
  const expected = [...PRODUCTION_LIVE_PROTECTED_PORT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("PRODUCTION_LIVE_PORT_EXACT_SET_REQUIRED");
  }
  return Object.freeze({ ...input });
}
