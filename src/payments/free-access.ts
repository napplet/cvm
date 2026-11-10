import { nip19 } from "nostr-tools";
import { z } from "zod";
import type { FundingService } from "../funding/funding-service";
import { PrincipalSchema, type Principal } from "../phase-03/contracts";
import { CreditAmountSchema } from "./contracts";
import { adapterCreditGrants } from "./credits";

export function allowlistedPubkey(value: string): string {
  if (/^[a-f0-9]{64}$/u.test(value)) return value;
  try { const decoded = nip19.decode(value); if (decoded.type === "npub") return PrincipalSchema.shape.pubkey.parse(decoded.data); } catch { /* Reject all other key forms. */ }
  throw new Error("FREE_ACCESS_PUBKEY_INVALID");
}

/** Operators sponsor bounded credits; the existing ledger and signed limits still authorize usage. */
export class FreeCreditAccess {
  readonly #allowlist: ReadonlySet<string>;
  readonly #credits;
  readonly #maximum: bigint;
  constructor(funding: FundingService, input: Readonly<{ allowlist: readonly string[]; maximumCredits: string }>) {
    if (!input.allowlist.length || input.allowlist.length > 1024) throw new Error("FREE_ACCESS_ALLOWLIST_REQUIRED");
    this.#allowlist = new Set(input.allowlist.map(allowlistedPubkey));
    this.#maximum = BigInt(CreditAmountSchema.parse(input.maximumCredits));
    this.#credits = adapterCreditGrants(funding, "operator-free");
  }

  authorize(principal: Principal): void {
    if (!this.#allowlist.has(PrincipalSchema.parse(principal).pubkey)) throw new Error("FREE_ACCESS_DENIED");
  }

  async prepare(principal: Principal, tool: string, input: unknown): Promise<void> {
    this.authorize(principal);
    const field = tool === "funded_admission" ? "requestedCap" : ["start_session", "revise_session"].includes(tool) ? "maximum" : tool === "approve_session_cap" ? "maximum" : undefined;
    if (!field) return;
    const parsed = z.object({ idempotencyKey: z.string().min(1), [field]: CreditAmountSchema }).passthrough().parse(input);
    const credits = parsed[field] as string;
    if (BigInt(credits) > this.#maximum) throw new Error("FREE_ACCESS_MAXIMUM_EXCEEDED");
    await this.#credits.grant({ principal, reference: `${tool}:${parsed.idempotencyKey}`, credits, policyVersion: "operator-free-v1", verifiedAt: new Date().toISOString() });
  }
}
