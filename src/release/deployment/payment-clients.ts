import { z } from "zod";

const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ReferenceSchema = z.string().regex(/^(?:nwc|cashu):[a-z][a-z0-9:._/-]{2,255}$/iu);

function consentReference(value: unknown): string {
  const parsed = ReferenceSchema.parse(value);
  if (/(?:nsec|private|secret|token|proof)/iu.test(parsed)) throw new Error("DEPLOYMENT_SECRET_REFERENCE_INVALID");
  return parsed;
}

function rail(rail: "nwc_lightning" | "cashu", consentReference: string) {
  return Object.freeze({
    discovery: () => Object.freeze({ rail, consentReference }),
    async reconcileOriginal(input: Readonly<{ originalOperationId: unknown; receiptOperationId: unknown }>) {
      const originalOperationId = OperationSchema.parse(input.originalOperationId);
      try {
        if (OperationSchema.parse(input.receiptOperationId) !== originalOperationId) throw new Error("receipt mismatch");
        return Object.freeze({ status: "reconciled" as const, originalOperationId });
      } catch {
        return Object.freeze({ status: "blocked" as const, originalOperationId });
      }
    },
  });
}

/** Reference-only NWC and funded-Cashu rails. Consent, wallet access, and
 * settlement dispatch remain injected operational steps after authorization. */
export function createPaymentDeploymentClients(input: Readonly<{ nwcConnectionReference: unknown; cashuWalletReference: unknown }>) {
  const nwcConnectionReference = consentReference(input.nwcConnectionReference);
  const cashuWalletReference = consentReference(input.cashuWalletReference);
  return Object.freeze({
    nwc: rail("nwc_lightning", nwcConnectionReference),
    cashu: rail("cashu", cashuWalletReference),
  });
}
