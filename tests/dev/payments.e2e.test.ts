import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { Wallet, getDecodedToken } from "@cashu/cashu-ts";
import { developmentStack, nwcRequest, waitUntil } from "../../scripts/dev-payments";

// Opt in: the ordinary unit suite never starts Docker or makes payment calls.
const e2e = process.env.NAPPLET_CVM_DEV_PAYMENTS_E2E === "1" ? test : test.skip;
e2e("local Cashu mint and NWC wallet bootstrap, transact, restart, and clean up", async () => {
  const stack = developmentStack(true);
  try {
    const config = await stack.up();
    expect(config.developmentOnly).toBe(true);
    expect((await stat(`${stack.directory}/payments.json`)).mode & 0o777).toBe(0o600);
    const wallet = new Wallet(config.mintUrl);
    await wallet.loadMint();
    const keysets = await wallet.mint.getKeySets();
    const inputProofs = getDecodedToken(config.cashuToken, keysets.keysets.map((keyset) => keyset.id)).proofs;
    const fee = Number(wallet.getFeesForProofs(inputProofs));
    const received = await wallet.receive(config.cashuToken);
    expect(received.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(1024 - fee);
    expect((await wallet.checkProofsStates(inputProofs)).every((proof) => proof.state === "SPENT")).toBe(true);
    await expect(wallet.receive(config.cashuToken)).rejects.toThrow();

    const info = await nwcRequest(config.nwcUri, "get_info");
    expect(info.methods).toContain("pay_invoice");
    const before = (await nwcRequest(config.nwcUri, "get_balance")).balance;
    expect(before).toBeGreaterThanOrEqual(1_000_000);
    const incoming = await nwcRequest(config.nwcUri, "make_invoice", { amount: 32_000, description: "e2e funding" });
    expect(incoming.invoice).toMatch(/^lnbc/);
    await waitUntil(async () => !!(await nwcRequest(config.nwcUri, "lookup_invoice", { payment_hash: incoming.payment_hash })).settled_at, "incoming NWC settlement");
    await waitUntil(async () => (await nwcRequest(config.nwcUri, "get_balance")).balance === before + 32_000, "credited NWC balance");

    const invoice = await stack.externalTestInvoice();
    const paid = await nwcRequest(config.nwcUri, "pay_invoice", { invoice });
    expect(paid.preimage).toMatch(/^[0-9a-f]{64}$/);
    const after = (await nwcRequest(config.nwcUri, "get_balance")).balance;
    expect(after).toBeLessThan(before + 32_000);
    // Replaying an already-paid invoice must not debit the wallet twice.
    try { await nwcRequest(config.nwcUri, "pay_invoice", { invoice }); } catch { /* already paid is valid */ }
    expect((await nwcRequest(config.nwcUri, "get_balance")).balance).toBe(after);
    await stack.down();
    const restarted = await stack.up();
    expect(new URL(restarted.nwcUri).hostname).toBe(new URL(config.nwcUri).hostname);
    expect(new URL(restarted.nwcUri).searchParams.get("secret")).toBe(new URL(config.nwcUri).searchParams.get("secret"));
    expect((await nwcRequest(restarted.nwcUri, "get_balance")).balance).toBe(after);
  } finally {
    await stack.down(true);
  }
}, 300_000);
