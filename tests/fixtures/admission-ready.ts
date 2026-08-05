import type { AdmissionLifecycleContext } from "../../src/telemetry/contracts";
import type { CapacityReservation } from "../../src/funding/funded-admission";

/** A receipt context explicitly captured before test admission dispatch. */
export const trustedAdmissionReceipt: AdmissionLifecycleContext = Object.freeze({
  version: "admission-lifecycle-v1",
  receiptMonotonicMs: 1,
  correlationDigest: `sha256:${"d".repeat(64)}`,
});

/**
 * Builds a test double for the capacity provider's trusted, exact-ready
 * receipt. The caller supplies the intent supplied by the admission service;
 * this fixture never guesses an intent or makes a ready proof optional.
 */
export function exactReadyReservation(intentReference: string, reference: string, expiresAt: string): CapacityReservation {
  return {
    status: "available",
    reference,
    expiresAt,
    ready: {
      intentReference,
      leaseReference: reference,
      sessionBindingDigest: `sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"b".repeat(64)}`,
      readinessProbeDigest: `sha256:${"c".repeat(64)}`,
      readyMonotonicMs: 2,
    },
  };
}
