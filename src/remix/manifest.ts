import { z } from "zod";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { decodeAddressPointer, naddrEncode } from "applesauce-core/helpers/pointers";

export const REMIX_ASSET_LIMIT = 2_000_000;
export const REMIX_HTML_CONTEXT_LIMIT = 128_000;
export { RemixReferenceSchema } from "./reference";
const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
export const RemixEventSchema = z.object({ id: Hex, pubkey: Hex, sig: z.string().regex(/^[a-f0-9]{128}$/u), kind: z.union([z.literal(15129), z.literal(35129)]), created_at: z.number().int().nonnegative(), content: z.string().max(8000), tags: z.array(z.array(z.string().max(2048)).max(8)).max(256) }).strict();
export type RemixManifest = { event: Event; naddr: string; title: string; description: string; artifactHash: string; servers: string[]; source?: string; schema: "artifact" | "legacy-path" };

export function remixAddress(value: string) {
  const text = value.trim().replace(/^nostr:/iu, "");
  if (text.length > 4096 || !/^naddr1[0-9a-z]+$/u.test(text)) throw new Error("Enter a napplet naddr address.");
  const pointer = decodeAddressPointer(text);
  if (!pointer || ![15129, 35129].includes(pointer.kind) || !/^[a-f0-9]{64}$/u.test(pointer.pubkey) || pointer.identifier.length > 256 || (pointer.kind === 15129 && pointer.identifier !== "")) throw new Error("This naddr must identify a named or root napplet.");
  return pointer;
}
export function remixManifest(value: unknown, address?: string): RemixManifest {
  const event = RemixEventSchema.parse(value);
  if (!verifyEvent(event) || event.created_at > Date.now() / 1000 + 60) throw new Error("The napplet signature could not be verified.");
  const tags = (name: string) => event.tags.filter(tag => tag[0] === name);
  const identifiers = tags("d");
  if ((event.kind === 35129 && (identifiers.length !== 1 || identifiers[0]!.length !== 2)) || (event.kind === 15129 && identifiers.length)) throw new Error("The napplet address is invalid.");
  const identifier = identifiers[0]?.[1] ?? "";
  if (address) { const pointer = remixAddress(address); if (pointer.kind !== event.kind || pointer.pubkey !== event.pubkey || pointer.identifier !== identifier) throw new Error("The resolved napplet does not match this naddr."); }
  const hashes = tags("x"); const paths = tags("path"); const index = paths.filter(tag => tag[1] === "/index.html");
  const legacy = paths.length > 0;
  if (legacy ? index.length !== 1 || index[0]!.length !== 3 || hashes.length !== 1 || hashes[0]?.[2] !== "aggregate" : hashes.length !== 1 || hashes[0]!.length !== 2 || !event.content.trim()) throw new Error("This napplet does not describe a single HTML artifact.");
  const artifactHash = Hex.parse(legacy ? index[0]![2] : hashes[0]![1]);
  const sources = tags("source"); if (sources.length > 1 || sources.some(tag => tag.length !== 2)) throw new Error("The napplet source tag is invalid.");
  const servers: string[] = [];
  for (const tag of tags("server")) { try { const url = new URL(tag[1]!); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") servers.push(url.origin); } catch { /* Ignore malformed hints. */ } }
  return { event, naddr: naddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier }), title: tags("title")[0]?.[1]?.slice(0, 120) || "Untitled napplet", description: event.content, artifactHash, servers: [...new Set(servers)].slice(0, 5), ...(sources[0]?.[1] ? { source: sources[0][1] } : {}), schema: legacy ? "legacy-path" : "artifact" };
}
export async function verifiedRemixAsset(html: string, hash: string): Promise<void> {
  const bytes = new TextEncoder().encode(html);
  if (!bytes.length || bytes.length > REMIX_ASSET_LIMIT) throw new Error("This applet is too large to remix here. Choose one with an HTML file under 2 MB.");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (digest !== hash) throw new Error("The applet file does not match its signed hash.");
}
