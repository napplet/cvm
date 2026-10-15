import { canonicalJson } from "../promotion/schema";
import { ProviderOperationIntentSchema, SourceProposalSchema, type ProviderOperationIntent, type SourceProposal } from "../model/model-gateway";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ApprovedPathSchema = z.enum(["src/app.ts", "src/main.ts", "src/styles.css", "src/domain-availability.js"]);
const StoredProposalSchema = z.object({
  proposalSha256: DigestSchema, operationId: z.string().min(1), providerRequestId: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), requestFingerprint: DigestSchema,
  authorizedPriorArtifactReference: z.string().min(1).max(256).optional(), provider: z.string().min(1), model: z.string().min(1), profileId: z.string().min(1), priceCardId: z.string().min(1), proposal: SourceProposalSchema,
}).strict();
export type StoredSourceProposal = z.infer<typeof StoredProposalSchema>;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function freeze<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function validFiles(proposal: SourceProposal): boolean {
  const bytes = proposal.files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0);
  return bytes <= 128_000 && proposal.files.every((file) => ApprovedPathSchema.safeParse(file.path).success);
}

/** SQL authority for immutable generated sources. It deliberately stores no prompt or credential. */
export class SourceProposalStore {
  constructor(private readonly pool: PostgresSqlPool) {}

  async persist(input: Readonly<{ intent: ProviderOperationIntent; provider: string; model: string; proposal: Omit<SourceProposal, "reference" | "sha256"> }>): Promise<StoredSourceProposal> {
    const intent = ProviderOperationIntentSchema.parse(input.intent);
    const raw = { files: input.proposal.files };
    const proposalSha256 = await sha256(canonicalJson(raw));
    const proposal = SourceProposalSchema.parse({ reference: `proposal:sha256:${proposalSha256}`, sha256: proposalSha256, ...raw });
    if (!validFiles(proposal)) throw new Error("SOURCE_PROPOSAL_SURFACE_REJECTED");
    const candidate = StoredProposalSchema.parse({ proposalSha256, operationId: intent.operationId, providerRequestId: intent.providerRequestId, accountId: intent.accountId, sessionId: intent.sessionId, actionId: intent.actionId, expectedVersion: intent.expectedVersion, requestFingerprint: intent.requestFingerprint, ...(intent.authorizedPriorArtifactReference ? { authorizedPriorArtifactReference: intent.authorizedPriorArtifactReference } : {}), provider: input.provider, model: input.model, profileId: intent.profileId, priceCardId: intent.priceCardId, proposal });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (await client.query<{ proposal_sha256: string; operation_id: string; provider_request_id: string; account_id: string; session_id: string; action_id: string; expected_version: number; request_fingerprint_sha256: string; prior_artifact_reference: string | null; provider: string; model: string; profile_id: string; price_card_id: string; proposal_json: unknown }>("SELECT proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,prior_artifact_reference,provider,model,profile_id,price_card_id,proposal_json FROM source_proposals WHERE operation_id=$1 FOR UPDATE", [intent.operationId])).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return this.row(existing);
      }
      await client.query("INSERT INTO source_proposals(proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,prior_artifact_reference,provider,model,profile_id,price_card_id,proposal_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [candidate.proposalSha256, candidate.operationId, candidate.providerRequestId, candidate.accountId, candidate.sessionId, candidate.actionId, candidate.expectedVersion, candidate.requestFingerprint, candidate.authorizedPriorArtifactReference ?? null, candidate.provider, candidate.model, candidate.profileId, candidate.priceCardId, candidate.proposal]);
      await client.query("COMMIT"); return freeze(candidate);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async lookup(input: Readonly<{ intent: ProviderOperationIntent; reference?: string; sha256?: string }>): Promise<StoredSourceProposal | undefined> {
    const intent = ProviderOperationIntentSchema.parse(input.intent);
    const client = await this.pool.connect();
    try {
      const row = (await client.query<{ proposal_sha256: string; operation_id: string; provider_request_id: string; account_id: string; session_id: string; action_id: string; expected_version: number; request_fingerprint_sha256: string; prior_artifact_reference: string | null; provider: string; model: string; profile_id: string; price_card_id: string; proposal_json: unknown }>("SELECT proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,prior_artifact_reference,provider,model,profile_id,price_card_id,proposal_json FROM source_proposals WHERE operation_id=$1 AND provider_request_id=$2 AND account_id=$3 AND session_id=$4 AND action_id=$5 AND expected_version=$6 AND request_fingerprint_sha256=$7 AND COALESCE(prior_artifact_reference,'')=COALESCE($8,'')", [intent.operationId, intent.providerRequestId, intent.accountId, intent.sessionId, intent.actionId, intent.expectedVersion, intent.requestFingerprint, intent.authorizedPriorArtifactReference ?? null])).rows[0];
      if (!row) return undefined;
      const proposal = this.row(row);
      // The row key is authoritative: validate an opaque caller reference from
      // that key instead of trusting a JSON field supplied by the provider.
      if ((input.reference && input.reference !== `proposal:sha256:${proposal.proposalSha256}`) || (input.sha256 && proposal.proposalSha256 !== input.sha256)) return undefined;
      return proposal;
    } finally { client.release(); }
  }

  private row(row: { proposal_sha256: string; operation_id: string; provider_request_id: string; account_id: string; session_id: string; action_id: string; expected_version: number; request_fingerprint_sha256: string; prior_artifact_reference: string | null; provider: string; model: string; profile_id: string; price_card_id: string; proposal_json: unknown }): StoredSourceProposal {
    return freeze(StoredProposalSchema.parse({ proposalSha256: row.proposal_sha256, operationId: row.operation_id, providerRequestId: row.provider_request_id, accountId: row.account_id, sessionId: row.session_id, actionId: row.action_id, expectedVersion: row.expected_version, requestFingerprint: row.request_fingerprint_sha256, ...(row.prior_artifact_reference ? { authorizedPriorArtifactReference: row.prior_artifact_reference } : {}), provider: row.provider, model: row.model, profileId: row.profile_id, priceCardId: row.price_card_id, proposal: row.proposal_json }));
  }
}
