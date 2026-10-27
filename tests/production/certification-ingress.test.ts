import { expect, test } from "bun:test";
import { getPublicKey } from "nostr-tools/pure";
import { ProductionCertificationIngress } from "../../src/production/certification-ingress";
import { loadProductionCertificationPubkey } from "../../src/production/certification-identity";
import type { ContextVmTransportPort, ContextVmInboundEnvelope } from "../../src/contextvm/sdk-bridge";
import type { MountedProductionSecretMaterial } from "../../src/production/secret-material";

test("staged ingress rejects strangers before any funding, admission or durable dispatch", async () => {
  const allowed = "a".repeat(64), stranger = "b".repeat(64);
  let receive!: (value: ContextVmInboundEnvelope) => Promise<void>;
  let calls = 0;
  const replies: unknown[] = [];
  const source: ContextVmTransportPort = {
    onInbound(handler) { receive = handler; }, configureAnnouncement() {},
    async sendResponse(pubkey, response, eventId) { replies.push({ pubkey, response, eventId }); }, async sendNotification() {},
    canonicalInvocation() { throw new Error("unexpected canonical invocation"); },
  };
  new ProductionCertificationIngress(allowed).wrap(source).onInbound(async () => { calls++; });
  for (const name of ["top_up", "funded_admission", "start_session", "revise_session", "resume_session", "publication", "account_status"]) {
    await receive({ verifiedClientPubkey: stranger, requestEventId: name, rawEvent: { id: name, tags: [] }, request: { id: name, method: "tools/call", params: { name, pubkey: allowed } } });
    expect(calls).toBe(0);
  }
  expect(replies).toHaveLength(7);
  expect(replies[0]).toMatchObject({ pubkey: stranger, response: { error: { code: -32003 } } });
  await receive({ verifiedClientPubkey: allowed, requestEventId: "original", rawEvent: { id: "original", tags: [] }, request: { id: "original", method: "tools/call", params: { name: "funded_admission" } } });
  expect(calls).toBe(1);
  expect(() => new ProductionCertificationIngress("invalid")).toThrow("PRINCIPAL_INVALID");
});

test("certification account derives from the disposable signer mount", async () => {
  const key = new Uint8Array(32); key[31] = 1;
  const secret = Buffer.from(key).toString("hex");
  const secrets = { async text(name: string, limit: number) { expect(name).toBe("certification.clientKeyReference"); expect(limit).toBe(128); return secret; } } as MountedProductionSecretMaterial;
  expect(await loadProductionCertificationPubkey(secrets)).toBe(getPublicKey(key));
  for (const invalid of ["invalid", "0".repeat(64)]) await expect(loadProductionCertificationPubkey({ async text() { return invalid; } } as unknown as MountedProductionSecretMaterial)).rejects.toThrow("KEY_INVALID");
});
