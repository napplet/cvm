import { decodeNbunksec, encodeNbunksec, type BunkerInfo } from "applesauce-signers/helpers/nbunksec";
import { getPublicKey } from "nostr-tools/pure";

export type IdentitySession = { mode: "nip07" } | { mode: "nip46"; nbunksec: string; pubkey: string };
const pubkeyPattern = /^[a-f0-9]{64}$/;
export const keyBytes = (value: string) => Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16));

// These credentials belong only to the trusted static origin. Never include them
// in CVM requests, bootstrap, telemetry, generated applets, or rendered markup.
export function bunkerSession(encoded: string): BunkerInfo {
  if (encoded.length > 8192) throw new Error("Invalid saved signer");
  const info = decodeNbunksec(encoded);
  if (!pubkeyPattern.test(info.pubkey) || !pubkeyPattern.test(info.local_key) || !info.relays.length || info.relays.length > 8) throw new Error("Invalid saved signer");
  getPublicKey(keyBytes(info.local_key)); // Reject invalid secret scalars, including zero.
  for (const address of info.relays) {
    const url = new URL(address);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || new TextEncoder().encode(address).length > 255) throw new Error("Invalid signer relay");
  }
  // The codec uses single-byte TLV lengths. Reject noncanonical/truncated data.
  if (encodeNbunksec(info) !== encoded) throw new Error("Invalid saved signer");
  return info;
}

export function readIdentitySession(key: string): IdentitySession | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    if (raw.length > 10000) throw new Error("Invalid saved signer");
    const value = JSON.parse(raw);
    if (value.version !== 1) throw new Error("Invalid saved signer");
    if (value.mode === "nip07") return { mode: "nip07" };
    if (value.mode !== "nip46" || typeof value.nbunksec !== "string" || !pubkeyPattern.test(value.pubkey)) throw new Error("Invalid saved signer");
    bunkerSession(value.nbunksec);
    return { mode: "nip46", nbunksec: value.nbunksec, pubkey: value.pubkey };
  } catch {
    try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  }
}

export function writeIdentitySession(key: string, session?: IdentitySession): boolean {
  try {
    if (session) localStorage.setItem(key, JSON.stringify({ version: 1, ...session }));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export { encodeNbunksec };
