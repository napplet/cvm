import { canonicalJson } from "../promotion/schema";
import type { AuthenticatedFundingCommand, Principal } from "../phase-03/contracts";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable service-owned identity derived only from the verified Nostr sender key. */
export async function accountIdForPrincipal(principal: Principal): Promise<string> {
  return `account:${await sha256(principal.pubkey)}`;
}

/** D-45 canonical command identity: exact replay is semantic, never object-order dependent. */
export async function fingerprintAccountCommand(command: AuthenticatedFundingCommand, accountId: string): Promise<string> {
  const payloadHash = await sha256(canonicalJson(command.payload));
  return sha256(canonicalJson({
    accountId,
    principalPubkey: command.principal.pubkey,
    kind: command.kind,
    idempotencyKey: command.idempotencyKey,
    policyVersion: command.policyVersion,
    protocolVersion: command.protocolVersion,
    payloadHash,
  }));
}
