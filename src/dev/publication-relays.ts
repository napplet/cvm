import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Event } from "nostr-tools/pure";
import { fileURLToPath } from "node:url";
import { relayUrl } from "../dev-ui/destinations";

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3]] as const) blocked.addSubnet(ip,prefix,"ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::",3,"ipv6"); blocked.addSubnet("2001:db8::",32,"ipv6");
export function publicRelayAddress(address: string): boolean { const family = isIP(address); return family === 4 ? !blocked.check(address,"ipv4") : family === 6 && globalV6.check(address,"ipv6") && !blocked.check(address,"ipv6"); }
export type RelayReceipt = { relay: string; state: "published" | "failed"; detail?: string };
export async function publishOnUserRelays(relays: string[], event: Event, developmentRelay: string, send: boolean | "always"): Promise<RelayReceipt[]> {
  return Promise.all(relays.map(async value => {
    let child: ReturnType<typeof Bun.spawn> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const normalized = relayUrl(value); const url = new URL(normalized);
      const local = normalized === relayUrl(developmentRelay);
      const addresses = await lookup(url.hostname.replace(/^\[|\]$/g,""), { all:true });
      if (!addresses.length || (!local && addresses.some(item => !publicRelayAddress(item.address)))) throw new Error("Relay is not publicly reachable");
      const node = Bun.which("node"); if (!node) throw new Error("Node socket adapter unavailable");
      const spawned = Bun.spawn([node,"--max-old-space-size=64",fileURLToPath(new URL("./publication-relay-worker.mjs",import.meta.url))], {
        env: {}, stdin: new Blob([JSON.stringify({ url:normalized,address:addresses[0],event,send })]), stdout:"pipe", stderr:"ignore",
      });
      child = spawned;
      timer = setTimeout(() => child?.kill(), 22000);
      const output = await new Response(spawned.stdout).text(); const exit = await spawned.exited;
      const confirmed = exit === 0 && output.length < 100 && JSON.parse(output).confirmed === true;
      return confirmed ? { relay:normalized,state:"published" as const } : { relay:normalized,state:"failed" as const,detail:"No confirmation received." };
    } catch { return { relay:value,state:"failed" as const,detail:"Connection failed or publication declined." }; }
    finally { clearTimeout(timer); child?.kill(); }
  }));
}
