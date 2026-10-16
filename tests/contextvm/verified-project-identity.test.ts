import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { ContextVmSdkBridge } from "../../src/contextvm/sdk-bridge";
import { DevelopmentProjects } from "../../src/dev/projects";
test("bridge checks the actual signed request and its sender before project dispatch", async () => {
  const key = generateSecretKey(); const pubkey = getPublicKey(key);
  const params = { name: "projects", arguments: { action: "list" } };
  let event = JSON.parse(JSON.stringify(finalizeEvent({ kind: 25910, created_at: 1000, tags: [], content: JSON.stringify({ jsonrpc:"2.0",id:1,method:"tools/call",params }) },key)));
  let received: unknown;
  const transport: any = { getNostrRequestEvent: () => event };
  const bridge = new ContextVmSdkBridge(transport,["projects"]); bridge.onInbound(async value => { received = value; });
  const request = () => ({ id:1,method:"tools/call", params: { ...params, _meta: { requestEventId:event.id } } });
  transport.onmessageWithContext(request(),{ clientPubkey:getPublicKey(generateSecretKey()) }); await Bun.sleep(1); expect(received).toBeUndefined();
  const signature = event.sig; event.sig = "0".repeat(128);
  transport.onmessageWithContext(request(),{ clientPubkey:pubkey }); await Bun.sleep(1); expect(received).toBeUndefined();
  event = JSON.parse(JSON.stringify({ ...event, sig:signature }));
  transport.onmessageWithContext(request(),{ clientPubkey:pubkey }); await Bun.sleep(1); expect((received as any)?.verifiedClientPubkey).toBe(pubkey);
});
test("project requests cannot supply an owner, account or npub", async () => {
  let queries = 0; const projects = new DevelopmentProjects({ query: async () => { queries++; return { rows: [] }; } } as any);
  for (const extra of [{ pubkey:"a".repeat(64) },{ owner:"a".repeat(64) },{ npub:"npub1anything" },{ accountId:"someone" }]) await expect(projects.handle({ action:"list", ...extra },"b".repeat(64))).rejects.toThrow();
  await expect(projects.handle({ action:"list" },"unverified")).rejects.toThrow(); expect(queries).toBe(0);
});
