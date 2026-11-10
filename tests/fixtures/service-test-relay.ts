import { matchFilters } from "nostr-tools/filter";
import { verifyEvent, type Event } from "nostr-tools/pure";

/** Process-local relay for signed/encrypted transport tests, never release evidence. */
export function serviceTestRelay() {
  const events: Event[] = [];
  const peers = new Set<any>();
  return Bun.serve<{ subscriptions: Map<string, any[]> }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request, { data: { subscriptions: new Map() } }) ? undefined : new Response("not found", { status: 404 }); },
    websocket: {
      open(peer) { peers.add(peer); }, close(peer) { peers.delete(peer); },
      message(peer, bytes) {
        const message = JSON.parse(String(bytes));
        if (message[0] === "EVENT") {
          const event = message[1] as Event;
          if (!verifyEvent(event)) { peer.send(JSON.stringify(["OK", event.id, false, "invalid signature"])); return; }
          if (!events.some(prior => prior.id === event.id)) events.push(event);
          peer.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const client of peers) for (const [id, filters] of client.data.subscriptions) if (matchFilters(filters, event)) client.send(JSON.stringify(["EVENT", id, event]));
        } else if (message[0] === "REQ") {
          peer.data.subscriptions.set(message[1], message.slice(2));
          for (const event of events) if (matchFilters(message.slice(2), event)) peer.send(JSON.stringify(["EVENT", message[1], event]));
          peer.send(JSON.stringify(["EOSE", message[1]]));
        } else if (message[0] === "CLOSE") peer.data.subscriptions.delete(message[1]);
      },
    },
  });
}
