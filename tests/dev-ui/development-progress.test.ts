import { expect, test } from "bun:test";
import { DevelopmentProgressTransport } from "../../src/dev-ui/development-progress";
import { acceptDevelopmentProgress, DevelopmentProgressSchema } from "../../src/dev-ui/progress-contract";
import type { ContextVmInboundEnvelope, ContextVmTransportPort } from "../../src/contextvm/sdk-bridge";
import { runBoundedDevelopmentCommand } from "../../src/dev/local-napplet-worker";

function fixture(notify?: () => Promise<void>) {
  let inbound!: (input: ContextVmInboundEnvelope) => Promise<void>;
  const notifications: any[] = []; const responses: any[] = [];
  const transport: ContextVmTransportPort = {
    onInbound(handler) { inbound = handler; }, configureAnnouncement() {}, canonicalInvocation: () => ({ clientPubkey: "a", invocationHash: "b" }),
    async sendResponse(...args) { responses.push(args); },
    async sendNotification(...args) { notifications.push(args); await notify?.(); },
  };
  const progress = new DevelopmentProgressTransport(transport, { heartbeatMs: 10, sendTimeoutMs: 20 });
  const envelope = (id: string): ContextVmInboundEnvelope => ({ verifiedClientPubkey: `owner-${id}`, requestEventId: `event-${id}`, rawEvent: { id: `event-${id}`, tags: [] }, request: { id, method: "tools/call", params: { name: "start_session", arguments: { secret: "NEVER_SEND" } } } });
  return { progress, notifications, responses, invoke: (id: string) => inbound(envelope(id)) };
}

test("concurrent progress stays with its verified caller/request; heartbeat does not advance a stage", async () => {
  const f = fixture();
  f.progress.onInbound(async (input) => {
    f.progress.emit("model", "running", { provider: "deterministic_fixture" });
    await Bun.sleep(input.request.id === "a" ? 45 : 25);
    f.progress.emit("build", "completed");
    await f.progress.sendResponse(input.verifiedClientPubkey, { jsonrpc: "2.0", id: input.request.id, result: {} }, input.requestEventId);
  });
  await Promise.all([f.invoke("a"), f.invoke("b")]);
  const count = f.notifications.length; await Bun.sleep(25); expect(f.notifications).toHaveLength(count);
  for (const id of ["a", "b"]) {
    const events = f.notifications.filter(([, event]) => event.params.requestId === id);
    expect(events.length).toBeGreaterThan(3);
    events.forEach(([owner, event, request], index) => { expect(owner).toBe(`owner-${id}`); expect(request).toBe(`event-${id}`); expect(event.params.sequence).toBe(index + 1); expect(DevelopmentProgressSchema.safeParse(event.params).success).toBe(true); });
    expect(events.filter(([, event]) => event.params.kind === "heartbeat").every(([, event]) => event.params.stage === "model")).toBe(true);
  }
  expect(JSON.stringify(f.notifications)).not.toContain("NEVER_SEND"); expect(f.responses).toHaveLength(2);
});

for (const mode of ["reject", "stall"] as const) test(`notification ${mode} cannot prevent an authoritative response`, async () => {
  const f = fixture(() => mode === "reject" ? Promise.reject(new Error("transport")) : new Promise(() => {}));
  f.progress.onInbound(async (input) => { f.progress.emit("ledger", "completed"); await f.progress.sendResponse(input.verifiedClientPubkey, { jsonrpc: "2.0", id: input.request.id, result: "committed" }, input.requestEventId); });
  await f.invoke("one"); expect(f.responses[0][1].result).toBe("committed");
});

test("browser accepts only matching, increasing, bounded progress with no arbitrary payload fields", () => {
  const event = { version: 1, requestId: "one", tool: "start_session", sequence: 2, at: 1, elapsedMs: 0, kind: "stage", stage: "model_stream", state: "running", bytes: 17 };
  const pending = { id: "one", tool: "start_session", sequence: 1 };
  expect(acceptDevelopmentProgress(event, pending)).toEqual(event);
  for (const change of [{ requestId: "other" }, { tool: "revise_session" }, { sequence: 1 }, { sequence: 0 }, { bytes: Infinity }, { rawOutput: "secret" }, { stage: "untrusted" }]) expect(acceptDevelopmentProgress({ ...event, ...change }, pending)).toBeUndefined();
});

test("command output arrives while running; broken observers do not alter result; stderr stays private", async () => {
  const lines: string[] = []; let exited = false;
  const result = await runBoundedDevelopmentCommand([process.execPath, "-e", "process.stdout.write('NAPPLET_'); await Bun.sleep(30); console.log('STAGE {}'); console.error('PRIVATE'); await Bun.sleep(50);"], { deadlineMs: 3000, maxBytes: 1024, onStdoutLine(line) { expect(exited).toBe(false); lines.push(line); throw new Error("observer"); } });
  exited = true; expect(result.exitCode).toBe(0); expect(lines).toEqual(["NAPPLET_STAGE {}"]); expect(result.stderr).toContain("PRIVATE");
});


test("MCP progress token survives the SDK rewriting the RPC id to a Nostr event id", async () => {
  let inbound!: (input: ContextVmInboundEnvelope) => Promise<void>;
  const notifications: any[] = [];
  const port: ContextVmTransportPort = { onInbound(handler) { inbound = handler; }, configureAnnouncement() {}, canonicalInvocation: () => ({ clientPubkey: "owner", invocationHash: "hash" }), async sendResponse() {}, async sendNotification(...args) { notifications.push(args); } };
  const progress = new DevelopmentProgressTransport(port);
  progress.onInbound(async (input) => { progress.emit("build", "running"); await progress.sendResponse(input.verifiedClientPubkey, { jsonrpc: "2.0", id: input.request.id, result: {} }, input.requestEventId); });
  await inbound({ verifiedClientPubkey: "verified-owner", requestEventId: "signed-event", rawEvent: { id: "signed-event", tags: [] }, request: { id: "sdk-rewritten-id", method: "tools/call", params: { name: "start_session", _meta: { progressToken: "browser-id" }, arguments: { pubkey: "forged-owner" } } } });
  expect(notifications.length).toBe(2);
  for (const [owner, event, correlation] of notifications) { expect(owner).toBe("verified-owner"); expect(event.params.requestId).toBe("browser-id"); expect(correlation).toBe("signed-event"); }
});
