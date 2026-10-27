import { z } from "zod";

const HttpsUrlSchema = z.string().min(1);
const KeysetIdSchema = z.string().min(1).max(128);

export const CashuMintPolicySchema = z.object({
  version: z.string().min(1).max(128),
  activeFrom: z.iso.datetime(),
  activeUntil: z.iso.datetime().nullable(),
  mints: z.array(z.object({
    url: HttpsUrlSchema,
    unit: z.literal("sat").default("sat"),
    keysetIds: z.array(KeysetIdSchema).min(1),
    // A policy authorizes a bounded NUT-02 input fee for every currently
    // allowed keyset. The live mint value is checked again before dispatch.
    maxInputFeePpk: z.number().int().min(0).max(1_000_000),
    requireDleq: z.boolean(),
    proofConditions: z.array(z.literal("none")).min(1).default(["none"]),
  }).strict()).min(2),
}).strict();

export type CashuMintPolicy = Readonly<z.infer<typeof CashuMintPolicySchema>>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalCashuMintUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("CASHU_MINT_URL_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("CASHU_MINT_URL_INVALID");
  const normalized = parsed.toString().replace(/\/$/u, "");
  return normalized;
}

function normalize(input: unknown): CashuMintPolicy {
  const parsed = CashuMintPolicySchema.parse(input);
  if (parsed.activeUntil && parsed.activeUntil <= parsed.activeFrom) throw new Error("CASHU_POLICY_INTERVAL_INVALID");
  const mints = parsed.mints.map((mint) => {
    const url = canonicalCashuMintUrl(mint.url);
    if (new Set(mint.keysetIds).size !== mint.keysetIds.length) throw new Error("CASHU_POLICY_KEYSET_COLLISION");
    return freeze({ ...mint, url, keysetIds: [...mint.keysetIds].sort(), proofConditions: [...mint.proofConditions].sort() });
  }).sort((left, right) => left.url.localeCompare(right.url));
  if (new Set(mints.map((mint) => mint.url)).size !== mints.length) throw new Error("CASHU_POLICY_MINT_COLLISION");
  return freeze({ ...parsed, mints });
}

/** Immutable multi-mint policy history. Rotation only changes the active pointer. */
export class CashuMintPolicyRegistry {
  #versions = new Map<string, CashuMintPolicy>();
  #activeVersion: string;

  constructor(initial: unknown) {
    const policy = normalize(initial);
    this.#versions.set(policy.version, policy);
    this.#activeVersion = policy.version;
  }

  add(input: unknown): CashuMintPolicy {
    const policy = normalize(input);
    if (this.#versions.has(policy.version)) throw new Error("CASHU_POLICY_VERSION_COLLISION");
    this.#versions.set(policy.version, policy);
    return policy;
  }

  rotate(version: string): CashuMintPolicy {
    const policy = this.get(version);
    this.#activeVersion = policy.version;
    return policy;
  }

  get(version: string): CashuMintPolicy {
    const policy = this.#versions.get(version);
    if (!policy) throw new Error("CASHU_POLICY_VERSION_UNKNOWN");
    return policy;
  }

  pinActive(): CashuMintPolicy { return this.get(this.#activeVersion); }
}
