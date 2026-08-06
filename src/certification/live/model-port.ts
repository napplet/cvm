import { z } from "zod";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../../release/authorization";
import type { NativeHttpModelGateway } from "../../release/native/model";
import { ModelReconciliationService } from "../../model/reconciliation";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const CandidateSchema = z.object({ candidateId: DigestSchema }).strict();
const ReconciliationCommandSchema = z.object({
  principal: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/iu) }).strict(),
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  operationId: z.string().min(1),
}).strict();

export type ProtectedLiveModelPort = Readonly<{
  evidenceClass: "protected_live";
  reconcileOriginalModelOperation(candidate: Readonly<{ candidateId: string }>): Promise<Readonly<{
    status: "passed";
    operationId: string;
    lookupUsesOriginalOperationOnly: true;
    dispatchCount: 1;
    debitCount: 1;
    cancellationOrAmbiguityVisible: true;
  }>>;
}>;

/**
 * Protected certification has no model client of its own: it revalidates the
 * exact v2 receipt and asks the existing reconciliation service to look up the
 * one stored operation. Provider bodies, tokens, headers, prompts, and usage
 * quantities never cross this finite observation boundary.
 */
export function createProtectedLiveModelPort(input: Readonly<{
  candidateSha256: string;
  request: unknown;
  receipt: unknown;
  gateway: NativeHttpModelGateway;
  reconciliation: ModelReconciliationService;
  reconciliationCommand: unknown;
  now?: () => number;
}>): ProtectedLiveModelPort {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const command = ReconciliationCommandSchema.parse(input.reconciliationCommand);
  const now = input.now ?? Date.now;
  return Object.freeze({
    evidenceClass: "protected_live" as const,
    async reconcileOriginalModelOperation(candidate) {
      if (CandidateSchema.parse(candidate).candidateId !== candidateSha256) throw new Error("NATIVE_MODEL_CANDIDATE_MISMATCH");
      let request;
      try {
        request = await validateAuthorizationRequest(input.request);
        await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs: now() });
      } catch {
        throw new Error("NATIVE_MODEL_AUTHORIZATION_INVALID");
      }
      const discovery = input.gateway.discovery();
      if (now() >= discovery.freshUntilMs) throw new Error("NATIVE_MODEL_CAPABILITY_STALE");
      if (request.candidateSha256 !== candidateSha256 || request.providerCapabilitiesSha256 !== discovery.capabilitySha256) throw new Error("NATIVE_MODEL_AUTHORIZATION_MISMATCH");
      const result = await input.reconciliation.reconcile(command);
      if (result.status !== "failed" || result.code !== "RECONCILED_RECEIPT_FOUND" || result.operationId !== command.operationId || input.gateway.dispatchCount(command.operationId) !== 1 || input.gateway.lookupCount(command.operationId) < 1) {
        throw new Error("NATIVE_MODEL_RECONCILIATION_BLOCKED");
      }
      return Object.freeze({ status: "passed" as const, operationId: command.operationId, lookupUsesOriginalOperationOnly: true as const, dispatchCount: 1 as const, debitCount: 1 as const, cancellationOrAmbiguityVisible: true as const });
    },
  });
}
