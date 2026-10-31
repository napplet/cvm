import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);

export const ImmutableObjectReferenceSchema = z.object({
  key: z.string().min(1),
  generation: z.number().int().positive(),
  checksum: Sha256Schema,
}).strict();

export type ImmutableObjectReference = z.infer<typeof ImmutableObjectReferenceSchema>;
/** `originalOperationIdentity` is an optional durable caller fence. Legacy
 * callers retain key/checksum semantics; adapters must hold ambiguity rather
 * than adopting a later same-checksum generation. */
export type ImmutableObjectCreateRequest = Readonly<{ key: string; bytes: Uint8Array; originalOperationIdentity?: string }>;

const VersionedObjectResponseSchema = z.object({
  generation: z.number().int().positive(),
  checksum: Sha256Schema,
}).strict();

const VersionedObjectReadResponseSchema = VersionedObjectResponseSchema.extend({
  bytes: z.instanceof(Uint8Array),
}).strict();

/** Provider-neutral, generation-only subset of a versioned object API. */
export interface VersionedObjectClientPort {
  createIfAbsent(input: Readonly<{ key: string; bytes: Uint8Array; checksum: string }>): Promise<z.infer<typeof VersionedObjectResponseSchema>>;
  /** Read-only metadata reconciliation for a controller-owned immutable key. */
  findExactByKey(input: Readonly<{ key: string; checksum: string }>): Promise<z.infer<typeof VersionedObjectResponseSchema> | undefined>;
  readGeneration(input: Readonly<{ key: string; generation: number; expectedChecksum: string }>): Promise<z.infer<typeof VersionedObjectReadResponseSchema> | undefined>;
  scheduleGenerationDeletion(input: Readonly<{ key: string; generation: number; expectedChecksum: string; deleteAfter: string }>): Promise<z.infer<typeof VersionedObjectResponseSchema>>;
}

/** Safe GCS-shaped configuration: credentials and SDK-native objects stay outside this adapter. */
export const GcsObjectStoreConfigSchema = z.object({
  bucket: z.string().min(3).max(222).regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u),
  projectId: z.string().min(1).max(128),
}).strict();

/** Exact-generation port; storage implementation selection stays outside this contract. */
export interface ObjectStorePort {
  createImmutable(request: ImmutableObjectCreateRequest): Promise<ImmutableObjectReference>;
  /** Read-only reconciliation by an already journaled immutable key/checksum. */
  observeExactByKey(input: Readonly<{ key: string; checksum: string; originalOperationIdentity?: string }>): Promise<ImmutableObjectReference | undefined>;
  readExact(reference: ImmutableObjectReference): Promise<Uint8Array | undefined>;
  scheduleExactDeletion(reference: ImmutableObjectReference, deleteAfter: string): Promise<void>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Production-shaped adapter boundary. It deliberately has no list/latest,
 * credentials, or provider response surface: all reads and deletes are pinned
 * to the immutable generation and checksum supplied by the coordinator.
 */
export class GcsObjectStoreAdapter implements ObjectStorePort {
  readonly #config: z.infer<typeof GcsObjectStoreConfigSchema>;
  readonly #client: VersionedObjectClientPort;

  constructor(options: Readonly<{ config: z.input<typeof GcsObjectStoreConfigSchema>; client: VersionedObjectClientPort }>) {
    this.#config = GcsObjectStoreConfigSchema.parse(options.config);
    this.#client = options.client;
  }

  async createImmutable(request: ImmutableObjectCreateRequest): Promise<ImmutableObjectReference> {
    if (!request.key || !(request.bytes instanceof Uint8Array)) throw new Error("OBJECT_INVALID");
    const checksum = await sha256(request.bytes);
    const created = VersionedObjectResponseSchema.parse(await this.#client.createIfAbsent({ key: request.key, bytes: new Uint8Array(request.bytes), checksum }));
    if (created.checksum !== checksum) throw new Error("OBJECT_IMMUTABLE_CONFLICT");
    return ImmutableObjectReferenceSchema.parse({ key: request.key, generation: created.generation, checksum: created.checksum });
  }

  async observeExactByKey(input: Readonly<{ key: string; checksum: string; originalOperationIdentity?: string }>): Promise<ImmutableObjectReference | undefined> {
    const key = z.string().min(1).safeParse(input.key); const checksum = Sha256Schema.safeParse(input.checksum);
    if (!key.success || !checksum.success) return undefined;
    // This historical adapter has no durable original-operation field. Its
    // legacy two-field lookup remains available, but an identity-bearing
    // caller must not adopt a later same-checksum generation by accident.
    if (input.originalOperationIdentity !== undefined) return undefined;
    const observed = await this.#client.findExactByKey({ key: key.data, checksum: checksum.data });
    if (!observed || observed.checksum !== checksum.data) return undefined;
    return ImmutableObjectReferenceSchema.safeParse({ key: key.data, generation: observed.generation, checksum: observed.checksum }).data;
  }

  async readExact(reference: ImmutableObjectReference): Promise<Uint8Array | undefined> {
    const parsed = ImmutableObjectReferenceSchema.safeParse(reference);
    if (!parsed.success) return undefined;
    const response = await this.#client.readGeneration({ key: parsed.data.key, generation: parsed.data.generation, expectedChecksum: parsed.data.checksum });
    if (!response) return undefined;
    const exact = VersionedObjectReadResponseSchema.safeParse(response);
    if (!exact.success || exact.data.generation !== parsed.data.generation || exact.data.checksum !== parsed.data.checksum || await sha256(exact.data.bytes) !== parsed.data.checksum) throw new Error("OBJECT_EXACT_GENERATION_REQUIRED");
    return new Uint8Array(exact.data.bytes);
  }

  async scheduleExactDeletion(reference: ImmutableObjectReference, deleteAfter: string): Promise<void> {
    const parsed = ImmutableObjectReferenceSchema.safeParse(reference);
    if (!parsed.success || Number.isNaN(Date.parse(deleteAfter))) throw new Error("OBJECT_DELETE_INVALID");
    const result = VersionedObjectResponseSchema.parse(await this.#client.scheduleGenerationDeletion({ key: parsed.data.key, generation: parsed.data.generation, expectedChecksum: parsed.data.checksum, deleteAfter }));
    if (result.generation !== parsed.data.generation || result.checksum !== parsed.data.checksum) throw new Error("OBJECT_EXACT_GENERATION_REQUIRED");
  }

  /** Non-secret identity suitable only for operator-facing evidence. */
  identity(): Readonly<{ provider: "gcs"; bucket: string; projectId: string }> {
    return Object.freeze({ provider: "gcs", bucket: this.#config.bucket, projectId: this.#config.projectId });
  }
}

type Entry = Readonly<ImmutableObjectReference & { bytes: Uint8Array; deleteAfter?: string }>;

/** Deterministic in-memory adapter for tests; it makes no production storage claim. */
export class DeterministicObjectStore implements ObjectStorePort {
  #entries = new Map<string, Entry>();

  async createImmutable(request: ImmutableObjectCreateRequest): Promise<ImmutableObjectReference> {
    if (!request.key || !(request.bytes instanceof Uint8Array)) throw new Error("OBJECT_INVALID");
    const checksum = await sha256(request.bytes);
    const existing = this.#entries.get(request.key);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error("OBJECT_IMMUTABLE_CONFLICT");
      return { key: existing.key, generation: existing.generation, checksum: existing.checksum };
    }
    const entry: Entry = Object.freeze({ key: request.key, generation: 1, checksum, bytes: new Uint8Array(request.bytes) });
    this.#entries.set(request.key, entry);
    return { key: entry.key, generation: entry.generation, checksum: entry.checksum };
  }

  async observeExactByKey(input: Readonly<{ key: string; checksum: string; originalOperationIdentity?: string }>): Promise<ImmutableObjectReference | undefined> {
    const key = z.string().min(1).safeParse(input.key); const checksum = Sha256Schema.safeParse(input.checksum);
    if (!key.success || !checksum.success) return undefined;
    if (input.originalOperationIdentity !== undefined) return undefined;
    const entry = this.#entries.get(key.data);
    return entry?.checksum === checksum.data ? { key: entry.key, generation: entry.generation, checksum: entry.checksum } : undefined;
  }

  async readExact(reference: ImmutableObjectReference): Promise<Uint8Array | undefined> {
    const parsed = ImmutableObjectReferenceSchema.safeParse(reference);
    if (!parsed.success) return undefined;
    const entry = this.#entries.get(parsed.data.key);
    if (!entry || entry.generation !== parsed.data.generation || entry.checksum !== parsed.data.checksum) return undefined;
    return new Uint8Array(entry.bytes);
  }

  async scheduleExactDeletion(reference: ImmutableObjectReference, deleteAfter: string): Promise<void> {
    const parsed = ImmutableObjectReferenceSchema.safeParse(reference);
    if (!parsed.success || Number.isNaN(Date.parse(deleteAfter))) throw new Error("OBJECT_DELETE_INVALID");
    const entry = this.#entries.get(parsed.data.key);
    if (!entry || entry.generation !== parsed.data.generation || entry.checksum !== parsed.data.checksum) throw new Error("OBJECT_EXACT_GENERATION_REQUIRED");
    this.#entries.set(entry.key, Object.freeze({ ...entry, deleteAfter }));
  }

  entries(): readonly ImmutableObjectReference[] {
    return Object.freeze([...this.#entries.values()].map(({ key, generation, checksum }) => Object.freeze({ key, generation, checksum })));
  }
}
