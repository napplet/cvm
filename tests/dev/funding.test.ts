import { expect, test } from "bun:test";
import { createDevelopmentFunding, DevelopmentNwcReceiver } from "../../scripts/dev-funding";
import { createDevelopmentPool, nwcRequest, type DevPayments } from "../../scripts/dev-payments";

const config: DevPayments = {
  version: 1, developmentOnly: true, mintUrl: "http://127.0.0.1:3338", secondaryMintUrl: "http://127.0.0.1:3339",
  hubUrl: "http://127.0.0.1:8081", relayUrl: "ws://127.0.0.1:7777", nwcUri: "unused", cashuToken: "unused",
  databaseUrl: "postgresql://napplet_dev:development-only@127.0.0.1:55432/napplet_dev", fundingKey: "11".repeat(32),
};

test("development funding rejects external services and duplicate mints before connecting", async () => {
  expect(() => createDevelopmentPool("postgresql://napplet_dev@database.example:5432/napplet_dev")).toThrow("DEV_DATABASE_INVALID");
  await expect(createDevelopmentFunding({ ...config, secondaryMintUrl: "https://mint.example" })).rejects.toThrow("DEV_FUNDING_REQUIRES_LOOPBACK");
  await expect(createDevelopmentFunding({ ...config, secondaryMintUrl: config.mintUrl })).rejects.toThrow("DEV_MINTS_MUST_BE_DISTINCT");
  await expect(nwcRequest(`nostr+walletconnect://${"ab".repeat(32)}?relay=wss://relay.example&secret=${"11".repeat(32)}`, "get_balance")).rejects.toThrow("DEV_NWC_REQUIRES_LOOPBACK");
});

test("an unknown NWC create remains unresolved without creating another invoice", async () => {
  const receiver = new DevelopmentNwcReceiver("unused");
  expect(await receiver.queryInvoice({ topUpId: "lost:create", serviceReference: "invoice-create:lost:create", signal: new AbortController().signal })).toEqual({ status: "unknown", topUpId: "lost:create", serviceReference: "invoice-create:lost:create" });
});

test("NWC requests honor cancellation before opening a relay connection", async () => {
  const uri = `nostr+walletconnect://${"ab".repeat(32)}?relay=ws://127.0.0.1:1&secret=${"11".repeat(32)}`;
  await expect(nwcRequest(uri, "get_balance", {}, AbortSignal.abort(new Error("caller cancelled")))).rejects.toThrow("caller cancelled");
});
