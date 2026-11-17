import { expect, test } from "bun:test";
import { ApplesauceRelayPool, PING_FILTER } from "@contextvm/sdk/relay/applesauce-relay-pool";

test("relay liveness uses a bounded positive limit and preserves subscriptions", async () => {
  let connections = 0;
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open() { connections++; },
      message(socket, bytes) {
        const message = JSON.parse(String(bytes));
        if (message[0] !== "REQ") return;
        if (message[2]?.ids?.[0] === PING_FILTER.ids?.[0]) {
          probes++;
          // nostr-rs-relay ignores limit-zero filters without sending EOSE.
          if (message[2].limit === 0) return;
        }
        socket.send(JSON.stringify(["EOSE", message[1]]));
      },
    },
  });
  const pool = new ApplesauceRelayPool([`ws://127.0.0.1:${server.port}`], { pingFrequencyMs: 40, pingTimeoutMs: 40 });
  try {
    await pool.connect();
    await pool.subscribe([{ kinds: [1] }], () => {});
    await Bun.sleep(300);
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(connections).toBe(1);
    expect(PING_FILTER.limit).toBe(1);
  } finally { await pool.disconnect(); server.stop(true); }
});

test("an unresponsive relay still triggers connection recovery", async () => {
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: { open() { connections++; }, message() { /* No protocol response. */ } },
  });
  const pool = new ApplesauceRelayPool([`ws://127.0.0.1:${server.port}`], { pingFrequencyMs: 30, pingTimeoutMs: 30 });
  try {
    await pool.connect();
    await pool.subscribe([{ kinds: [1] }], () => {});
    const deadline = Date.now() + 1000;
    while (connections < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(connections).toBeGreaterThan(1);
  } finally { await pool.disconnect(); server.stop(true); }
});
