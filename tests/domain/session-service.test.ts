import { describe, expect, test } from "bun:test";
import type { SessionAction } from "../../src/domain/session-action";
import { SessionService } from "../../src/domain/session-service";
import { TransactionalMemorySessionStore } from "../../src/persistence/session-store";

const action = (overrides: Partial<SessionAction> = {}): SessionAction => ({
  principal: { id: "principal-a" }, sessionId: "session-a", actionId: "action-a", kind: "design", idempotencyKey: "key-a", expectedVersion: 0,
  policyVersion: "phase-02-policy-2026-08-04", payload: { idea: "a focused napplet" }, ...overrides,
});

function service(): { service: SessionService; store: TransactionalMemorySessionStore } {
  const store = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
  return { service: new SessionService(store), store };
}

describe("SessionService", () => {
  test("returns recoverable ACTION_INTERRUPTED before evaluation without committing state", async () => {
    const { service, store } = service();
    const controller = new AbortController();
    controller.abort();

    await expect(service.apply(action(), controller.signal)).resolves.toMatchObject({ status: "recoverable_failure", code: "ACTION_INTERRUPTED" });
    expect(store.getSessionVersion("session-a")).toBe(0);
    expect(store.evidence).toEqual([]);
  });

  test("recovers an ambiguous response loss through exact durable replay", async () => {
    const { service, store } = service();
    const committed = await service.apply(action());
    const replay = await service.apply(action());

    expect(committed).toEqual(replay);
    expect(store.getSessionVersion("session-a")).toBe(1);
    expect(store.evidence).toHaveLength(1);
  });

  test("exposes only a stable stale code and current version without automatic mutation retry", async () => {
    const { service, store } = service();
    await service.apply(action());
    const stale = await service.apply(action({ idempotencyKey: "new-key", expectedVersion: 0 }));

    expect(stale).toEqual({ status: "denied", code: "STALE_SESSION_VERSION", currentVersion: 1 });
    expect(store.getSessionVersion("session-a")).toBe(1);
  });

  test("converges exact duplicate callers and admits only one competing next state", async () => {
    const exact = service();
    const [first, second] = await Promise.all([exact.service.apply(action()), exact.service.apply(action())]);
    expect(first).toEqual(second);

    const competing = service();
    const [left, right] = await Promise.all([
      competing.service.apply(action({ idempotencyKey: "left" })),
      competing.service.apply(action({ idempotencyKey: "right" })),
    ]);
    expect([left.code, right.code].sort()).toEqual(["ACTION_COMMITTED", "STALE_SESSION_VERSION"]);
  });
});
