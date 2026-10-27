import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("ContextVM relay shutdown stays terminal when an in-flight liveness ping times out", async () => {
  // A separate process proves no reconnect or monitor timer survives shutdown.
  // The relay accepts subscriptions but deliberately withholds the ping EOSE.
  const source = `
    import { ApplesauceRelayPool, PING_FILTER } from "@contextvm/sdk/relay/applesauce-relay-pool";
    let pool;
    let closing = false;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
      websocket: { message(socket, bytes) {
        const message = JSON.parse(String(bytes));
        if (message[0] !== "REQ") return;
        if (message[2]?.ids?.[0] === PING_FILTER.ids[0]) {
          if (closing) return;
          closing = true;
          void pool.disconnect().then(() => { server.stop(true); console.log("SHUTDOWN_COMPLETE"); });
        } else socket.send(JSON.stringify(["EOSE", message[1]]));
      } },
    });
    pool = new ApplesauceRelayPool(["ws://127.0.0.1:" + server.port], { pingFrequencyMs: 30, pingTimeoutMs: 60 });
    await pool.connect();
    await pool.subscribe([{ kinds: [1] }], () => {});
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2_000);
  try {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(output).toContain("SHUTDOWN_COMPLETE");
    expect({ timedOut, code, errors }).toEqual({ timedOut: false, code: 0, errors: "" });
  } finally { clearTimeout(timer); child.kill(); }
});
