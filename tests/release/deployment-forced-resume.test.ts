import { expect, test } from "bun:test";

import { resumeFinalizationPromotion } from "../../src/release/finalize";

const digest = (letter: string) => letter.repeat(64);

test("forced resume reuses the original promotion identity at every finalization ambiguity boundary", async () => {
  const boundaries = [
    ["after_persist", "pending", 1],
    ["after_effect_timeout", "unknown", 0],
    ["after_delayed_observation", "unknown", 0],
    ["after_duplicate_callback", "promoted", 0],
  ] as const;

  for (const [boundary, status, expectedDispatches] of boundaries) {
    let persisted = 0;
    let dispatched = 0;
    const operationId = `promotion-${digest(boundary)}`;
    const result = await resumeFinalizationPromotion({
      operationId,
      bundleSha256: digest("bundle"),
      authorizationReceiptSha256: digest("receipt"),
      status,
      persist: async (input) => { persisted += 1; expect(input.operationId).toBe(operationId); },
      promote: async (input) => { dispatched += 1; expect(input.operationId).toBe(operationId); return "unknown"; },
    });

    expect(result.operationId).toBe(operationId);
    expect(dispatched).toBe(expectedDispatches);
    expect(persisted).toBe(expectedDispatches);
    expect(result.status).toBe(status === "promoted" ? "promoted" : "blocked");
  }
});
