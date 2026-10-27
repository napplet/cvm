import { describe, expect, test } from "bun:test";
import { getEncodedToken } from "@cashu/cashu-ts";
import { InMemoryCashuTreasuryCustody, canonicalCashuProofIdentities, canonicalCashuTokenIdentity } from "../../src/funding/treasury-custody";

const mintUrl = "https://mint-a.example";
const keysetId = "009a1b2c3d4e5f60";
const token = (proofs: readonly { amount: bigint; secret: string; C: string }[]) => new TextEncoder().encode(getEncodedToken({ mint: mintUrl, unit: "sat", proofs: proofs.map((proof) => ({ ...proof, id: keysetId })) }));
const first = { amount: 8n, secret: "first-secret", C: `02${"11".repeat(32)}` };
const second = { amount: 13n, secret: "second-secret", C: `02${"22".repeat(32)}` };

describe("Cashu treasury custody", () => {
  test("persists service-owned input and exact blinded recovery material before dispatch", async () => {
    const custody = new InMemoryCashuTreasuryCustody();
    const operation = await custody.prepare({
      operationId: "cashu:top-up:one", accountId: "account:one", mintUrl, keysetId, unit: "sat", amount: "21",
      inputToken: token([first, second]), semanticProofIdentity: await canonicalCashuTokenIdentity(token([first, second]), [keysetId]),
      blindedMessages: [{ B_: "blinded-one", amount: "21", id: keysetId }],
    });
    expect(operation.state).toBe("prepared");
    expect(operation.inputCiphertext.byteLength).toBeGreaterThan(0);
    expect(operation.blindedCiphertext.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(operation.inputCiphertext)).not.toContain("first-secret");
    await expect(custody.restoreRequest("cashu:top-up:one")).resolves.toEqual([{ B_: "blinded-one", amount: "21", id: keysetId }]);
  });

  test("binds recovered outputs to the original blinded messages and rejects partial, foreign, or duplicate output sets", async () => {
    const custody = new InMemoryCashuTreasuryCustody();
    await custody.prepare({
      operationId: "cashu:top-up:two", accountId: "account:one", mintUrl, keysetId, unit: "sat", amount: "21",
      inputToken: token([first, second]), semanticProofIdentity: await canonicalCashuTokenIdentity(token([first, second]), [keysetId]),
      blindedMessages: [{ B_: "blinded-one", amount: "8", id: keysetId }, { B_: "blinded-two", amount: "13", id: keysetId }],
    });
    await expect(custody.recordRecoveredOutputs("cashu:top-up:two", [
      { B_: "blinded-one", amount: "8", id: keysetId, proof: "proof-one" },
      { B_: "blinded-two", amount: "13", id: keysetId, proof: "proof-two" },
    ])).resolves.toMatchObject({ state: "owned_outputs" });
    await expect(custody.recordRecoveredOutputs("cashu:top-up:two", [{ B_: "blinded-one", amount: "8", id: keysetId, proof: "proof-one" }])).rejects.toThrow("CASHU_RECOVERY_OUTPUT_BINDING_INVALID");
    await expect(custody.recordRecoveredOutputs("cashu:top-up:two", [
      { B_: "blinded-one", amount: "8", id: keysetId, proof: "proof-one" },
      { B_: "foreign", amount: "13", id: keysetId, proof: "proof-two" },
    ])).rejects.toThrow("CASHU_RECOVERY_OUTPUT_BINDING_INVALID");
  });

  test("canonicalizes the individual semantic proof set across reordered and re-encoded bearer tokens", async () => {
    const ordered = token([first, second]);
    const reordered = token([second, first]);
    expect(await canonicalCashuTokenIdentity(ordered, [keysetId])).toBe(await canonicalCashuTokenIdentity(reordered, [keysetId]));
    expect(await canonicalCashuTokenIdentity(token([first]), [keysetId])).not.toBe(await canonicalCashuTokenIdentity(ordered, [keysetId]));
  });

  test("exposes every individual proof commitment so overlap, subset, and superset claims collide", async () => {
    const both = new Set(await canonicalCashuProofIdentities(token([first, second]), [keysetId]));
    const firstOnly = await canonicalCashuProofIdentities(token([first]), [keysetId]);
    const secondOnly = await canonicalCashuProofIdentities(token([second]), [keysetId]);
    expect(firstOnly).toHaveLength(1); expect(secondOnly).toHaveLength(1);
    expect(both.has(firstOnly[0]!)).toBeTrue(); expect(both.has(secondOnly[0]!)).toBeTrue();
  });
});
