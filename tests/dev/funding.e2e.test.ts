import { expect, test } from "bun:test";
import { Wallet, getDecodedToken, getEncodedToken } from "@cashu/cashu-ts";
import { createDevelopmentFunding } from "../../scripts/dev-funding";
import { developmentStack, expectedDevelopmentMigrations, waitUntil } from "../../scripts/dev-payments";

const e2e = process.env.NAPPLET_CVM_DEV_PAYMENTS_E2E === "1" ? test : test.skip;
const principal = { pubkey: "ab".repeat(32) };
const stranger = { pubkey: "cd".repeat(32) };
const lightningCommand = (key: string, amount: string) => ({ principal, idempotencyKey: key, amount, unit: "sat", policyVersion: "development-local-v1", protocolVersion: "funding-contract-v1" });

async function cashuFailureDiagnostic(
  app: Awaited<ReturnType<typeof createDevelopmentFunding>>,
  primary: Wallet,
  proofs: ReturnType<typeof getDecodedToken>["proofs"],
  topUpId: string,
): Promise<void> {
  // Keep failure evidence bounded and secret-free.  This repeats only the
  // local, pre-dispatch preview: no swap request or bearer value is emitted.
  const [record, preview] = await Promise.all([
    app.database.cashu.find(topUpId).then((value) => value ? {
      resultState: value.result.state,
      custodyState: value.custody?.state ?? null,
      expectedOutputAmount: value.custody?.expectedOutputAmount ?? null,
    } : null).catch(() => null),
    (async () => {
      try {
        const prepared = await primary.ops.receive(proofs).keyset(proofs[0]?.id ?? "").requireDleq(true).prepare();
        return { status: "prepared", amount: prepared.amount.toString(), fees: prepared.fees.toString(), outputs: (prepared.keepOutputs?.length ?? 0) + (prepared.sendOutputs?.length ?? 0) };
      } catch (error) {
        return { status: "rejected", error: error instanceof Error ? error.message.slice(0, 240) : "unknown" };
      }
    })(),
  ]);
  console.error(`[dev-payments cashu diagnostic] ${JSON.stringify({ topUpId, record, inputProofs: proofs.length, inputProofsWithDleq: proofs.filter((proof) => proof.dleq && typeof proof.dleq === "object").length, preview })}`);
}

e2e("real local payments credit the PostgreSQL application ledger once across restart", async () => {
  const stack = developmentStack(true);
  let app: Awaited<ReturnType<typeof createDevelopmentFunding>> | undefined;
  try {
    const config = await stack.up();
    app = await createDevelopmentFunding(config);
    expect((await app.funding.status(principal)).available).toBe("0");
    expect((await app.pool.query("SELECT name, sha256 FROM development_migrations ORDER BY name")).rows).toEqual((await expectedDevelopmentMigrations()).map(({ name, sha256 }) => ({ name, sha256 })).sort((left, right) => left.name.localeCompare(right.name)));
    expect(app.policies.pinActive().mints[0]!.keysetIds).not.toEqual(app.policies.pinActive().mints[1]!.keysetIds);

    const primary = new Wallet(config.mintUrl);
    await primary.loadMint();
    const keysets = (await primary.mint.getKeySets()).keysets.map((keyset) => keyset.id);
    const originalProofs = getDecodedToken(config.cashuToken, keysets).proofs;
    const cashu = { principal, idempotencyKey: "local:cashu:1", topUpId: "local:cashu:1", amount: "1024", maxFee: "1", unit: "sat", pmi: "bitcoin-cashu-v4-direct", token: app.applicationToken(config.cashuToken) };
    const credited = await app.cashu.submit(cashu).catch(async (error) => {
      await cashuFailureDiagnostic(app!, primary, originalProofs, cashu.topUpId);
      throw error;
    });
    expect(credited.state).toBe("credited");
    expect(credited).toMatchObject({ amount: "1023", grossAmount: "1024", feeAmount: "1" });
    expect((await app.funding.status(principal)).available).toBe("1023");
    expect((await primary.checkProofsStates(originalProofs)).every((proof) => proof.state === "SPENT")).toBe(true);
    expect(await app.cashu.submit(cashu)).toEqual(credited);
    await expect(app.cashu.submit({ ...cashu, topUpId: "local:cashu:duplicate", idempotencyKey: "duplicate" })).rejects.toThrow("CASHU_PROOF_ALREADY_CLAIMED");
    await expect(app.cashu.submit({ ...cashu, principal: stranger })).rejects.toThrow("CASHU_TOP_UP_NOT_OWNER");
    await expect(app.cashu.submit({ ...cashu, amount: "1025" })).rejects.toThrow("CASHU_WRONG_AMOUNT");

    const secondary = new Wallet(config.secondaryMintUrl);
    await secondary.loadMint();
    const quote = await secondary.createMintQuoteBolt11(256);
    const proofs = await secondary.mintProofsBolt11(256, quote);
    const secondaryToken = getEncodedToken({ mint: config.secondaryMintUrl, unit: "sat", proofs });
    const secondCashu = { ...cashu, topUpId: "local:cashu:2", idempotencyKey: "local:cashu:2", amount: "256", token: app.applicationToken(secondaryToken) };
    expect((await app.cashu.submit(secondCashu)).state).toBe("credited");
    expect((await secondary.checkProofsStates(proofs)).every((proof) => proof.state === "SPENT")).toBe(true);

    const command = lightningCommand("local:lightning:1", "37");
    const invoice = await app.lightning.begin(command);
    expect(invoice.state).toBe("pending");
    expect(await app.lightning.begin(command)).toEqual(invoice);
    await expect(app.lightning.begin({ ...command, amount: "38" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    await expect(app.lightning.observeSettlement({ principal: stranger, topUpId: invoice.topUpId })).rejects.toThrow("LIGHTNING_TOPUP_NOT_FOUND");
    await waitUntil(async () => (await app!.lightning.observeSettlement({ principal, topUpId: invoice.topUpId })).state === "credited", "application NWC credit");
    expect((await app.funding.status(principal)).available).toBe("1315");
    expect((await app.funding.status(stranger)).available).toBe("0");

    const pendingCommand = lightningCommand("local:lightning:restart", "41");
    const pending = await app.lightning.begin(pendingCommand);
    expect(pending.state).toBe("pending");
    const material = await app.database.lightning.transact((state) => state.topUps.get(pending.topUpId)!);
    const decryptedInvoice = await app.vault.open({ id: material.protectedMaterialId!, accountId: material.accountId, topUpId: pending.topUpId, rail: "lightning" });
    expect(new TextDecoder().decode(decryptedInvoice).startsWith("lnbc")).toBe(true);
    const sealed = await app.pool.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM protected_rail_material WHERE material_id=$1", [material.protectedMaterialId]);
    expect(Buffer.from(sealed.rows[0].ciphertext).includes(Buffer.from(decryptedInvoice))).toBe(false);
    decryptedInvoice.fill(0);

    // Close all application connections and stop the containers, preserving only
    // persisted volumes and private local config. New objects cannot use caches.
    await app.close(); app = undefined;
    await stack.down();
    const restarted = await stack.up();
    expect(restarted.fundingKey === config.fundingKey).toBe(true);
    app = await createDevelopmentFunding(restarted);
    expect((await app.funding.status(principal)).available).toBe("1315");
    expect(await app.cashu.submit(cashu)).toEqual(credited);
    expect((await app.cashu.submit(secondCashu)).state).toBe("credited");
    expect((await app.lightning.begin(command)).state).toBe("credited");
    expect((await app.lightning.observeSettlement({ principal, topUpId: invoice.topUpId })).state).toBe("credited");
    expect(await app.lightning.begin(pendingCommand)).toEqual(pending);
    const restoredInvoice = await app.vault.open({ id: material.protectedMaterialId!, accountId: material.accountId, topUpId: pending.topUpId, rail: "lightning" });
    expect(new TextDecoder().decode(restoredInvoice).startsWith("lnbc")).toBe(true);
    restoredInvoice.fill(0);
    await waitUntil(async () => (await app!.lightning.observeSettlement({ principal, topUpId: pending.topUpId })).state === "credited", "restarted application NWC credit");
    expect((await app.funding.status(principal)).available).toBe("1356");
    expect((await app.funding.status(principal)).topUps).toHaveLength(4);
    expect((await app.pool.query("SELECT count(*)::int AS count FROM ledger_transactions")).rows[0].count).toBe(4);
    expect((await app.pool.query("SELECT count(*)::int AS count FROM billing_line_items WHERE kind='credit'")).rows[0].count).toBe(4);
    expect((await app.pool.query("SELECT count(*)::int AS count FROM funding_outbox WHERE event_kind='account_credited'")).rows[0].count).toBe(4);
    expect((await app.pool.query("SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE WHEN direction='credit' THEN amount ELSE -amount END) <> 0")).rows).toHaveLength(0);
    // Each settled Cashu top-up retains only its encrypted service-owned
    // treasury proofs; original bearer and blinded-output material is expired.
    expect((await app.pool.query("SELECT count(*)::int AS count FROM protected_rail_material WHERE expired_at IS NULL")).rows[0].count).toBe(2);
  } finally {
    try { await app?.close(); } finally { await stack.down(true); }
  }
}, 300_000);
