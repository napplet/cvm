import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import type { ProductionConfig } from "./config";
import type { MountedProductionSecretMaterial } from "./secret-material";

/** Loads the controller-canonical receipt pair from explicit mounts. The pair
 * is validated against this candidate/topology before any session, migration,
 * or private certification capability can be assembled. */
export async function createMountedProductionAuthorization(input: Readonly<{ config: ProductionConfig; secrets: MountedProductionSecretMaterial; now?: () => number }>) {
  const [requestRaw, receiptRaw] = await Promise.all([
    input.secrets.text("certification.authorizationRequestReference", 1_000_000),
    input.secrets.text("certification.authorizationReceiptReference", 1_000_000),
  ]);
  let requestValue: unknown; let receiptValue: unknown;
  try { requestValue = JSON.parse(requestRaw); receiptValue = JSON.parse(receiptRaw); } catch { throw new Error("PRODUCTION_AUTHORIZATION_MOUNT_INVALID"); }
  const request = await validateAuthorizationRequest(requestValue);
  const receipt = await validateAuthorizationReceipt({ request, receipt: receiptValue, nowMs: (input.now ?? Date.now)() });
  if (request.candidateSha256 !== input.config.candidateSha256 || request.topologySha256 !== input.config.topologySha256 || receipt.candidateSha256 !== input.config.candidateSha256 || receipt.topologySha256 !== input.config.topologySha256) throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_INVALID");
  return Object.freeze({ request: requestValue, receipt: receiptValue, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 });
}
