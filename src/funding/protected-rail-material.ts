/**
 * Rail payloads are bearer/provider material.  This module is deliberately the
 * only place where their plaintext is transformed to or from persistence.
 */
export type ProtectedRail = "lightning" | "cashu";

export type ProtectedRailMaterialMetadata = Readonly<{
  accountId: string;
  topUpId: string;
  rail: ProtectedRail;
}>;

export type ProtectedRailMaterialRecord = Readonly<ProtectedRailMaterialMetadata & {
  id: string;
  payloadDigest: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  createdAt: string;
  expiresAt?: string;
}>;

export interface ProtectedRailMaterialRepository {
  put(record: ProtectedRailMaterialRecord): Promise<void>;
  get(id: string): Promise<ProtectedRailMaterialRecord | undefined>;
  expire(id: string): Promise<void>;
}

export type ProtectedRailMaterialVaultOptions = Readonly<{
  key: Uint8Array;
  repository: ProtectedRailMaterialRepository;
  now?: () => string;
  randomValues?: (bytes: Uint8Array) => Uint8Array;
}>;

export type ProtectedRailMaterialReference = Readonly<{ id: string; payloadDigest: string }>;
export type ProtectedRailMaterialOpenRequest = Readonly<ProtectedRailMaterialMetadata & { id: string }>;

function freeze<T>(value: T): T {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function associatedData(metadata: ProtectedRailMaterialMetadata, payloadDigest: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ accountId: metadata.accountId, topUpId: metadata.topUpId, rail: metadata.rail, payloadDigest }));
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** In-memory repository is a deterministic test double; production injects durable storage. */
export class InMemoryProtectedRailMaterialRepository implements ProtectedRailMaterialRepository {
  #records = new Map<string, ProtectedRailMaterialRecord>();
  async put(record: ProtectedRailMaterialRecord): Promise<void> { this.#records.set(record.id, freeze(structuredClone(record))); }
  async get(id: string): Promise<ProtectedRailMaterialRecord | undefined> { const record = this.#records.get(id); return record ? freeze(structuredClone(record)) : undefined; }
  async expire(id: string): Promise<void> { this.#records.delete(id); }
  snapshot(): readonly ProtectedRailMaterialRecord[] { return freeze([...this.#records.values()].map((record) => structuredClone(record))); }
}

/** AES-GCM boundary with caller-provided 32-byte key material and top-up-bound AAD. */
export class ProtectedRailMaterialVault {
  readonly #key: Uint8Array<ArrayBuffer>;
  readonly #repository: ProtectedRailMaterialRepository;
  readonly #now: () => string;
  readonly #randomValues: (bytes: Uint8Array) => Uint8Array;

  constructor(options: ProtectedRailMaterialVaultOptions) {
    if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) throw new Error("PROTECTED_MATERIAL_KEY_INVALID");
    this.#key = new Uint8Array(options.key);
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomValues = options.randomValues ?? ((bytes) => crypto.getRandomValues(bytes));
  }

  async seal(metadata: ProtectedRailMaterialMetadata, plaintext: Uint8Array, expiresAt?: string): Promise<ProtectedRailMaterialReference> {
    if (!metadata.accountId || !metadata.topUpId || !(plaintext instanceof Uint8Array)) throw new Error("PROTECTED_MATERIAL_INVALID");
    // Snapshot before the first await: digest and ciphertext must describe the
    // same bytes even if the caller mutates or shares its original view.
    const payload = new Uint8Array(plaintext);
    try {
      const payloadDigest = await digest(payload);
      const proposedNonce = this.#randomValues(new Uint8Array(12));
      if (!(proposedNonce instanceof Uint8Array) || proposedNonce.byteLength !== 12) throw new Error("PROTECTED_MATERIAL_NONCE_INVALID");
      const nonce = new Uint8Array(proposedNonce);
      const key = await crypto.subtle.importKey("raw", this.#key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: associatedData(metadata, payloadDigest) }, key, payload));
      const id = `railmat:${payloadDigest.slice(0, 24)}:${b64(nonce)}`;
      await this.#repository.put(freeze({ ...metadata, id, payloadDigest, nonce, ciphertext, createdAt: this.#now(), ...(expiresAt ? { expiresAt } : {}) }));
      return freeze({ id, payloadDigest });
    } finally { payload.fill(0); }
  }

  async open(request: ProtectedRailMaterialOpenRequest): Promise<Uint8Array> {
    const record = await this.#repository.get(request.id);
    if (!record || record.accountId !== request.accountId || record.topUpId !== request.topUpId || record.rail !== request.rail) throw new Error("PROTECTED_MATERIAL_ACCESS_DENIED");
    const key = await crypto.subtle.importKey("raw", this.#key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(record.nonce), additionalData: associatedData(record, record.payloadDigest) }, key, new Uint8Array(record.ciphertext)));
    } catch { throw new Error("PROTECTED_MATERIAL_ACCESS_DENIED"); }
  }

  async expire(id: string): Promise<void> { await this.#repository.expire(id); }
}
