import { z } from "zod";
import type { AuthenticatedNwcInvoiceTransport } from "../../funding/nwc-receipt-port";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "./postgres-operation-journal";

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

/** Runtime material is resolved only by a broker-held NWC session. The
 * descriptor never accepts connection strings, tokens, proof bytes, or keys. */
export type ProductionNwcTransport = AuthenticatedNwcInvoiceTransport & Readonly<{
  journal: PostgresOperationJournal;
}>;

function assertNwcTransport(value: unknown): asserts value is ProductionNwcTransport {
  try {
    if (!value || typeof value !== "object" || typeof (value as ProductionNwcTransport).request !== "function") throw new Error("invalid");
    assertPostgresOperationJournal((value as ProductionNwcTransport).journal);
  } catch { throw new Error("NWC_DURABLE_JOURNAL_REQUIRED"); }
}

/** Reference-only NWC and funded-Cashu rails. Consent, wallet access, and
 * settlement dispatch remain injected operational steps after authorization. */
export function createPaymentDeploymentClients(input: Readonly<{ nwcConnectionReference: unknown; cashuWalletReference: unknown; nwcTransport?: ProductionNwcTransport }>) {
  const nwcConnectionReference = consentReference(input.nwcConnectionReference);
  const cashuWalletReference = consentReference(input.cashuWalletReference);
  if (input.nwcTransport !== undefined) assertNwcTransport(input.nwcTransport);
  return Object.freeze({
    nwc: rail("nwc_lightning", nwcConnectionReference),
    cashu: rail("cashu", cashuWalletReference),
    ...(input.nwcTransport ? { nwcTransport: input.nwcTransport } : {}),
  });
}
