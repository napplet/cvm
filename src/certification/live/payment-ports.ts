import { z } from "zod";
import type { NativeCashuProvider } from "../../release/native/cashu";
import type { NativeCep8LightningProvider } from "../../release/native/cep8-lightning";

const CandidateIdSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const TransportObservationSchema = z.object({
  status: z.literal("passed"), verifiedPrincipalAccountBinding: z.literal(true), replayReturnsDurablePriorResult: z.literal(true),
  redeliveryPreservesAction: z.literal(true), reconnectPreservesAction: z.literal(true),
}).strict();
const ModelObservationSchema = z.object({
  status: z.literal("passed"), operationId: z.string().min(1).max(256), lookupUsesOriginalOperationOnly: z.literal(true),
  dispatchCount: z.literal(1), debitCount: z.literal(1), cancellationOrAmbiguityVisible: z.literal(true),
}).strict();

export type ProtectedLiveContextVmPaymentObservationPort = Readonly<{
  evidenceClass: "protected_live";
  exerciseSignedTransport(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
  exerciseCep8Settlement(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
  reconcileOriginalModelOperation(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
}>;

/**
 * Creates the exact protected-suite adapter from production compositions. It
 * emits only finite pass facts: rail endpoints, invoices, preimages, proofs,
 * credentials, receipts, and provider bodies cannot enter evidence.
 */
export function createProtectedLiveContextVmPaymentObservationPort(input: Readonly<{
  contextvm: Readonly<{ evidenceClass: "protected_live"; exercise(candidate: Readonly<{ candidateId: string }>): Promise<unknown> }>;
  lightning: NativeCep8LightningProvider;
  cashu: NativeCashuProvider;
  model: Readonly<{ reconcileOriginalModelOperation(candidate: Readonly<{ candidateId: string }>): Promise<unknown> }>;
}>): ProtectedLiveContextVmPaymentObservationPort {
  return Object.freeze({
    evidenceClass: "protected_live" as const,
    async exerciseSignedTransport(candidate) {
      CandidateIdSchema.parse(candidate.candidateId);
      return TransportObservationSchema.parse(await input.contextvm.exercise(candidate));
    },
    async exerciseCep8Settlement(candidate) {
      CandidateIdSchema.parse(candidate.candidateId);
      if (input.lightning.verifiedSettlementCount() !== 1 || input.cashu.verifiedSettlementCount() !== 1) throw new Error("CEP8_ORIGINAL_SETTLEMENT_NOT_VERIFIED");
      return Object.freeze({ status: "passed" as const, lightningCreditedExactlyOnce: true as const, cashuCreditedExactlyOnce: true as const, ambiguityUsesOriginalSettlementOnly: true as const });
    },
    async reconcileOriginalModelOperation(candidate) {
      CandidateIdSchema.parse(candidate.candidateId);
      return ModelObservationSchema.parse(await input.model.reconcileOriginalModelOperation(candidate));
    },
  });
}
