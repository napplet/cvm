import { SimplePool } from "nostr-tools/pool";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { relayUrl } from "../destinations";

export const RELAY_DIRECTORY = "wss://purplepag.es";
export const MONITOR_DIRECTORY = "wss://relay.nostr.watch";
export function writeRelays(events: Event[], pubkey: string, now = Date.now() / 1000): string[] {
  const event = events.filter(event => event.kind === 10002 && event.pubkey === pubkey && event.created_at <= now + 60 && verifyEvent(event)).sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const result: string[] = [];
  for (const tag of event?.tags ?? []) if (tag[0] === "r" && (!tag[2] || tag[2] === "write")) { try { const url = relayUrl(tag[1]!); if (!result.includes(url)) result.push(url); } catch { /* Invalid list entries do not become destinations. */ } }
  return result.slice(0, 5);
}
export function relaySuggestions(events: Event[], now = Date.now() / 1000): string[] {
  const candidates = new Map<string, Set<string>>();
  const latest = new Map<string, Event>();
  for (const event of events) {
    if (event.kind !== 30166 || !verifyEvent(event) || event.created_at > now + 60) continue;
    const key = `${event.pubkey}:${event.tags.find(tag => tag[0] === "d")?.[1]}`;
    const prior = latest.get(key);
    if (!prior || event.created_at > prior.created_at || (event.created_at === prior.created_at && event.id < prior.id)) latest.set(key,event);
  }
  for (const event of latest.values()) {
    if (event.kind !== 30166 || event.created_at < now - 86400 || event.created_at > now + 60 || !verifyEvent(event)) continue;
    if (event.tags.some(tag => (tag[0] === "R" && ["auth", "payment", "writes"].includes(tag[1]!)) || (tag[0] === "k" && tag[1] === "!35129"))) continue;
    if (!event.tags.some(tag => tag[0] === "rtt-write" && /^\d+(\.\d+)?$/.test(tag[1]!) && Number(tag[1]) > 0)) continue;
    try { const url = relayUrl(event.tags.find(tag => tag[0] === "d")?.[1] ?? ""); if (!url.startsWith("wss://")) continue; const monitors = candidates.get(url) ?? new Set<string>(); monitors.add(event.pubkey); candidates.set(url, monitors); } catch { /* Monitor data is advisory. */ }
  }
  // Independent monitor agreement is a suggestion, never proof of availability.
  return [...candidates].filter(([, monitors]) => monitors.size >= 2).sort((a,b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 20).map(([url]) => url);
}
export async function discoverWriteRelays(pubkey: string): Promise<string[]> {
  const pool = new SimplePool(); try { return writeRelays(await pool.querySync([RELAY_DIRECTORY], { kinds: [10002], authors: [pubkey], limit: 5 }, { maxWait: 6000 }), pubkey); } finally { pool.destroy(); }
}
export async function suggestRelays(): Promise<string[]> {
  const pool = new SimplePool(); try { return relaySuggestions(await pool.querySync([MONITOR_DIRECTORY], { kinds: [30166], since: Math.floor(Date.now()/1000)-86400, limit: 500 }, { maxWait: 6000 })); } finally { pool.destroy(); }
}
