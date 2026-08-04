import { describe, expect, test } from "bun:test";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

describe("billing line-item history", () => {
  test("returns a stable explicit empty owner-scoped page", async () => {
    const store = new TransactionalMemoryFundingStore();

    await expect(store.listBillingLineItems("account:empty", { limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
  });
});
