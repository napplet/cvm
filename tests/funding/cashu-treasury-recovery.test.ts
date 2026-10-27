import { describe, expect, test } from "bun:test";
import { OutputData, blindMessage, createBlindSignature, createDLEQProof, deriveKeysetId, getEncodedToken, getPubKeyFromPrivKey, pointFromHex, type RequestFn } from "@cashu/cashu-ts";
import { InMemoryCashuTreasuryCustody, canonicalCashuProofIdentities, canonicalCashuTokenIdentity } from "../../src/funding/treasury-custody";
import { CashuTsSettlementAdapter } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import fixture from "../fixtures/cashu-phase-03.json";

const mintUrl = "https://mint-a.example";
const keysetId = "009a1b2c3d4e5f60";
const token = (proofs: readonly { amount: bigint; secret: string; C: string }[]) => new TextEncoder().encode(getEncodedToken({ mint: mintUrl, unit: "sat", proofs: proofs.map((proof) => ({ ...proof, id: keysetId })) }));
const first = { amount: 8n, secret: "first-secret", C: `02${"11".repeat(32)}` };
const second = { amount: 13n, secret: "second-secret", C: `02${"22".repeat(32)}` };
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const keyAmounts = [1, 2, 4, 8, 16, 32] as const;
const privateKeys = new Map(keyAmounts.map((amount) => [String(amount), new Uint8Array(32).fill(amount)]));
const generators = Object.fromEntries([...privateKeys].map(([amount, privateKey]) => [amount, hex(getPubKeyFromPrivKey(privateKey))]));
const fixtureKeysetId = deriveKeysetId(generators);
const signedOutput = (output: { B_: string; amount: string; id: string }) => {
  const B_ = pointFromHex(output.B_);
  const privateKey = privateKeys.get(output.amount); if (!privateKey) throw new Error(`unsupported amount:${output.amount}`);
  const signature = createBlindSignature(B_, privateKey, output.id);
  const dleq = createDLEQProof(B_, privateKey);
  return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true), dleq: { e: hex(dleq.e), s: hex(dleq.s) } };
};
const validProof = (secret: string, amount: string, id = keysetId) => {
  const blinded = blindMessage(new TextEncoder().encode(secret), 3n);
  const output = new OutputData({ B_: blinded.B_.toHex(true), amount, id }, blinded.r, blinded.secret);
  return output.toProof(signedOutput({ B_: blinded.B_.toHex(true), amount, id }), { id, unit: "sat", keys: { [amount]: generators[amount]! } });
};
class RecoveryVault {
  #values = new Map<string, Uint8Array>(); #next = 0;
  async seal(_: unknown, plaintext: Uint8Array) { const id = `vault:${++this.#next}`; this.#values.set(id, plaintext.slice()); return { id, payloadDigest: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer))) }; }
  async expire(id: string) { this.#values.delete(id); }
  async open(request: { id: string }) { const value = this.#values.get(request.id); if (!value) throw new Error("missing"); return value.slice(); }
}

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
    const alternateSignatureEncoding = token([{ ...first, C: first.C.toUpperCase() }, second]);
    expect(await canonicalCashuProofIdentities(alternateSignatureEncoding, [keysetId])).toEqual(await canonicalCashuProofIdentities(ordered, [keysetId]));
    const alternateDenomination = token([{ ...first, amount: 9n }, second]);
    expect(await canonicalCashuProofIdentities(alternateDenomination, [keysetId])).toEqual(await canonicalCashuProofIdentities(ordered, [keysetId]));
  });

  test("exposes every individual proof commitment so overlap, subset, and superset claims collide", async () => {
    const both = new Set(await canonicalCashuProofIdentities(token([first, second]), [keysetId]));
    const firstOnly = await canonicalCashuProofIdentities(token([first]), [keysetId]);
    const secondOnly = await canonicalCashuProofIdentities(token([second]), [keysetId]);
    expect(firstOnly).toHaveLength(1); expect(secondOnly).toHaveLength(1);
    expect(both.has(firstOnly[0]!)).toBeTrue(); expect(both.has(secondOnly[0]!)).toBeTrue();
  });

  test("recovers a lost default cashu-ts swap through exact persisted NUT-09 messages without a second swap", async () => {
    let swaps = 0; let restores = 0; let original: { B_: string; amount: string; id: string }[] = [];
    const request: RequestFn = async (input) => {
      if (input.endpoint.endsWith("/v1/info")) return { name: "fixture", version: "1", nuts: { 12: { supported: true } } } as never;
      if (input.endpoint.includes("/v1/keysets")) return { keysets: [{ id: fixtureKeysetId, unit: "sat", active: true, input_fee_ppk: 0 }] } as never;
      if (input.endpoint.includes("/v1/keys")) return { keysets: [{ id: fixtureKeysetId, unit: "sat", keys: generators }] } as never;
      if (input.endpoint.endsWith("/v1/swap")) { swaps += 1; original = (input.requestBody as { outputs: typeof original }).outputs; throw new Error("LOST_RESPONSE_AFTER_MINT_SWAP"); }
      if (input.endpoint.endsWith("/v1/restore")) { restores += 1; const outputs = (input.requestBody as { outputs: typeof original }).outputs; expect(outputs.map((output) => output.B_).sort()).toEqual(original.map((output) => output.B_).sort()); return { outputs, signatures: outputs.map((output) => signedOutput({ ...output, amount: output.amount.toString() })) } as never; }
      if (input.endpoint.endsWith("/v1/checkstate")) return { states: (input.requestBody as { Ys: string[] }).Ys.map((Y) => ({ Y, state: "SPENT", witness: null })) } as never;
      throw new Error(`unexpected:${input.endpoint}`);
    };
    const vault = new RecoveryVault(); const repository = new InMemoryCashuTopUpRepository(); const store = new TransactionalMemoryFundingStore();
    const policy = { ...fixture.policies[0]!, mints: fixture.policies[0]!.mints.map((mint) => mint.url === mintUrl ? { ...mint, keysetIds: [fixtureKeysetId] } : mint) };
    const principal = { pubkey: "c".repeat(64) }; const bearer = new TextEncoder().encode(getEncodedToken({ mint: mintUrl, unit: "sat", proofs: [validProof("durable-input-16", "16", fixtureKeysetId), validProof("durable-input-4", "4", fixtureKeysetId), validProof("durable-input-1", "1", fixtureKeysetId)] }));
    const command = { principal, idempotencyKey: "recover-default", topUpId: "recover-default", amount: "21", unit: "sat" as const, pmi: fixture.pmi, token: bearer };
    const first = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(policy), provider: new CashuTsSettlementAdapter({ request }), vault, funding: new FundingService(store), repository });
    expect((await first.submit(command)).state).toBe("reconciliation_pending");
    expect(await repository.custody(command.topUpId)).toMatchObject({ state: "dispatching" });
    const restarted = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(policy), provider: new CashuTsSettlementAdapter({ request }), vault, funding: new FundingService(store), repository });
    const reconciled = await restarted.reconcile(command.topUpId);
    expect({ swaps, restores }).toEqual({ swaps: 1, restores: 1 });
    expect(reconciled.state).toBe("credited");
    expect(store.postings).toHaveLength(1);
  });

  test("refuses malformed NUT-09 recovery responses without a replacement swap", async () => {
    for (const mode of ["partial", "foreign", "duplicate", "missing", "corrupt", "missing-dleq"] as const) {
      let swaps = 0; let restores = 0; let original: { B_: string; amount: string; id: string }[] = [];
      const request: RequestFn = async (input) => {
        if (input.endpoint.endsWith("/v1/info")) return { name: "fixture", version: "1", nuts: { 12: { supported: true } } } as never;
        if (input.endpoint.includes("/v1/keysets")) return { keysets: [{ id: fixtureKeysetId, unit: "sat", active: true, input_fee_ppk: 0 }] } as never;
        if (input.endpoint.includes("/v1/keys")) return { keysets: [{ id: fixtureKeysetId, unit: "sat", keys: generators }] } as never;
        if (input.endpoint.endsWith("/v1/swap")) { swaps += 1; original = (input.requestBody as { outputs: typeof original }).outputs; throw new Error("LOST_RESPONSE_AFTER_MINT_SWAP"); }
        if (input.endpoint.endsWith("/v1/restore")) {
          restores += 1;
          const outputs = (input.requestBody as { outputs: typeof original }).outputs;
          const signatures = outputs.map((output) => signedOutput({ ...output, amount: output.amount.toString() }));
          if (mode === "partial") return { outputs: outputs.slice(0, -1), signatures: signatures.slice(0, -1) } as never;
          if (mode === "foreign") {
            const foreign = blindMessage(new TextEncoder().encode("foreign-output"), 7n).B_.toHex(true);
            return { outputs: [{ ...outputs[0]!, B_: foreign }, ...outputs.slice(1)], signatures: [signedOutput({ ...outputs[0]!, B_: foreign, amount: outputs[0]!.amount.toString() }), ...signatures.slice(1)] } as never;
          }
          if (mode === "duplicate") return { outputs: [outputs[0]!, outputs[0]!, ...outputs.slice(2)], signatures: [signatures[0]!, signatures[0]!, ...signatures.slice(2)] } as never;
          if (mode === "missing") return { outputs, signatures: [] } as never;
          if (mode === "corrupt") {
            const wrongKey = privateKeys.get("32")!;
            return { outputs, signatures: outputs.map((output) => {
              const proof = createDLEQProof(pointFromHex(output.B_), wrongKey);
              return { id: output.id, amount: output.amount, C_: createBlindSignature(pointFromHex(output.B_), wrongKey, output.id).C_.toHex(true), dleq: { e: hex(proof.e), s: hex(proof.s) } };
            }) } as never;
          }
          return { outputs, signatures: signatures.map(({ dleq: _dleq, ...signature }) => signature) } as never;
        }
        if (input.endpoint.endsWith("/v1/checkstate")) return { states: (input.requestBody as { Ys: string[] }).Ys.map((Y) => ({ Y, state: "SPENT", witness: null })) } as never;
        throw new Error(`unexpected:${input.endpoint}`);
      };
      const vault = new RecoveryVault(); const repository = new InMemoryCashuTopUpRepository(); const store = new TransactionalMemoryFundingStore();
      const policy = { ...fixture.policies[0]!, mints: fixture.policies[0]!.mints.map((mint) => mint.url === mintUrl ? { ...mint, keysetIds: [fixtureKeysetId] } : mint) };
      const principal = { pubkey: "d".repeat(64) }; const bearer = new TextEncoder().encode(getEncodedToken({ mint: mintUrl, unit: "sat", proofs: [validProof(`${mode}-input-16`, "16", fixtureKeysetId), validProof(`${mode}-input-4`, "4", fixtureKeysetId), validProof(`${mode}-input-1`, "1", fixtureKeysetId)] }));
      const command = { principal, idempotencyKey: `recover-${mode}`, topUpId: `recover-${mode}`, amount: "21", unit: "sat" as const, pmi: fixture.pmi, token: bearer };
      const first = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(policy), provider: new CashuTsSettlementAdapter({ request }), vault, funding: new FundingService(store), repository });
      expect((await first.submit(command)).state).toBe("reconciliation_pending");
      const restarted = new CashuTopUpCoordinator({ policies: new CashuMintPolicyRegistry(policy), provider: new CashuTsSettlementAdapter({ request }), vault, funding: new FundingService(store), repository });
      expect((await restarted.reconcile(command.topUpId)).state).toBe("reconciliation_pending");
      expect({ swaps, restores }).toEqual({ swaps: 1, restores: 1 });
      expect(store.postings).toHaveLength(0);
      expect(original).toHaveLength(3);
    }
  });
});
