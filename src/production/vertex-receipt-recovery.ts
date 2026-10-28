import { createHash } from "node:crypto";
import { ModelProfileSchema } from "../model/price-card";
import { canonicalJson } from "../promotion/schema";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ProviderOperationIntentSchema, type ProviderOperationIntent } from "../model/model-gateway";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createPostgresVertexOperationJournal } from "../release/deployment/postgres-provider-journals";
import { createVertexDeploymentClient, readRetainedVertexOperation, type VertexInteractionsPort } from "../release/deployment/vertex-client";

const instances = new WeakSet<object>();
/** Lookup-only recovery of an existing paid original. No dispatch capability is
 * exposed. SQL owner/action authority precedes all retained-request access. */
export class ProductionVertexReceiptRecovery {
  readonly #pool: PostgresSqlPool;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; journal: PostgresOperationJournal; interactions: VertexInteractionsPort; current: ReturnType<typeof createVertexDeploymentClient>; now?: () => number }>) {
    assertPostgresOperationJournal(input.journal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    instances.add(this);
  }
  async reconcile(raw: ProviderOperationIntent): Promise<unknown> {
    const intent = ProviderOperationIntentSchema.parse(raw);
    if (intent.providerRequestId !== intent.operationId) throw new Error("PRODUCTION_VERTEX_ORIGINAL_OPERATION_REQUIRED");
    const client = await this.#pool.connect();
    try {
      const owned = await client.query<{ normalized_profile: unknown; profile_hash: string }>("SELECT m.normalized_profile,m.profile_hash FROM metered_actions a JOIN model_profile_versions m ON m.id=a.profile_id JOIN provider_operations p ON p.action_id=a.id AND p.account_id=a.account_id AND p.id=a.operation_id AND p.provider_request_id=a.operation_id WHERE a.account_id=$1 AND a.session_id=$2 AND a.id=$3 AND a.operation_id=$4 AND a.expected_session_version=$5 AND a.budget_reference=$6 AND a.profile_id=$7 AND a.price_card_id=$8 AND a.fingerprint=$9", [intent.accountId, intent.sessionId, intent.actionId, intent.operationId, intent.expectedVersion, intent.actionBudgetReference, intent.profileId, intent.priceCardId, intent.requestFingerprint]);
      if (owned.rows.length !== 1) throw new Error("PRODUCTION_VERTEX_ORIGINAL_OWNER_REQUIRED");
      const saved = owned.rows[0]!;
      const profile = ModelProfileSchema.parse(saved.normalized_profile);
      if (profile.id !== intent.profileId || profile.priceCardId !== intent.priceCardId || profile.provider !== "vertex_ai_gemini" || profile.model !== "gemini-4-argon" || createHash("sha256").update(canonicalJson(profile)).digest("hex") !== saved.profile_hash || canonicalJson(profile.maximumUnits) !== canonicalJson(intent.maximumUnits)) throw new Error("PRODUCTION_VERTEX_ORIGINAL_REQUEST_REQUIRED");
    } finally { client.release(); }
    const journal = createPostgresVertexOperationJournal(this.input.journal);
    const original = await readRetainedVertexOperation(journal, intent.operationId);
    if (!original) return undefined;
    const current = this.input.current.discovery();
    if (original.projectId !== current.projectId || original.location !== current.location || original.model !== current.model) throw new Error("PRODUCTION_VERTEX_ORIGINAL_PROJECT_APPROVAL_REQUIRED");
    const output = intent.maximumUnits.filter(value => value.dimension === "output_tokens" || value.dimension === "reasoning_tokens").reduce((sum, value) => sum + BigInt(value.units), 0n);
    const input = intent.maximumUnits.find(value => value.dimension === "input_tokens")?.units;
    if (original.request.idea !== intent.prompt || BigInt(original.request.maximumOutputTokens) !== output || (original.request.maximumInputTokens !== undefined && String(original.request.maximumInputTokens) !== input)) throw new Error("PRODUCTION_VERTEX_ORIGINAL_REQUEST_REQUIRED");
    const retained = createVertexDeploymentClient({ candidateSha256: original.candidateSha256, projectId: original.projectId, location: original.location, model: original.model, credentialReference: current.credentialReference, price: original.price, journal, interactions: this.input.interactions, now: this.input.now });
    return retained.reconcileOriginal({ operationId: intent.operationId, requestSha256: original.requestSha256 });
  }
}
export function assertProductionVertexReceiptRecovery(value: unknown): asserts value is ProductionVertexReceiptRecovery {
  if (!value || typeof value !== "object" || !instances.has(value)) throw new Error("PRODUCTION_VERTEX_RECEIPT_RECOVERY_REQUIRED");
}
