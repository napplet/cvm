import type { CapacityReservation } from "../../src/funding/funded-admission";
import { HmacAdmissionReceiptAuthority, type AdmissionReceipt } from "../../src/funding/admission-receipt";

/** Explicit deterministic test authority; production composition never supplies a fallback key. */
export const trustedAdmissionReceiptAuthority = new HmacAdmissionReceiptAuthority({
  secret: new Uint8Array(32).fill(7),
  now: () => 1,
});

export async function trustedAdmissionReceipt(command: unknown, expectedSessionBindingDigest = `sha256:${"a".repeat(64)}`): Promise<AdmissionReceipt> {
  return trustedAdmissionReceiptAuthority.issue({
    command,
    correlationDigest: `sha256:${"d".repeat(64)}`,
    expectedSessionBindingDigest,
  });
}

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
