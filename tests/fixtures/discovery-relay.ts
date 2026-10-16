import type { Event } from "nostr-tools/pure";
import { matchFilters, type Filter } from "nostr-tools/filter";
/** Real WebSocket protocol with controlled signed public data, for outbox tests. */
export function discoveryRelay() {
 const events: Event[] = []; const requests: Filter[][] = [];
 const server = Bun.serve({ hostname:"127.0.0.1",port:0,
  fetch(req,server) { return server.upgrade(req) ? undefined : new Response("Not found",{status:404}); },
  websocket: { message(socket,message) { const [type,id,...filters] = JSON.parse(String(message)); if(type!=="REQ") return; requests.push(filters); for(const event of events.filter(event=>matchFilters(filters,event)).sort((a,b)=>b.created_at-a.created_at).slice(0,200)) socket.send(JSON.stringify(["EVENT",id,event])); socket.send(JSON.stringify(["EOSE",id])); } },
 });
 return {events,requests,url:`ws://127.0.0.1:${server.port}`,close:()=>server.stop(true)};
}
