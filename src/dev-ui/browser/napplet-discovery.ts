import { EventStore } from "applesauce-core";
import { getContacts, getOutboxes, createOutboxMap, selectOptimalRelays } from "applesauce-core/helpers";
import { createAddressLoader, createOutboxTimelineLoader } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { catchError, EMPTY, firstValueFrom, fromEvent, take, takeUntil, timer, toArray, type Observable } from "rxjs";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { relayUrl } from "../destinations";
import { REMIX_ASSET_LIMIT, remixAddress, remixManifest, verifiedRemixAsset, type RemixManifest } from "../../remix/manifest";

const newest = (events: Event[]) => events.sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
const safeRelays = (values: string[]) => [...new Set(values.flatMap(value => { try { return [relayUrl(value)]; } catch { return []; } }))].slice(0, 5);

/** Public Nostr data only. Generation/private projects still use signed CVM. */
export class NappletDiscovery {
  readonly store = new EventStore({ verifyEvent });
  readonly pool = new RelayPool({ requestReconnect: 0, subscriptionReconnect: 0, keepAlive: 3000 });
  readonly #lifetime = new AbortController();
  readonly #addresses;
  constructor(private readonly fallback: string[], private readonly directories = ["wss://purplepag.es"]) {
    this.#addresses = createAddressLoader(this.pool, { eventStore: null, lookupRelays: directories, followRelayHints: true, bufferTime: 30, signal: this.#lifetime.signal });
  }
  private async collect(stream: Observable<Event>, signal: AbortSignal, limit = 500): Promise<Event[]> {
    signal.throwIfAborted();
    const events = await firstValueFrom(stream.pipe(take(limit), takeUntil(timer(6000)), takeUntil(fromEvent(signal, "abort")), catchError(() => EMPTY), toArray()));
    signal.throwIfAborted();
    return events.filter(event => { try { if (JSON.stringify(event).length > 64_000 || event.created_at > Date.now()/1000+60 || !verifyEvent(event)) return false; this.store.add(event); return true; } catch { return false; } });
  }
  async outboxes(pubkeys: string[], signal: AbortSignal) {
    const events = await this.collect(this.pool.request(this.directories, { kinds: [10002], authors: pubkeys, limit: pubkeys.length * 3 }), signal);
    return pubkeys.map(pubkey => { const list = newest(events.filter(event => event.kind === 10002 && event.pubkey === pubkey)); const relays = safeRelays(list ? getOutboxes(list) : []); return { pubkey, relays: relays.length ? relays : safeRelays(this.fallback) }; });
  }
  async resolve(address: string, signal: AbortSignal): Promise<{ manifest: RemixManifest; html: string }> {
    const pointer = remixAddress(address);
    const [owner] = await this.outboxes([pointer.pubkey], signal);
    const relays = safeRelays([...(pointer.relays ?? []), ...(owner?.relays ?? [])]);
    const candidates = await this.collect(this.#addresses({ ...pointer, relays, cache: false }), signal, 20);
    const event = newest(candidates.filter(event => event.kind === pointer.kind && event.pubkey === pointer.pubkey && (event.tags.find(tag => tag[0] === "d")?.[1] ?? "") === pointer.identifier));
    if (!event) throw new Error("This napplet wasn’t found. Check the address or try again.");
    const manifest = remixManifest(event, address);
    let servers = manifest.servers;
    if (!servers.length) {
      const lists = await this.collect(this.pool.request(relays, { kinds: [10063], authors: [pointer.pubkey], limit: 5 }), signal, 10);
      servers = newest(lists.filter(event => event.kind === 10063 && event.pubkey === pointer.pubkey))?.tags.filter(tag => tag[0] === "server").map(tag => tag[1]!).slice(0, 5) ?? [];
    }
    for (const server of servers) {
      try {
        const url = new URL(server);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) continue;
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue;
        const response = await fetch(`${url.origin}/${manifest.artifactHash}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
        if (!response.ok || !response.body) continue;
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > REMIX_ASSET_LIMIT) throw new Error("REMIX_ASSET_LIMIT"); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => undefined); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
        const html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); await verifiedRemixAsset(html, manifest.artifactHash);
        return { manifest, html };
      } catch { signal.throwIfAborted(); }
    }
    throw new Error("The applet’s HTML file couldn’t be verified or is larger than 2 MB. Check its Blossom servers and try again.");
  }
  async browse(pubkey: string, network: boolean, signal: AbortSignal, until?: number): Promise<RemixManifest[]> {
    let authors = [pubkey];
    if (network) {
      const [owner] = await this.outboxes([pubkey], signal);
      const contacts = newest((await this.collect(this.pool.request(owner!.relays, { kinds: [3], authors: [pubkey], limit: 5 }), signal, 20)).filter(event => event.kind === 3 && event.pubkey === pubkey));
      authors = contacts ? [...new Set(getContacts(contacts).map(contact => contact.pubkey))].filter(value => /^[a-f0-9]{64}$/u.test(value)).slice(0, 100) : [];
    }
    if (!authors.length) return [];
    const pointers = selectOptimalRelays(await this.outboxes(authors, signal), { maxConnections: 12, maxRelaysPerUser: 2 });
    const loader = createOutboxTimelineLoader(this.pool, createOutboxMap(pointers), { kinds: [15129, 35129] }, { limit: 30 });
    const found = await this.collect(loader({ until: until ?? Math.floor(Date.now()/1000), since: -Infinity }), signal, 200);
    const unique = new Map<string, RemixManifest>();
    for (const event of found.sort((a,b) => b.created_at-a.created_at || a.id.localeCompare(b.id))) {
      if (!authors.includes(event.pubkey)) continue;
      try { const manifest = remixManifest(event); if (!unique.has(manifest.naddr)) unique.set(manifest.naddr, manifest); } catch { /* Unsupported manifests never become remix inputs. */ }
    }
    return [...unique.values()].slice(0, 60);
  }
  close() { this.#lifetime.abort(); this.pool.close(); this.store.dispose(); }
}
