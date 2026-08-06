import { expect, test } from "bun:test";

import { RELEASE_LIVE_CONTROLLER_STATES } from "../../src/release/contracts";

test("authorized tracer keeps every versioned live boundary", () => {
  expect(RELEASE_LIVE_CONTROLLER_STATES).toEqual([
    "receipt_valid", "bootstrap", "provisioning", "observing", "materializing",
    "protected_suite_running", "finalizing", "cleaning", "blocked", "completed",
  ]);
});
