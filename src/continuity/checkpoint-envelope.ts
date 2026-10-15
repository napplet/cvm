import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ImmutableObjectReferenceSchema, type ImmutableObjectReference, type ObjectStorePort } from "./object-store";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";
import { PendingActionEnvelopeSchema, PendingActionHeaderSchema, PendingStartCommandSchema, type PendingActionEnvelope, type PendingActionHeader, type PendingStartCommand } from "./contracts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
const Base64Schema = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const InventoryClassSchema = z.enum([
  "harness_state",
  "workspace",
  "artifact_lineage",
  "validation_evidence",
  "financial_action",
  "pending_action",
  "compatibility_metadata",
]);
const REQUIRED_INVENTORY: ReadonlySet<string> = new Set(InventoryClassSchema.options);
const FORBIDDEN_INVENTORY = new Set([
  "nostr_private_key",
  "worker_credential",
  "cloud_credential",
  "bearer_payment_material",
  "native_provider_payload",
  "raw_chain_of_thought",
]);

const ActionBindingSchema = z.object({
  actionId: z.string().min(1),
  operationId: z.string().min(1),
  ledgerReference: z.string().min(1),
  pendingActionReference: z.string().min(1),
  idempotencyKey: z.string().min(1),
}).strict();
const CompatibilitySchema = z.object({
  policyVersion: z.string().min(1),
  modelIdentity: z.string().min(1),
  nappletSdkIdentity: z.string().min(1),
  toolchainIdentity: z.string().min(1),
}).strict();

/** Canonical coordinator-owned state required to resume one paid checkpoint. */
export const CheckpointManifestSchema = z.object({
  schemaVersion: z.literal("checkpoint-manifest-v1"),
  checkpointId: z.string().min(1),
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  pauseGeneration: z.number().int().nonnegative(),
  sessionVersion: z.number().int().nonnegative(),
  actionVersion: z.number().int().nonnegative(),
  artifactVersion: z.number().int().nonnegative(),
  workspaceVersion: z.number().int().nonnegative(),
  workspaceLineage: z.string().min(1),
  action: ActionBindingSchema,
  inventory: z.array(InventoryClassSchema).min(REQUIRED_INVENTORY.size).max(REQUIRED_INVENTORY.size),
  inventorySha256: Sha256Schema,
  archiveSha256: Sha256Schema,
  evidenceSha256: Sha256Schema,
  compatibility: CompatibilitySchema,
  committedAt: z.string().datetime(),
  retentionUntil: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.inventory).size !== value.inventory.length || value.inventory.some((entry) => !REQUIRED_INVENTORY.has(entry))) {
    ctx.addIssue({ code: "custom", message: "checkpoint inventory must be complete and unique" });
  }
});

export const CheckpointEnvelopeSchema = z.object({
  schemaVersion: z.literal("checkpoint-envelope-v1"),
  manifestSha256: Sha256Schema,
  ciphertextBase64: Base64Schema,
  ciphertextSha256: Sha256Schema,
  object: ImmutableObjectReferenceSchema,
  crypto: z.object({
    algorithm: z.literal("AES-GCM"),
    keyReference: z.string().min(1),
    nonceBase64: Base64Schema,
    aadSha256: Sha256Schema,
  }).strict(),
}).strict();

export type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;
export type CheckpointEnvelope = z.infer<typeof CheckpointEnvelopeSchema>;
export type CheckpointSealRequest = Readonly<{
  checkpointId: string;
  accountId: string;
  sessionId: string;
  pauseGeneration: number;
  sessionVersion: number;
  actionVersion: number;
  artifactVersion: number;
  workspaceVersion: number;
  workspaceLineage: string;
  action: z.infer<typeof ActionBindingSchema>;
  archive: Uint8Array;
  inventory: readonly string[];
  evidenceSha256: string;
  compatibility: z.infer<typeof CompatibilitySchema>;
  retentionUntil: string;
}>;

export interface CheckpointCryptoPort {
  seal(input: Readonly<{ checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array }>): Promise<Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array }>>;
  open(input: Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }>): Promise<Uint8Array>;
  destroy(keyReference: string): Promise<void>;
}

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
function fromB64(value: string): Uint8Array | undefined {
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    return b64(bytes) === value ? bytes : undefined;
  } catch { return undefined; }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalJson(value)); }

/**
 * Separate envelope for an intent that has not been admitted.  It never uses
 * the workspace checkpoint object/key model: only a server-local AES key and
 * the authenticated command header can restore this bounded command.
 */
export class PendingActionEnvelopeService {
  constructor(private readonly keys: Readonly<{ loadOrCreatePendingActionKey(): Promise<Readonly<{ keyId: string; key: Uint8Array }>> }>) {}

  async seal(input: Readonly<{ header: Omit<PendingActionHeader, "keyId">; command: PendingStartCommand }>): Promise<PendingActionEnvelope> {
    const command = PendingStartCommandSchema.parse(input.command);
    const material = await this.keys.loadOrCreatePendingActionKey();
    if (!(material.key instanceof Uint8Array) || material.key.byteLength !== 32 || !material.keyId) throw new Error("PENDING_ACTION_KEY_UNAVAILABLE");
    const header = PendingActionHeaderSchema.parse({ ...input.header, keyId: material.keyId });
    const aad = canonicalBytes(header);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", material.key, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, canonicalBytes(command)));
    return PendingActionEnvelopeSchema.parse({ header, headerSha256: await sha256(aad), ciphertextBase64: b64(ciphertext), ciphertextSha256: await sha256(ciphertext), nonceBase64: b64(nonce) });
  }

  async open(input: unknown, nowMs = Date.now()): Promise<Readonly<{ header: PendingActionHeader; command: PendingStartCommand }>> {
    const denied = (stage: string) => new Error("PENDING_ACTION_RESTORE_DENIED", { cause: new Error(stage) });
    try {
      const parsed = PendingActionEnvelopeSchema.safeParse(input);
      if (!parsed.success) throw denied("PENDING_ACTION_ENVELOPE_INVALID");
      const envelope = parsed.data;
      let material: Readonly<{ keyId: string; key: Uint8Array }>;
      try { material = await this.keys.loadOrCreatePendingActionKey(); }
      catch { throw denied("PENDING_ACTION_KEY_UNAVAILABLE"); }
      const aad = canonicalBytes(envelope.header); const ciphertext = fromB64(envelope.ciphertextBase64); const nonce = fromB64(envelope.nonceBase64);
      if (!ciphertext || !nonce || nonce.byteLength !== 12) throw denied("PENDING_ACTION_ENVELOPE_ENCODING_INVALID");
      if (material.keyId !== envelope.header.keyId) throw denied("PENDING_ACTION_KEY_ID_MISMATCH");
      if (await sha256(aad) !== envelope.headerSha256 || await sha256(ciphertext) !== envelope.ciphertextSha256) throw denied("PENDING_ACTION_ENVELOPE_INTEGRITY_INVALID");
      if (envelope.header.expiresAtMs <= nowMs) throw denied("PENDING_ACTION_ENVELOPE_EXPIRED");
      let plaintext: Uint8Array;
      try {
        const key = await crypto.subtle.importKey("raw", material.key, "AES-GCM", false, ["decrypt"]);
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ciphertext));
      } catch { throw denied("PENDING_ACTION_ENVELOPE_DECRYPT_FAILED"); }
      const command = PendingStartCommandSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (!command.success) throw denied("PENDING_ACTION_COMMAND_INVALID");
      return Object.freeze({ header: envelope.header, command: command.data });
    } catch (error) {
      if (error instanceof Error && error.message === "PENDING_ACTION_RESTORE_DENIED") throw error;
      throw denied("PENDING_ACTION_ENVELOPE_UNEXPECTED");
    }
  }
}

/** In-memory per-checkpoint keyring used only as a deterministic port adapter. */
export class AesGcmCheckpointCrypto implements CheckpointCryptoPort {
  #keys = new Map<string, Uint8Array>();
  #counter = 0;
  readonly #randomValues: (bytes: Uint8Array) => Uint8Array;

  constructor(options: Readonly<{ randomValues?: (bytes: Uint8Array) => Uint8Array }> = {}) {
    this.#randomValues = options.randomValues ?? ((bytes) => {
      crypto.getRandomValues(bytes as unknown as ArrayBufferView<ArrayBuffer>);
      return bytes;
    });
  }

  async seal(input: Readonly<{ checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array }>) {
    if (!input.checkpointId || !(input.plaintext instanceof Uint8Array) || !(input.additionalData instanceof Uint8Array)) throw new Error("CHECKPOINT_SEAL_INVALID");
    const keyBytes = this.#randomValues(new Uint8Array(32));
    const nonce = this.#randomValues(new Uint8Array(12));
    if (keyBytes.byteLength !== 32 || nonce.byteLength !== 12) throw new Error("CHECKPOINT_CRYPTO_RANDOM_INVALID");
    const keyReference = `checkpoint-key:${input.checkpointId}:${++this.#counter}`;
    const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: input.additionalData as BufferSource }, key, input.plaintext as BufferSource));
    this.#keys.set(keyReference, new Uint8Array(keyBytes));
    return Object.freeze({ keyReference, nonce: new Uint8Array(nonce), ciphertext });
  }

  async open(input: Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }>): Promise<Uint8Array> {
    const keyBytes = this.#keys.get(input.keyReference);
    if (!keyBytes || input.nonce.byteLength !== 12) throw new Error("CHECKPOINT_RESTORE_DENIED");
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: input.nonce as BufferSource, additionalData: input.additionalData as BufferSource }, key, input.ciphertext as BufferSource));
    } catch { throw new Error("CHECKPOINT_RESTORE_DENIED"); }
  }

  async destroy(keyReference: string): Promise<void> { this.#keys.delete(keyReference); }
  keyReferences(): readonly string[] { return Object.freeze([...this.#keys.keys()]); }
}

function validateInventory(inventory: readonly string[]): asserts inventory is readonly z.infer<typeof InventoryClassSchema>[] {
  if (inventory.some((entry) => FORBIDDEN_INVENTORY.has(entry))) throw new Error("CHECKPOINT_FORBIDDEN_CONTENT");
  if (inventory.length !== REQUIRED_INVENTORY.size || new Set(inventory).size !== inventory.length || inventory.some((entry) => !REQUIRED_INVENTORY.has(entry))) throw new Error("CHECKPOINT_INCOMPLETE");
}

/** Coordinator-owned sealing/restore service. It accepts no worker/provider authority. */
export class CheckpointEnvelopeService {
  readonly #crypto: CheckpointCryptoPort;
  readonly #objectStore: ObjectStorePort;
  readonly #now: () => string;

  constructor(options: Readonly<{ crypto: CheckpointCryptoPort; objectStore: ObjectStorePort; now?: () => string; telemetry?: LifecycleTelemetryPort }>) {
    this.#crypto = options.crypto;
    this.#objectStore = options.objectStore;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#telemetry = options.telemetry;
  }

  readonly #telemetry?: LifecycleTelemetryPort;

  async seal(request: CheckpointSealRequest): Promise<Readonly<{ manifest: CheckpointManifest; envelope: CheckpointEnvelope }>> {
    validateInventory(request.inventory);
    if (!(request.archive instanceof Uint8Array) || Number.isNaN(Date.parse(request.retentionUntil))) throw new Error("CHECKPOINT_INCOMPLETE");
    const inventory = [...request.inventory].sort() as z.infer<typeof InventoryClassSchema>[];
    const manifest = CheckpointManifestSchema.parse({
      schemaVersion: "checkpoint-manifest-v1",
      checkpointId: request.checkpointId,
      accountId: request.accountId,
      sessionId: request.sessionId,
      pauseGeneration: request.pauseGeneration,
      sessionVersion: request.sessionVersion,
      actionVersion: request.actionVersion,
      artifactVersion: request.artifactVersion,
      workspaceVersion: request.workspaceVersion,
      workspaceLineage: request.workspaceLineage,
      action: request.action,
      inventory,
      inventorySha256: await sha256(canonicalBytes(inventory)),
      archiveSha256: await sha256(request.archive),
      evidenceSha256: request.evidenceSha256,
      compatibility: request.compatibility,
      committedAt: this.#now(),
      retentionUntil: request.retentionUntil,
    });
    const additionalData = canonicalBytes(manifest);
    const sealed = await this.#crypto.seal({ checkpointId: manifest.checkpointId, plaintext: request.archive, additionalData });
    const ciphertextSha256 = await sha256(sealed.ciphertext);
    const object = await this.#objectStore.createImmutable({ key: `checkpoints/${manifest.checkpointId}/${ciphertextSha256}`, bytes: sealed.ciphertext });
    const envelope = CheckpointEnvelopeSchema.parse({
      schemaVersion: "checkpoint-envelope-v1",
      manifestSha256: await sha256(canonicalBytes(manifest)),
      ciphertextBase64: b64(sealed.ciphertext),
      ciphertextSha256,
      object,
      crypto: { algorithm: "AES-GCM", keyReference: sealed.keyReference, nonceBase64: b64(sealed.nonce), aadSha256: await sha256(additionalData) },
    });
    const result = Object.freeze({ manifest, envelope });
    await emitLifecycleObservation(this.#telemetry, [manifest.accountId, manifest.sessionId, manifest.checkpointId], "checkpoint", "succeeded", Date.parse(manifest.committedAt));
    return result;
  }

  async restore(envelopeInput: unknown, manifestInput: unknown): Promise<Uint8Array> {
    try {
      const envelope = CheckpointEnvelopeSchema.parse(envelopeInput);
      const manifest = CheckpointManifestSchema.parse(manifestInput);
      const additionalData = canonicalBytes(manifest);
      const ciphertext = fromB64(envelope.ciphertextBase64);
      const nonce = fromB64(envelope.crypto.nonceBase64);
      if (!ciphertext || !nonce || await sha256(canonicalBytes(manifest)) !== envelope.manifestSha256 || await sha256(additionalData) !== envelope.crypto.aadSha256 || await sha256(ciphertext) !== envelope.ciphertextSha256 || envelope.object.checksum !== envelope.ciphertextSha256) throw new Error("CHECKPOINT_RESTORE_DENIED");
      const object = await this.#objectStore.readExact(envelope.object);
      if (!object || b64(object) !== envelope.ciphertextBase64) throw new Error("CHECKPOINT_RESTORE_DENIED");
      const plaintext = await this.#crypto.open({ keyReference: envelope.crypto.keyReference, nonce, ciphertext, additionalData });
      if (await sha256(plaintext) !== manifest.archiveSha256) throw new Error("CHECKPOINT_RESTORE_DENIED");
      return plaintext;
    } catch { throw new Error("CHECKPOINT_RESTORE_DENIED"); }
  }

  /**
   * Retention reconciliation is the only deletion caller.  It passes the
   * immutable identity committed with the terminal checkpoint tombstone; this
   * wrapper intentionally exposes neither archive bytes nor mutable object
   * names to the reaper.
   */
  async destroyKey(keyReference: string): Promise<void> {
    if (!keyReference) throw new Error("CHECKPOINT_DELETE_INVALID");
    await this.#crypto.destroy(keyReference);
  }

  async scheduleDeleteGeneration(reference: ImmutableObjectReference, deleteAfterMs: number): Promise<void> {
    const parsed = ImmutableObjectReferenceSchema.parse(reference);
    if (!Number.isSafeInteger(deleteAfterMs) || deleteAfterMs < 0) throw new Error("CHECKPOINT_DELETE_INVALID");
    await this.#objectStore.scheduleExactDeletion(parsed, new Date(deleteAfterMs).toISOString());
  }
}
