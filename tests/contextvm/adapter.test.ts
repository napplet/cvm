import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/contextvm-phase-03.json";
import { buildContextVmAnnouncement } from "../../src/contextvm/announcement";

describe("ContextVM v1 announcement", () => {
  test("announcement is canonical, truthful, and limited to the two v1 top-up PMIs", () => {
    const first = buildContextVmAnnouncement(fixture.announcement);
    const second = buildContextVmAnnouncement(structuredClone(fixture.announcement));

    expect(first).toEqual(second);
    expect(first.tags).toEqual([
      ["cap", "top_up", "1-1000000", "sat"],
      ["payment_interaction", "explicit_gating"],
      ["payment_interaction", "transparent"],
      ["pmi", "bitcoin-cashu-v4-direct"],
      ["pmi", "bitcoin-lightning-bolt11"],
    ]);
    expect(first.metadata.tools).toEqual([
      { name: "account_status", available: true, planned: false, invocable: true },
      { name: "funded_admission", available: true, planned: false, invocable: true },
      { name: "generation", available: false, planned: true, invocable: false },
      { name: "preview", available: false, planned: true, invocable: false },
      { name: "publication", available: false, planned: true, invocable: false },
      { name: "session", available: false, planned: true, invocable: false },
      { name: "top_up", available: true, planned: false, invocable: true },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/x402|l402|private|secret|invoice|preimage/i);
    expect(first.metadata.generationPrice).toBeUndefined();
  });
});
