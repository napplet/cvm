import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OpaqueReferenceSchema = z.string().regex(/^os-secret-ref:[a-z][a-z0-9._-]{2,127}$/u);
const FundingRailSchema = z.enum(["nwc_lightning", "cashu"]);
const CapturedRailSchema = z.object({
  rail: FundingRailSchema,
  secretReference: OpaqueReferenceSchema,
  capabilitySha256: DigestSchema,
  accountScopeSha256: DigestSchema,
  expiresAtMs: z.number().int().positive(),
  status: z.literal("ready"),
}).strict();

export type OperatorFundingRail = z.infer<typeof FundingRailSchema>;
export type CapturedOperatorFundingRail = z.infer<typeof CapturedRailSchema>;
export type OperatorFundingReadiness = Readonly<{
  version: 1;
  status: "pending" | "ready" | "invalid";
  rails: readonly Readonly<{
    rail: OperatorFundingRail;
    secretReference: string;
    capabilitySha256: string;
    accountScopeSha256: string;
    expiresAtMs: number;
    status: "ready" | "revoked" | "expired";
  }>[];
  readinessSha256: string;
}>;

/** Deliberately narrow persistence seam. Values written here have already
 * passed the opaque-locator schema; wallet material is never a serializable
 * value in this subsystem. */
export type OperatorFundingReadinessStore = Readonly<{
  write(value: OperatorFundingReadiness): Promise<void>;
}>;

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pendingOperatorFundingReadiness(): Promise<OperatorFundingReadiness> {
  const payload = { version: 1 as const, status: "pending" as const, rails: [] as const };
  return Object.freeze({ ...payload, readinessSha256: await digest(payload) });
}

/** Rejects lookalike persisted records before a controller/request can bind
 * them. The digest recheck prevents a caller from changing expiry, revocation,
 * or a rail locator after it was recorded. */
export async function validateOperatorFundingReadiness(input: unknown): Promise<OperatorFundingReadiness> {
  const schema = z.object({
    version: z.literal(1),
    status: z.enum(["pending", "ready", "invalid"]),
    rails: z.array(z.object({
      rail: FundingRailSchema,
      secretReference: OpaqueReferenceSchema,
      capabilitySha256: DigestSchema,
      accountScopeSha256: DigestSchema,
      expiresAtMs: z.number().int().positive(),
      status: z.enum(["ready", "revoked", "expired"]),
    }).strict()).max(2),
    readinessSha256: DigestSchema,
  }).strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("OPERATOR_FUNDING_READINESS_INVALID");
  const { readinessSha256, ...payload } = parsed.data;
  if (readinessSha256 !== await digest(payload)) throw new Error("OPERATOR_FUNDING_READINESS_INVALID");
  return Object.freeze({ ...payload, rails: Object.freeze(parsed.data.rails.map((rail) => Object.freeze({ ...rail }))), readinessSha256 });
}

/**
 * Controller-owned prerequisite state. It stores only OS-secret locator names and
 * opaque capability/account hashes; it cannot read/open an NWC URI or Cashu wallet.
 */
export function createOperatorFundingPrerequisiteController(options: Readonly<{
  now?: () => number;
  /** Test seam proving capture never opens a secret surface. It is intentionally unused. */
  onSecretSurfaceOpen?: () => void;
}> = {}) {
  const now = options.now ?? Date.now;
  const records = new Map<OperatorFundingRail, CapturedOperatorFundingRail & Readonly<{ invalidated: boolean }>>();

  return Object.freeze({
    async capture(input: unknown): Promise<void> {
      const parsed = CapturedRailSchema.safeParse(input);
      if (!parsed.success) throw new Error("OPERATOR_FUNDING_REFERENCE_INVALID");
      const current = records.get(parsed.data.rail);
      /** A new locator is never silently substituted beneath an existing pending
       * review. It remains recorded as revoked, forcing a fresh prerequisite bind. */
      records.set(parsed.data.rail, Object.freeze({
        ...parsed.data,
        invalidated: current !== undefined && (
          current.secretReference !== parsed.data.secretReference
          || current.capabilitySha256 !== parsed.data.capabilitySha256
          || current.accountScopeSha256 !== parsed.data.accountScopeSha256
        ),
      }));
    },
    async readiness(): Promise<OperatorFundingReadiness> {
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("OPERATOR_FUNDING_TIME_INVALID");
      const rails = (["nwc_lightning", "cashu"] as const).flatMap((rail) => {
        const record = records.get(rail);
        if (!record) return [];
        const status = record.invalidated ? "revoked" as const : record.expiresAtMs <= nowMs ? "expired" as const : "ready" as const;
        return [Object.freeze({
          rail: record.rail,
          secretReference: record.secretReference,
          capabilitySha256: record.capabilitySha256,
          accountScopeSha256: record.accountScopeSha256,
          expiresAtMs: record.expiresAtMs,
          status,
        })];
      });
      const status = rails.length !== 2 ? "pending" as const : rails.every((rail) => rail.status === "ready") ? "ready" as const : "invalid" as const;
      const payload = { version: 1 as const, status, rails };
      return Object.freeze({ ...payload, readinessSha256: await digest(payload) });
    },
  });
}

/** The only user-owner signing state allowed before publication. It is purposefully
 * informational: no NIP-46 request, session, signer, or credential exists here. */
export const OWNER_MANIFEST_SIGNING_DEFERRED = Object.freeze({
  protocol: "nip46" as const,
  status: "deferred_to_publication" as const,
});
