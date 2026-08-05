import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);

export const ImmutableObjectReferenceSchema = z.object({
  key: z.string().min(1),
  generation: z.number().int().positive(),
  checksum: Sha256Schema,
}).strict();

export type ImmutableObjectReference = z.infer<typeof ImmutableObjectReferenceSchema>;
export type ImmutableObjectCreateRequest = Readonly<{ key: string; bytes: Uint8Array }>;

/** Exact-generation port; storage implementation selection stays outside this contract. */
export interface ObjectStorePort {
  createImmutable(request: ImmutableObjectCreateRequest): Promise<ImmutableObjectReference>;
  readExact(reference: ImmutableObjectReference): Promise<Uint8Array | undefined>;
  scheduleExactDeletion(reference: ImmutableObjectReference, deleteAfter: string): Promise<void>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
