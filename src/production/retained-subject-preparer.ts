import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectStorePort } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { DurabilitySubjectSchema } from "../resilience/fault-harness";
import { MountedKekCheckpointCrypto } from "./checkpoint-crypto";
import { createProductionDurabilitySubjectRegistry, type ProductionDurabilitySubject } from "./durability-registry";
import { retainedSubjectCustodyId, sealRetainedSubject, type RetainedSubjectJournal } from "./retained-subject-archive";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

export type RetainedSubjectScope = Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>;
type Binding = Readonly<{ accountId: string; actionId: string; retentionUntil: string; artifactId: string; artifactVersion: number; expectedVersion: number; checkpoint: ProductionDurabilitySubject }>;
type Original = Readonly<{ kind: Exclude<z.infer<typeof DurabilitySubjectSchema>["kind"], "checkpoint">; sourceIdentity: string; bytes: Uint8Array }>;

/**
 * Materializes the seven restore subjects only from already-final SQL/journal
 * records. This is deliberately a preparation effect, separate from
 * `restore.inventory`: callers must run it after receipt-bound originals have
 * committed, while inventory itself stays a read-only registry query.
 */
export class ProductionRetainedSubjectPreparer {
  readonly #pool: PostgresSqlPool;
  readonly #crypto: MountedKekCheckpointCrypto;
  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    objectStore: ObjectStorePort;
    journal: RetainedSubjectJournal;
    kekPath: string;
    readKekFile?: (path: string) => Promise<Uint8Array | string>;
    now?: () => number;
  }>) {
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#crypto = new MountedKekCheckpointCrypto({ pool: input.pool, kekPath: input.kekPath, readFile: input.readKekFile, now: input.now });
  }

  async prepare(raw: RetainedSubjectScope): Promise<void> {
    const scope = this.#scope(raw), binding = await this.#binding(scope);
    const registry = createProductionDurabilitySubjectRegistry(this.#pool);
    await registry.register(binding.checkpoint);
    for (const original of await this.#originals(scope, binding)) {
      const sealed = await sealRetainedSubject({ crypto: this.#crypto, objectStore: this.input.objectStore, journal: this.input.journal,
        checkpointId: scope.checkpointId, accountId: binding.accountId, ownerId: scope.ownerId, sessionId: scope.sessionId,
        actionId: binding.actionId, retentionUntil: binding.retentionUntil, source: original });
      await registry.register({ ...sealed, checkpointId: scope.checkpointId, sessionId: scope.sessionId, actionId: binding.actionId });
    }
    // This is the first read-only point visible to restore. A partial archive
    // is never returned as an inventory and cannot become certification input.
    await registry.inventory(scope);
  }

  /** Query-only cloned-authority proof for a retained original. Reopen is not
   * enough: the archive bytes must still exactly match the producer record
   * selected by its original owner/session/action/artifact/version fences. */
  async validateOpened(raw: RetainedSubjectScope, subject: z.infer<typeof DurabilitySubjectSchema>, archive: Uint8Array): Promise<void> {
    const scope = this.#scope(raw);
    if (subject.kind === "checkpoint") throw new Error("RETAINED_SUBJECT_ORIGINAL_KIND_REQUIRED");
    const binding = await this.#binding(scope);
    const original = (await this.#originals(scope, binding)).find(value => value.kind === subject.kind);
    if (!original || original.sourceIdentity !== subject.sourceIdentity || sha(original.bytes) !== subject.payloadSha256 || original.bytes.byteLength !== archive.byteLength || !Buffer.from(original.bytes).equals(Buffer.from(archive))) throw new Error("RETAINED_SUBJECT_ORIGINAL_BYTES_REQUIRED");
  }

  /** Starts exact expiry/erasure of every run-owned retained copy.  This never
   * touches the original artifact, Nostr event, receipt, or audit record. */
  async destroyExpired(raw: RetainedSubjectScope): Promise<void> {
    const scope = this.#scope(raw), registry = createProductionDurabilitySubjectRegistry(this.#pool);
    const subjects = await registry.inventory(scope);
    const now = (this.input.now ?? Date.now)();
    for (const subject of subjects) {
      if (Date.parse(subject.retentionUntil) > now) throw new Error("RETAINED_SUBJECT_EXPIRY_NOT_DUE");
      if (subject.kind === "checkpoint") continue;
      const binding = await this.#binding(scope);
      const custodyId = retainedSubjectCustodyId({ checkpointId: scope.checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity });
      const stored = await this.#crypto.readSealed(custodyId);
      if (!stored || stored.ciphertextSha256 !== subject.object.checksum) throw new Error("RETAINED_SUBJECT_ERASURE_BINDING_REQUIRED");
      const operationId = `retained-delete:${sha(canonicalJson({ checkpointId: scope.checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity })).slice(0, 48)}`;
      const intent = Object.freeze({ schemaVersion: "retained-subject-delete-v1", state: "pending", checkpointId: scope.checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity, object: subject.object, keyReference: stored.keyReference });
      const claimed = await this.input.journal.claim(operationId, sha(canonicalJson(intent)), intent);
      if (!claimed.claimed) {
        // A lost provider acknowledgement leaves the immutable delete intent
        // as the only dispatch authority. Re-querying exact generation
        // absence is sufficient to finish the locally-custodied key erasure;
        // it must never authorize another object delete.
        if (await this.input.objectStore.readExact(subject.object)) continue;
        await this.#crypto.destroy(stored.keyReference);
        if (!await this.#crypto.isDestroyed(stored.keyReference)) throw new Error("RETAINED_SUBJECT_ERASURE_KEY_REQUIRED");
        continue;
      }
      const exact = await this.input.objectStore.readExact(subject.object);
      if (!exact || sha(exact) !== subject.object.checksum) throw new Error("RETAINED_SUBJECT_ERASURE_OBJECT_REQUIRED");
      await registry.markDeletion({ checkpointId: scope.checkpointId, kind: subject.kind, objectGeneration: subject.object.generation, objectChecksum: subject.object.checksum, state: "tombstoned" });
      await this.input.objectStore.scheduleExactDeletion(subject.object, subject.retentionUntil);
      await this.#crypto.destroy(stored.keyReference);
      if (!await this.#crypto.isDestroyed(stored.keyReference)) throw new Error("RETAINED_SUBJECT_ERASURE_KEY_REQUIRED");
    }
  }

  /** Query-only completion of a prior exact deletion intent.  It must never
   * redispatch delete/destroy for an uncertain or lost acknowledgement. */
  async observeExpired(raw: RetainedSubjectScope): Promise<boolean> {
    const scope = this.#scope(raw), registry = createProductionDurabilitySubjectRegistry(this.#pool);
    const subjects = await registry.inventory(scope);
    let complete = true;
    for (const subject of subjects) {
      if (subject.kind === "checkpoint") continue;
      const custodyId = retainedSubjectCustodyId({ checkpointId: scope.checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity });
      const operationId = `retained-delete:${sha(canonicalJson({ checkpointId: scope.checkpointId, kind: subject.kind, sourceIdentity: subject.sourceIdentity })).slice(0, 48)}`;
      const intent = await this.input.journal.read<{ schemaVersion: string; checkpointId: string; kind: string; sourceIdentity: string; object: unknown; keyReference: string }>(operationId);
      if (!intent || intent.value.schemaVersion !== "retained-subject-delete-v1" || intent.value.checkpointId !== scope.checkpointId || intent.value.kind !== subject.kind || intent.value.sourceIdentity !== subject.sourceIdentity || canonicalJson(intent.value.object) !== canonicalJson(subject.object)) { complete = false; continue; }
      if (!await this.#crypto.isDestroyed(intent.value.keyReference) || await this.input.objectStore.readExact(subject.object)) { complete = false; continue; }
      if (subject.deletionState !== "deleted") await registry.markDeletion({ checkpointId: scope.checkpointId, kind: subject.kind, objectGeneration: subject.object.generation, objectChecksum: subject.object.checksum, state: "deleted" });
    }
    return complete;
  }

  #scope(raw: RetainedSubjectScope): RetainedSubjectScope {
    return Object.freeze({ checkpointId: Identity.parse(raw.checkpointId), sessionId: Identity.parse(raw.sessionId), ownerId: Digest.parse(raw.ownerId) });
  }

  async #binding(scope: RetainedSubjectScope): Promise<Binding> {
    const client = await this.#pool.connect();
    try {
      const rows = await client.query<Record<string, unknown>>(
        "SELECT e.account_id,e.action_id,e.retention_until::text AS retention_until,e.manifest_json,e.object_key,e.object_generation,e.object_checksum,a.id AS action_id_check,a.expected_session_version,a.artifact_id,a.artifact_version,a.state,a.settled_at,trim(f.nostr_pubkey) AS owner_id FROM production_real.checkpoint_envelopes e JOIN production_real.funding_accounts f ON f.account_id=e.account_id JOIN production_real.metered_actions a ON a.id=e.action_id AND a.account_id=e.account_id AND a.session_id=e.session_id WHERE e.checkpoint_id=$1 AND e.session_id=$2 AND trim(f.nostr_pubkey)=$3 AND e.state='retained' AND a.state='verified' AND a.settled_at IS NOT NULL LIMIT 2",
        [scope.checkpointId, scope.sessionId, scope.ownerId],
      );
      if (rows.rows.length !== 1) throw new Error("RETAINED_SUBJECT_ORIGINAL_RECEIPT_REQUIRED");
      const row = rows.rows[0]!;
      const manifest = z.object({ checkpointId: Identity, accountId: z.string().min(1), sessionId: Identity, artifactVersion: z.number().int().nonnegative(), archiveSha256: Digest, action: z.object({ actionId: Identity }).passthrough() }).passthrough().parse(typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json);
      const accountId = z.string().min(1).parse(row.account_id), actionId = Identity.parse(row.action_id);
      const artifactId = z.string().min(1).parse(row.artifact_id), artifactVersion = z.number().int().positive().parse(Number(row.artifact_version)), expectedVersion = z.number().int().nonnegative().parse(Number(row.expected_session_version));
      const retentionUntil = new Date(String(row.retention_until)).toISOString();
      if (manifest.checkpointId !== scope.checkpointId || manifest.accountId !== accountId || manifest.sessionId !== scope.sessionId || manifest.action.actionId !== actionId || manifest.artifactVersion !== artifactVersion || row.action_id_check !== actionId || row.owner_id !== scope.ownerId) throw new Error("RETAINED_SUBJECT_CHECKPOINT_ACTION_BINDING_REQUIRED");
      const checkpoint = DurabilitySubjectSchema.parse({ kind: "checkpoint", sourceIdentity: `checkpoint:${scope.checkpointId}`, object: { key: row.object_key, generation: Number(row.object_generation), checksum: row.object_checksum }, payloadSha256: manifest.archiveSha256, ownerId: scope.ownerId, retentionUntil, deletionState: "retained" });
      return Object.freeze({ accountId, actionId, retentionUntil, artifactId, artifactVersion, expectedVersion, checkpoint: { ...checkpoint, checkpointId: scope.checkpointId, sessionId: scope.sessionId, actionId } });
    } finally { client.release(); }
  }

  async #originals(scope: RetainedSubjectScope, binding: Binding): Promise<readonly Original[]> {
    const client = await this.#pool.connect();
    try {
      const artifactRows = await client.query<Record<string, unknown>>(
        "SELECT value_json FROM production_real.release_operation_journal WHERE value_json->'evidence'->'result'->'artifact'->>'sessionId'=$1 AND value_json->'evidence'->'result'->'artifact'->>'actionId'=$2 AND value_json->'evidence'->'result'->'artifact'->>'artifactId'=$3 AND value_json ? 'reference' ORDER BY updated_at DESC LIMIT 2",
        [scope.sessionId, binding.actionId, binding.artifactId],
      );
      if (artifactRows.rows.length !== 1) throw new Error("RETAINED_SUBJECT_ARTIFACT_ORIGINAL_REQUIRED");
      const artifact = z.object({ evidence: z.object({ checksum: Digest, scannerReportSha256: Digest, conformanceReportSha256: Digest, result: z.object({ artifact: z.object({ artifactId: z.string().min(1), sessionId: Identity, actionId: Identity, expectedVersion: z.number().int().nonnegative() }).passthrough() }).passthrough() }).passthrough(), reference: z.object({ key: z.string().min(1), generation: z.number().int().positive(), checksum: Digest }).strict() }).passthrough().parse(typeof artifactRows.rows[0]!.value_json === "string" ? JSON.parse(String(artifactRows.rows[0]!.value_json)) : artifactRows.rows[0]!.value_json);
      if (artifact.evidence.result.artifact.artifactId !== binding.artifactId || artifact.evidence.result.artifact.sessionId !== scope.sessionId || artifact.evidence.result.artifact.actionId !== binding.actionId || artifact.evidence.result.artifact.expectedVersion !== binding.expectedVersion || artifact.reference.checksum !== artifact.evidence.checksum) throw new Error("RETAINED_SUBJECT_ARTIFACT_BINDING_REQUIRED");
      const artifactBytes = await this.input.objectStore.readExact(artifact.reference);
      if (!artifactBytes || sha(artifactBytes) !== artifact.reference.checksum) throw new Error("RETAINED_SUBJECT_ARTIFACT_OBJECT_REQUIRED");
      const receiptRows = await client.query<Record<string, unknown>>(
        "SELECT r.id,r.operation_id,r.provider,r.model,r.provider_receipt_id,r.normalized_receipt,r.protected_evidence_reference FROM production_real.usage_receipts r JOIN production_real.metered_actions a ON a.id=r.action_id AND a.account_id=r.account_id WHERE r.account_id=$1 AND r.action_id=$2 AND a.session_id=$3 AND a.state='verified' AND a.settled_at IS NOT NULL LIMIT 2",
        [binding.accountId, binding.actionId, scope.sessionId],
      );
      if (receiptRows.rows.length !== 1) throw new Error("RETAINED_SUBJECT_USAGE_RECEIPT_REQUIRED");
      const promotionRows = await client.query<Record<string, unknown>>(
        "SELECT x.id,x.version,x.lineage,x.validation_evidence_reference,x.verified,a.terminal_result,a.validation_report_reference FROM production_real.session_artifacts x JOIN production_real.metered_actions a ON a.id=x.action_id AND a.account_id=x.account_id AND a.session_id=x.session_id WHERE x.account_id=$1 AND x.session_id=$2 AND x.action_id=$3 AND x.id=$4 AND x.version=$5 AND x.verified=true AND a.state='verified' AND a.settled_at IS NOT NULL LIMIT 2",
        [binding.accountId, scope.sessionId, binding.actionId, binding.artifactId, binding.artifactVersion],
      );
      if (promotionRows.rows.length !== 1) throw new Error("RETAINED_SUBJECT_VALIDATION_PROMOTION_REQUIRED");
      const publicationRows = await client.query<Record<string, unknown>>(
        "SELECT p.intent_id,p.owner_event_id,p.attestation_event_id,p.terminal_state,e.event_json AS owner_event,ae.observation_json AS attestation_observation FROM production_real.publication_records p JOIN production_real.publication_intents i ON i.intent_id=p.intent_id JOIN production_real.publication_signed_events e ON e.intent_id=p.intent_id JOIN production_real.publication_effect_intents ae ON ae.intent_id=p.intent_id AND ae.effect_kind='attestation' AND ae.state='observed_complete' WHERE p.artifact_id=$1 AND p.terminal_state='complete' AND i.session_id=$2 AND i.artifact_version=$3 LIMIT 2",
        [binding.artifactId, scope.sessionId, binding.artifactVersion],
      );
      if (publicationRows.rows.length !== 1) throw new Error("RETAINED_SUBJECT_COMPLETED_OWNER_PUBLICATION_REQUIRED");
      const publication = publicationRows.rows[0]!;
      const identity = (kind: string, value: unknown) => `${kind}:${sha(canonicalJson(value))}`;
      const promotion = promotionRows.rows[0]!;
      const receipt = receiptRows.rows[0]!;
      const ownerEvent = z.object({ id: Digest }).passthrough().parse(typeof publication.owner_event === "string" ? JSON.parse(publication.owner_event) : publication.owner_event);
      const ownerEventId = Digest.parse(publication.owner_event_id);
      const attestationEventId = z.string().min(1).max(256).parse(publication.attestation_event_id);
      if (ownerEvent.id !== ownerEventId || attestationEventId === ownerEventId) throw new Error("RETAINED_SUBJECT_PUBLICATION_IDENTITY_REQUIRED");
      /* These are original, immutable record bytes, not convenient digest
       * projections.  The source identities bind the exact original rows to
       * owner/session/action/artifact/version fences already selected above. */
      const validation = Object.freeze({ artifact, promotion });
      const attestationEvent = z.object({ id: z.string().min(1).max(256) }).passthrough().parse(
        typeof publication.attestation_observation === "string" ? JSON.parse(publication.attestation_observation) : publication.attestation_observation,
      );
      if (attestationEvent.id !== attestationEventId) throw new Error("RETAINED_SUBJECT_ATTESTATION_IDENTITY_REQUIRED");
      const attestation = Object.freeze({ intentId: publication.intent_id, ownerEventId, attestationEventId, event: attestationEvent });
      return Object.freeze([
        { kind: "sealed_artifact", sourceIdentity: identity("artifact", artifact.reference), bytes: new Uint8Array(artifactBytes) },
        { kind: "validation_evidence", sourceIdentity: identity("validation", validation), bytes: jsonBytes(validation) },
        { kind: "usage_receipt", sourceIdentity: identity("receipt", receipt), bytes: jsonBytes(receipt) },
        // This is the finalized artifact validation/promotion record, never a
        // post-suite release promotion or final release evaluator result.
        { kind: "promotion_evidence", sourceIdentity: identity("artifact-promotion", promotion), bytes: jsonBytes(promotion) },
        { kind: "owner_event", sourceIdentity: identity("owner-event", ownerEvent), bytes: jsonBytes(ownerEvent) },
        { kind: "attestation", sourceIdentity: identity("attestation", attestation), bytes: jsonBytes(attestation) },
      ] as const);
    } finally { client.release(); }
  }
}
