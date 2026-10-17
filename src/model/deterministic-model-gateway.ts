import { canonicalJson } from "../promotion/schema";
import {
  ModelDispatchObservationSchema,
  ModelLookupObservationSchema,
  NormalizedUsageReceiptSchema,
  ProviderOperationIntentSchema,
  type ModelDispatchObservation,
  type ModelGateway,
  type ModelLookupObservation,
  type NormalizedUsageReceipt,
  type ProviderOperationIntent,
} from "./model-gateway";
import { z } from "zod";
import type { SourceProposalStore } from "../dev/source-proposal-store";

export const DeterministicGatewayScenarioSchema = z.object({
  dispatch: z.enum(["completed", "failed", "pre_dispatch_rejected", "accepted_timeout", "lost_response", "malformed_receipt", "mismatched_receipt", "uncertain_acceptance"]),
  lookup: z.enum(["pending", "receipt_found", "definitive_not_accepted", "unresolved"]),
}).strict();

export type DeterministicGatewayScenario = z.infer<typeof DeterministicGatewayScenarioSchema>;
export type DeterministicModelGatewayOptions = Readonly<{ scenario: DeterministicGatewayScenario; now?: () => string; proposalStore?: SourceProposalStore }>;

function frozen<T>(value: T): T { return Object.freeze(structuredClone(value)); }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Scenario-controlled fixture only. It deliberately carries no live provider
 * import, credential, model configuration, or dispatch path from lookup.
 */
export class DeterministicModelGateway implements ModelGateway {
  readonly #scenario: DeterministicGatewayScenario;
  readonly #now: () => string;
  readonly #dispatches = new Map<string, Promise<ModelDispatchObservation>>();
  readonly #dispatchCounts = new Map<string, number>();
  readonly #lookupCounts = new Map<string, number>();
  readonly #proposalReferences = new Map<string, string>();
  readonly #proposalStore?: SourceProposalStore;

  constructor(options: DeterministicModelGatewayOptions) {
    this.#scenario = frozen(DeterministicGatewayScenarioSchema.parse(options.scenario));
    this.#now = options.now ?? (() => "2026-08-04T00:00:00.000Z");
    this.#proposalStore = options.proposalStore;
  }

  dispatchCount(operationId: string): number { return this.#dispatchCounts.get(operationId) ?? 0; }
  lookupCount(operationId: string): number { return this.#lookupCounts.get(operationId) ?? 0; }

  async dispatch(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    const existing = this.#dispatches.get(intent.operationId);
    if (existing) return existing;
    this.#dispatchCounts.set(intent.operationId, this.dispatchCount(intent.operationId) + 1);
    const observation = this.dispatchOnce(intent, signal);
    this.#dispatches.set(intent.operationId, observation);
    return observation;
  }

  async lookup(input: ProviderOperationIntent, signal: AbortSignal): Promise<ModelLookupObservation> {
    const intent = ProviderOperationIntentSchema.parse(input);
    this.#lookupCounts.set(intent.operationId, this.lookupCount(intent.operationId) + 1);
    const provenance = await this.provenance(intent, "lookup");
    const correlation = { operationId: intent.operationId, providerRequestId: this.providerRequestId(intent), provenance };
    if (signal.aborted) return ModelLookupObservationSchema.parse({ status: "unresolved", ...correlation });
    if (this.#scenario.lookup === "receipt_found") {
      const persisted = this.#proposalStore ? await this.#proposalStore.lookup({ intent }) : undefined;
      const sourceProposalReference = this.#proposalReferences.get(intent.operationId) ?? persisted?.proposal.reference;
      return ModelLookupObservationSchema.parse({ status: "receipt_found", receipt: await this.receipt(intent, "lookup"), ...(sourceProposalReference ? { sourceProposalReference } : {}) });
    }
    if (this.#scenario.lookup === "definitive_not_accepted") return ModelLookupObservationSchema.parse({ status: "definitive_not_accepted", ...correlation, reason: "pre_dispatch_rejected" });
    return ModelLookupObservationSchema.parse({ status: this.#scenario.lookup, ...correlation });
  }

  private async dispatchOnce(intent: ProviderOperationIntent, signal: AbortSignal): Promise<ModelDispatchObservation> {
    const provenance = await this.provenance(intent, "dispatch");
    const correlation = { operationId: intent.operationId, providerRequestId: this.providerRequestId(intent), provenance };
    if (signal.aborted) return ModelDispatchObservationSchema.parse({ status: "usage_unknown", ...correlation, reason: "aborted" });
    if (this.#scenario.dispatch === "completed" || this.#scenario.dispatch === "failed") {
      const sourceProposalReference = await this.persistProposal(intent);
      return ModelDispatchObservationSchema.parse({ status: this.#scenario.dispatch, receipt: await this.receipt(intent, "dispatch"), ...(sourceProposalReference ? { sourceProposalReference } : {}) });
    }
    if (this.#scenario.dispatch === "pre_dispatch_rejected") return ModelDispatchObservationSchema.parse({ status: "definitive_not_accepted", ...correlation, reason: "pre_dispatch_rejected" });
    if (this.#scenario.dispatch === "malformed_receipt" || this.#scenario.dispatch === "mismatched_receipt") {
      // Native fixture data remains protected. Strict normalization failure is
      // intentionally represented as ambiguity, never a partial priced receipt.
      const malformed = this.#scenario.dispatch === "malformed_receipt"
        ? { operationId: intent.operationId, providerRequestId: this.providerRequestId(intent), provider: "deterministic_fixture" }
        : { ...(await this.receipt(intent, "dispatch")), operationId: `${intent.operationId}:mismatch` };
      const normalized = NormalizedUsageReceiptSchema.safeParse(malformed);
      const correlated = normalized.success
        && normalized.data.operationId === intent.operationId
        && normalized.data.providerRequestId === this.providerRequestId(intent)
        && normalized.data.profileId === intent.profileId
        && normalized.data.priceCardId === intent.priceCardId;
      if (correlated) throw new Error("DETERMINISTIC_FIXTURE_EXPECTED_INVALID_RECEIPT");
    }
    return ModelDispatchObservationSchema.parse({ status: "usage_unknown", ...correlation, reason: this.#scenario.dispatch });
  }

  private providerRequestId(intent: ProviderOperationIntent): string { return intent.providerRequestId; }

  private async provenance(intent: ProviderOperationIntent, stage: "dispatch" | "lookup") {
    // The body is intentionally not returned: callers can correlate it only by
    // an immutable protected reference and digest.
    const protectedEvidenceReference = `fixture-evidence:${intent.operationId}:${stage}`;
    const protectedEvidenceDigest = await sha256(canonicalJson({ fixture: "deterministic_fixture", stage, intent, native: { accepted: true, untrusted: "protected" } }));
    return frozen({ protectedEvidenceReference, protectedEvidenceDigest });
  }

  private async receipt(intent: ProviderOperationIntent, stage: "dispatch" | "lookup"): Promise<NormalizedUsageReceipt> {
    return NormalizedUsageReceiptSchema.parse({
      operationId: intent.operationId,
      providerRequestId: this.providerRequestId(intent),
      provider: "deterministic_fixture",
      model: "phase-04-fixture-model",
      profileId: intent.profileId,
      priceCardId: intent.priceCardId,
      selection: "unselected",
      completedAt: this.#now(),
      provenance: await this.provenance(intent, stage),
      usage: intent.maximumUnits.map(({ dimension, units }) => ({ dimension, units: (BigInt(units) > 1n ? "1" : units) })),
    });
  }

  private async persistProposal(intent: ProviderOperationIntent): Promise<string | undefined> {
    const remembered = this.#proposalReferences.get(intent.operationId);
    if (remembered) return remembered;
    if (!this.#proposalStore) return undefined;
    // A restarted deterministic gateway must replay the original paid source,
    // even when this fixture's template changes in a later code version.
    const durable = await this.#proposalStore.lookup({ intent });
    if (durable) {
      this.#proposalReferences.set(intent.operationId, durable.proposal.reference);
      return durable.proposal.reference;
    }
    const fingerprint = intent.requestFingerprint.slice(0, 12);
    const label = `Focus ${fingerprint}`;
    const main = [
      "import './styles.css';",
      "import { runtimeHasDomain } from './domain-availability.js';",
      `const title = ${JSON.stringify(label)};`,
      'const root = document.querySelector("#app");',
      'if (!root) throw new Error("APP_ROOT_MISSING");',
      'let count = 0;',
      'const heading = document.createElement("p"); heading.textContent = title;',
      'const value = document.createElement("output"); value.textContent = String(count);',
      'const button = document.createElement("button"); button.type = "button"; button.textContent = "Add";',
      'button.addEventListener("click", () => { count += 1; value.textContent = String(count); });',
      'const availability = document.createElement("p"); availability.textContent = runtimeHasDomain("storage") ? "Storage available" : "Storage unavailable";',
      'root.replaceChildren(heading, value, button, availability);',
    ].join("\n");
    const stored = await this.#proposalStore.persist({ intent, provider: "deterministic_fixture", model: "phase-04-fixture-model", proposal: { files: [
      { path: "src/capabilities.json", content: JSON.stringify({ required: [], optional: [] }) },
      { path: "src/main.ts", content: main },
      { path: "src/styles.css", content: "html, body, #app { height: 100%; margin: 0; } body { font-family: system-ui, sans-serif; } button { margin: 0.5rem; }" },
    ] } });
    this.#proposalReferences.set(intent.operationId, stored.proposal.reference);
    return stored.proposal.reference;
  }
}
