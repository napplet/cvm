import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ImmutableObjectReferenceSchema, type ObjectStorePort } from "./object-store";

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
const REQUIRED_INVENTORY = new Set(InventoryClassSchema.options);
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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalJson(value)); }

/** In-memory per-checkpoint keyring used only as a deterministic port adapter. */
export class AesGcmCheckpointCrypto implements CheckpointCryptoPort {
  #keys = new Map<string, Uint8Array>();
  #counter = 0;
  readonly #randomValues: (bytes: Uint8Array) => Uint8Array;

  constructor(options: Readonly<{ randomValues?: (bytes: Uint8Array) => Uint8Array }> = {}) {
    this.#randomValues = options.randomValues ?? ((bytes) => crypto.getRandomValues(bytes));
  }

  async seal(input: Readonly<{ checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array }>) {
    if (!input.checkpointId || !(input.plaintext instanceof Uint8Array) || !(input.additionalData instanceof Uint8Array)) throw new Error("CHECKPOINT_SEAL_INVALID");
    const keyBytes = this.#randomValues(new Uint8Array(32));
    const nonce = this.#randomValues(new Uint8Array(12));
    if (keyBytes.byteLength !== 32 || nonce.byteLength !== 12) throw new Error("CHECKPOINT_CRYPTO_RANDOM_INVALID");
    const keyReference = `checkpoint-key:${input.checkpointId}:${++this.#counter}`;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: input.additionalData }, key, input.plaintext));
    this.#keys.set(keyReference, new Uint8Array(keyBytes));
    return Object.freeze({ keyReference, nonce: new Uint8Array(nonce), ciphertext });
  }

  async open(input: Readonly<{ keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }>): Promise<Uint8Array> {
    const keyBytes = this.#keys.get(input.keyReference);
    if (!keyBytes || input.nonce.byteLength !== 12) throw new Error("CHECKPOINT_RESTORE_DENIED");
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: input.nonce, additionalData: input.additionalData }, key, input.ciphertext));
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

  constructor(options: Readonly<{ crypto: CheckpointCryptoPort; objectStore: ObjectStorePort; now?: () => string }>) {
    this.#crypto = options.crypto;
    this.#objectStore = options.objectStore;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

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
    return Object.freeze({ manifest, envelope });
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
}
