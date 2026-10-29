import { expect, test } from "bun:test";
import type { OperatorFundingReadiness } from "../../src/release/deployment/operator-funding";

import { createLocalOperatorFundingSetup } from "../../src/release/deployment/local-setup";
import { ReleaseCertificationController } from "../../src/release/controller";
import { RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const digest = (letter: string) => letter.repeat(64);

test("Cashu-only local setup completes and closes its session without NWC or secret persistence", async () => {
  let session: Parameters<import("../../src/release/deployment/local-setup").LocalFundingLoopbackPort["listen"]>[0];
  let closed = 0;
  const persisted: unknown[] = [];
  const setup = await createLocalOperatorFundingSetup({
    candidateSha256: digest("a"), now: () => 1_000,
    loopback: { listen: async (input) => { session = input; return { url: `http://127.0.0.1:43210/napplet-cvm/funding-setup?state=${input.state}`, close: async () => { closed += 1; } }; } },
    browser: { open: async () => {} },
    secrets: { store: async () => ({ secretReference: "os-secret-ref:release-cashu-01", capabilitySha256: digest("c"), accountScopeSha256: digest("d") }) },
    readinessStore: { write: async (value) => { persisted.push(value); } },
  });
  await setup.launch();
  await session!.submit({ state: session!.state, csrf: session!.csrf, rail: "cashu", material: new TextEncoder().encode("test-wallet-canary") });
  expect(await setup.readiness()).toMatchObject({ status: "ready", rails: [{ rail: "cashu", status: "ready" }] });
  expect(persisted.at(-1)).toMatchObject({ status: "ready", rails: [{ rail: "cashu" }] });
  expect(JSON.stringify(persisted)).not.toContain("test-wallet-canary");
  expect(closed).toBe(1);
  await expect(session!.submit({ state: session!.state, csrf: session!.csrf, rail: "cashu", material: new Uint8Array([1]) })).rejects.toThrow("LOCAL_FUNDING_SESSION_REJECTED");
});

test("local funding setup binds a one-time loopback session and keeps both wallet materials out of its persisted readiness", async () => {
  const seen: Array<Readonly<{ host: string; state: string; csrf: string }>> = [];
  const launches: string[] = [];
  const persisted: unknown[] = [];
  let submit: ((input: unknown) => Promise<void>) | undefined;
  const setup = await createLocalOperatorFundingSetup({
    candidateSha256: digest("a"),
    authorizationRequestSha256: digest("b"),
    now: () => 1_000,
    expiresInMs: 60_000,
    loopback: {
      listen: async (input) => {
        seen.push({ host: input.host, state: input.state, csrf: input.csrf });
        submit = input.submit;
        return { url: `http://127.0.0.1:43210/napplet-cvm/funding-setup?state=${input.state}`, close: async () => {} };
      },
    },
    browser: { open: async (url) => { launches.push(url); } },
    secrets: {
      store: async (input) => ({
        secretReference: `os-secret-ref:release-${input.rail}-01`,
        capabilitySha256: digest(input.rail === "cashu" ? "c" : "d"),
        accountScopeSha256: digest(input.rail === "cashu" ? "e" : "f"),
      }),
    },
    readinessStore: { write: async (value) => { persisted.push(value); } },
  });

  expect(setup.descriptor()).toMatchObject({ kind: "local_operator_funding_setup", status: "action_required", plan: "07-20" });
  expect(launches).toEqual([]);
  await setup.launch();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.host).toBe("127.0.0.1");
  expect(launches).toHaveLength(1);

  await submit!({ state: seen[0]!.state, csrf: seen[0]!.csrf, rail: "nwc_lightning", material: new Uint8Array([1, 2]) });
  expect((await setup.readiness()).status).toBe("pending");
  await expect(submit!({ state: seen[0]!.state, csrf: seen[0]!.csrf, rail: "cashu", material: "chat-shaped-secret" })).rejects.toThrow("LOCAL_FUNDING_MATERIAL_REJECTED");
  await submit!({ state: seen[0]!.state, csrf: seen[0]!.csrf, rail: "cashu", material: new Uint8Array([3, 4]) });
  const readiness = await setup.readiness();
  expect(readiness.status).toBe("ready");
  expect(JSON.stringify(readiness)).not.toContain("1,2");
  expect(JSON.stringify(persisted)).not.toContain("1,2");
});

test("a current request binds both opaque rail records and supersedes when funding readiness drifts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-request-composition-"));
  const candidatePath = join(import.meta.dir, "..", "..", "toolchains", "candidates", "initial.json");
  const catalog = { listPriceFacts: async () => RELEASE_COST_FAMILIES.map((provider, index) => ({
    provider, sourceId: `${provider}-official`, sourceDocumentSha256: digest((index % 16).toString(16)), quoteSha256: digest(((index + 1) % 16).toString(16)),
    currency: "USD" as const, unit: "operation", priceMicros: index + 1, observedAtMs: 1_000, freshUntilMs: 60_000, status: "available" as const,
  })) };
  const funding = await (async () => {
    const values: OperatorFundingReadiness[] = [];
    let submit: ((input: unknown) => Promise<void>) | undefined;
    let state = "";
    let csrf = "";
    const setup = await createLocalOperatorFundingSetup({
      candidateSha256: digest("a"), authorizationRequestSha256: digest("b"), now: () => 1_000, expiresInMs: 60_000,
      loopback: { listen: async (input) => { submit = input.submit; state = input.state; csrf = input.csrf; return { url: `http://127.0.0.1:43211/napplet-cvm/funding-setup?state=${input.state}`, close: async () => {} }; } },
      browser: { open: async () => {} },
      secrets: { store: async (input) => ({ secretReference: `os-secret-ref:release-${input.rail}-02`, capabilitySha256: digest(input.rail === "cashu" ? "c" : "d"), accountScopeSha256: digest(input.rail === "cashu" ? "e" : "f") }) },
      readinessStore: { write: async (value) => { values.push(value); } },
    });
    await setup.launch();
    await submit!({ state, csrf, rail: "nwc_lightning", material: new Uint8Array([5]) });
    await submit!({ state, csrf, rail: "cashu", material: new Uint8Array([6]) });
    const readiness = values.at(-1);
    if (!readiness) throw new Error("FUNDING_READINESS_FIXTURE_MISSING");
    return readiness;
  })();
  try {
    const result = await new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_000, costCatalog: catalog, requireCurrentPriceCatalog: true, operatorFundingReadiness: funding }).dryRun();
    expect(result.authorizationRequest.priceLines).toHaveLength(16);
    expect(result.authorizationRequest.operatorFundingReadiness).toMatchObject({ status: "ready", rails: [{ rail: "nwc_lightning" }, { rail: "cashu" }] });
    const changed = { ...funding, rails: funding.rails.map((rail) => ({ ...rail })) };
    changed.rails[1]!.capabilitySha256 = digest("9");
    await expect(new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_001, costCatalog: catalog, requireCurrentPriceCatalog: true, operatorFundingReadiness: changed }).dryRun()).rejects.toThrow("OPERATOR_FUNDING_READINESS_INVALID");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
