import { z } from "zod";
import { matchFilters } from "nostr-tools/filter";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";

/** Disposable local NIP-46 bunker. Owner key lives only in this test fixture;
 * production receives the URI and a distinct disposable client-key broker. */
export function openDirectNip46Fixture(ownerKey: Uint8Array, now: () => number) {
  const bunkerKey = new Uint8Array(32).fill(17), clientKey = new Uint8Array(32).fill(19);
  const requests: Array<{ id: string; method: string; template?: unknown }> = [];
  const responses = new Map<string, { event: Event; method: string }>();
  let hidden = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return undefined; return new Response(null, { status: 404 }); },
    websocket: { message(socket, bytes) {
      const wire: unknown = JSON.parse(String(bytes));
      if (!Array.isArray(wire)) throw new Error("FIXTURE_WIRE_INVALID");
      if (wire[0] === "EVENT") {
        const event = z.object({ id: z.string(), pubkey: z.string(), sig: z.string(), kind: z.literal(24133), created_at: z.number(), content: z.string(), tags: z.array(z.array(z.string())) }).strict().parse(wire[1]);
        if (!verifyEvent(event)) throw new Error("FIXTURE_SIGNATURE_INVALID");
        const conversation = nip44.v2.utils.getConversationKey(bunkerKey, event.pubkey);
        const request = z.object({ id: z.string(), method: z.enum(["connect", "get_public_key", "sign_event"]), params: z.array(z.string()) }).strict().parse(JSON.parse(nip44.v2.decrypt(event.content, conversation)));
        let result: string;
        if (request.method === "connect") result = "ack";
        else if (request.method === "get_public_key") result = getPublicKey(ownerKey);
        else {
          const template = z.object({ kind: z.union([z.literal(35129), z.literal(24242)]), created_at: z.number().int().positive(), content: z.string(), tags: z.array(z.array(z.string())) }).strict().parse(JSON.parse(request.params[0]!));
          requests.push({ id: request.id, method: request.method, template });
          result = JSON.stringify(finalizeEvent(template, ownerKey));
        }
        if (request.method !== "sign_event") requests.push({ id: request.id, method: request.method });
        const response = finalizeEvent({ kind: 24133, created_at: Math.floor(now() / 1000), tags: [["p", event.pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: request.id, result }), conversation) }, bunkerKey);
        responses.set(response.id, { event: response, method: request.method });
        socket.close(1011, "fixture lost acknowledgement");
      } else if (wire[0] === "REQ") {
        const filters = z.array(z.object({ kinds: z.array(z.number()).optional(), authors: z.array(z.string()).optional(), "#p": z.array(z.string()).optional(), limit: z.number().optional() }).strict()).parse(wire.slice(2));
        for (const response of responses.values()) if (!(hidden && response.method === "sign_event") && matchFilters(filters, response.event)) socket.send(JSON.stringify(["EVENT", wire[1], response.event]));
        socket.send(JSON.stringify(["EOSE", wire[1]]));
      }
    } },
  });
  return { bunkerUri: `bunker://${getPublicKey(bunkerKey)}?relay=${encodeURIComponent(`ws://127.0.0.1:${server.port}`)}&secret=fixture-direct-consent`,
    requests, sessionKeyReference: "nostr:direct-disposable-client", sessionKeyBroker: { async resolve() { return new Uint8Array(clientKey); } },
    hideSigningResponses(value: boolean) { hidden = value; }, close() { server.stop(true); clientKey.fill(0); bunkerKey.fill(0); } };
}
