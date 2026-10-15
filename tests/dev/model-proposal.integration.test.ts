import { expect, test } from "bun:test";
import { createDevelopmentFunding } from "../../scripts/dev-funding";
import type { DevPayments } from "../../scripts/dev-payments";
import { DeterministicModelGateway } from "../../src/model/deterministic-model-gateway";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";

const intent = (overrides: Record<string, unknown> = {}) => ({
  operationId: "operation:proposal-e2e", providerRequestId: "operation:proposal-e2e", accountId: "account:proposal-e2e", sessionId: "session:proposal-e2e", actionId: "start:proposal-e2e", expectedVersion: 0,
  actionBudgetReference: "budget:proposal-e2e", profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04", requestFingerprint: "a".repeat(64), prompt: "Build a focused counter.",
  maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "1000" }], selection: "unselected" as const, ...overrides,
});

test("deterministic proposal SQL dispatch lookup restart replay", async () => {
  let app: Awaited<ReturnType<typeof createDevelopmentFunding>> | undefined;
  try {
    const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
    app = await createDevelopmentFunding(config);
    const store = new SourceProposalStore(app.pool);
    const first = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: store });
    const dispatched = await first.dispatch(intent(), new AbortController().signal);
    expect(dispatched).toMatchObject({ status: "completed", sourceProposalReference: expect.stringMatching(/^proposal:sha256:/u) });
    if (dispatched.status !== "completed" || !dispatched.sourceProposalReference) throw new Error("proposal missing");
    const persisted = await store.lookup({ intent: intent() });
    expect(persisted?.proposal.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted?.proposal.files.map((file) => file.path)).toEqual(["src/main.ts", "src/styles.css", "src/domain-availability.js"]);
    expect(persisted?.proposal.files[0]?.content).toContain('runtimeHasDomain');
    expect(await store.lookup({ intent: intent({ accountId: "account:other" }), reference: dispatched.sourceProposalReference })).toBeUndefined();
    expect(await store.lookup({ intent: intent({ authorizedPriorArtifactReference: "artifact:wrong" }), reference: dispatched.sourceProposalReference })).toBeUndefined();
    await app.close(); app = undefined;
    app = await createDevelopmentFunding(config);
    const restarted = new DeterministicModelGateway({ scenario: { dispatch: "completed", lookup: "receipt_found" }, proposalStore: new SourceProposalStore(app.pool) });
    const lookedUp = await restarted.lookup(intent(), new AbortController().signal);
    expect(lookedUp).toMatchObject({ status: "receipt_found", sourceProposalReference: dispatched.sourceProposalReference });
    const replay = await restarted.dispatch(intent(), new AbortController().signal);
    expect(replay).toMatchObject({ status: "completed", sourceProposalReference: dispatched.sourceProposalReference });
    const rows = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM source_proposals WHERE operation_id=$1", ["operation:proposal-e2e"]);
    expect(rows.rows[0]?.count).toBe(1);
  } finally { await app?.close(); }
}, 300_000);
