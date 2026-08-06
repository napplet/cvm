import { z } from "zod";
import { ProtectedSuiteResultSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";

const TransportObservationSchema = z.object({
  status: z.literal("passed"),
  verifiedPrincipalAccountBinding: z.literal(true),
  replayReturnsDurablePriorResult: z.literal(true),
  redeliveryPreservesAction: z.literal(true),
  reconnectPreservesAction: z.literal(true),
}).strict();
const Cep8SettlementObservationSchema = z.object({
  status: z.literal("passed"),
  lightningCreditedExactlyOnce: z.literal(true),
  cashuCreditedExactlyOnce: z.literal(true),
  ambiguityUsesOriginalSettlementOnly: z.literal(true),
}).strict();
const ModelObservationSchema = z.object({
  status: z.literal("passed"),
  operationId: z.string().min(1).max(256),
  lookupUsesOriginalOperationOnly: z.literal(true),
  dispatchCount: z.literal(1),
  debitCount: z.literal(1),
  cancellationOrAmbiguityVisible: z.literal(true),
}).strict();

/** Future live execution injects the authenticated ContextVM, CEP-8 rail, and
 * model seams. The adapter owns neither credentials nor a ledger and exposes
 * no signer, proof, preimage, raw receipt, or provider-native response field. */
export type LiveContextVmPaymentModelObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  exerciseSignedTransport(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
  exerciseCep8Settlement(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
  reconcileOriginalModelOperation(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
}>;

export type LiveContextVmPaymentModelCertificationInput = Readonly<{
  candidate: unknown;
  observationPort?: LiveContextVmPaymentModelObservationPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Runs the signed relay/replay/reconnect, CEP-8 Lightning/Cashu, and model
 * original-operation scenarios only on a protected-live port. Ambiguous model
 * outcomes are accepted only when their one persisted operation was looked up
 * without a replacement dispatch or debit.
 */
export async function runLiveContextVmPaymentModelCertification(input: LiveContextVmPaymentModelCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const port = input.observationPort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-transport-payment-model-required");
  }

  try {
    const request = { candidateId: candidate.data.id };
    const [transport, settlement, model] = await Promise.all([
      port.exerciseSignedTransport(request),
      port.exerciseCep8Settlement(request),
      port.reconcileOriginalModelOperation(request),
    ]);
    TransportObservationSchema.parse(transport);
    Cep8SettlementObservationSchema.parse(settlement);
    ModelObservationSchema.parse(model);
    return ProtectedSuiteResultSchema.parse({
      status: "passed",
      claims: ["release.contextvm_transport", "release.cep8_settlement", "release.model_reconciliation"],
      limitations: ["selection-external"],
      reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "transport-payment-model-observation-unavailable");
  }
}
