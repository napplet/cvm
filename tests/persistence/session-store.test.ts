import { describe, expect, test } from "bun:test";
import { fingerprintSessionAction, type SessionAction } from "../../src/domain/session-action";
import { TransactionalMemorySessionStore } from "../../src/persistence/session-store";

const action = (overrides: Partial<SessionAction> = {}): SessionAction => ({
  principal: { id: "principal-a" },
  sessionId: "session-a",
  actionId: "action-a",
  kind: "design",
  idempotencyKey: "key-a",
  expectedVersion: 0,
  policyVersion: "phase-02-policy-2026-08-04",
  payload: { idea: "a focused napplet" },
  ...overrides,
});

describe("TransactionalMemorySessionStore", () => {
  test("canonically fingerprints the complete D-20 action identity", async () => {
    await expect(fingerprintSessionAction(action())).resolves.toBe(
      await fingerprintSessionAction(action({ payload: { idea: "a focused napplet" } })),
    );
    await expect(fingerprintSessionAction(action({ expectedVersion: 1 }))).resolves.not.toBe(await fingerprintSessionAction(action()));
  });

  test("commits once and replays the frozen result without evaluating twice", async () => {
    const store = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
    let evaluations = 0;
    const first = await store.apply(action(), () => { evaluations += 1; });
    const replay = await store.apply(action(), () => { evaluations += 1; });

    expect(first).toEqual(replay);
    expect(evaluations).toBe(1);
    expect(store.getSessionVersion("session-a")).toBe(1);
    expect(store.evidence).toHaveLength(1);
  });

  test("denies conflicting, missing, scope-mismatched, and stale actions without mutation", async () => {
    const store = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
    await store.apply(action(), () => undefined);
    await expect(store.apply(action({ payload: { idea: "different" } }), () => undefined)).resolves.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(store.apply(action({ sessionId: "missing", idempotencyKey: "missing" }), () => undefined)).resolves.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(store.apply(action({ principal: { id: "principal-ab" }, idempotencyKey: "scope" }), () => undefined)).resolves.toMatchObject({ code: "SESSION_SCOPE_MISMATCH" });
    await expect(store.apply(action({ expectedVersion: 0, idempotencyKey: "stale" }), () => undefined)).resolves.toMatchObject({ code: "STALE_SESSION_VERSION", currentVersion: 1 });
    expect(store.evidence).toHaveLength(1);
  });

  test("serializes simultaneous competing and exact duplicate action calls", async () => {
    const store = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
    const [left, right] = await Promise.all([
      store.apply(action({ idempotencyKey: "left" }), () => undefined),
      store.apply(action({ idempotencyKey: "right" }), () => undefined),
    ]);
    expect([left.code, right.code].sort()).toEqual(["ACTION_COMMITTED", "STALE_SESSION_VERSION"]);

    const duplicateStore = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
    const [one, two] = await Promise.all([duplicateStore.apply(action(), () => undefined), duplicateStore.apply(action(), () => undefined)]);
    expect(one).toEqual(two);
    expect(duplicateStore.evidence).toHaveLength(1);
  });

  test("does not publish a working copy when evaluation throws", async () => {
    const store = new TransactionalMemorySessionStore([{ sessionId: "session-a", principalId: "principal-a", version: 0 }]);
    await expect(store.apply(action(), () => { throw new Error("injected"); })).rejects.toThrow("injected");
    expect(store.getSessionVersion("session-a")).toBe(0);
    expect(store.evidence).toEqual([]);
  });
});
