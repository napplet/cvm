// Isolated Node socket adapter. Bun's native ws does not honor lookup or
// checkServerIdentity; Node ws preserves both when connecting to pinned IPs.
// stdin contains only a public signed event and a server-validated IP address.
import { createRequire } from "node:module";
import { AbstractRelay } from "nostr-tools/abstract-relay";
import { verifyEvent } from "nostr-tools/pure";
const require = createRequire(createRequire(import.meta.url).resolve("@contextvm/sdk"));
const Socket = require("ws");
let relay;
function observe(event) {
  return new Promise(resolve => {
    let done = false; let sub;
    const finish = found => { if (done) return; done = true; clearTimeout(timer); sub?.close(); resolve(found); };
    const timer = setTimeout(() => finish(false), 4000);
    sub = relay.subscribe([{ ids: [event.id] }], { onevent: candidate => { if (candidate.id === event.id && candidate.pubkey === event.pubkey && verifyEvent(candidate)) finish(true); }, oneose: () => finish(false), onclose: () => finish(false) });
  });
}
try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 4*1024*1024) throw new Error("input bound"); }
  const { url, address, event, send } = JSON.parse(input);
  if (!verifyEvent(event)) throw new Error("invalid event");
  class PinnedSocket extends Socket {
    constructor() { super(url, { followRedirects: false, handshakeTimeout: 7000, maxPayload: 1024*1024, rejectUnauthorized: true,
      lookup: (_host, options, callback) => options?.all ? callback(null,[address]) : callback(null,address.address,address.family) }); }
  }
  relay = new AbstractRelay(url, { verifyEvent, websocketImplementation: PinnedSocket });
  relay.publishTimeout = 7000; relay.baseEoseTimeout = 4000;
  await relay.connect({ timeout: 7000 });
  // Explicit republication must resend even when the relay already has it.
  let confirmed = send === "always" ? false : await observe(event);
  if (!confirmed && send) { try { await relay.publish(event); } catch { /* Read back ambiguous acknowledgements. */ } confirmed = await observe(event); }
  process.stdout.write(JSON.stringify({ confirmed }));
} catch { process.stdout.write(JSON.stringify({ confirmed:false })); }
finally { relay?.close(); }
