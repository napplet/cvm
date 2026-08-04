import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionAction } from "../../src/domain/session-action";
import { SqliteSessionStore } from "../../src/persistence/sqlite-session-store";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const action = (overrides: Partial<SessionAction> = {}): SessionAction => ({
  principal: { id: "principal-a" }, sessionId: "session-a", actionId: "action-a", kind: "design", idempotencyKey: "key-a", expectedVersion: 0,
  policyVersion: "phase-02-policy-2026-08-04", payload: { idea: "a focused napplet" }, ...overrides,
});

function open(): { store: SqliteSessionStore; path: string } {
  const directory = mkdtempSync("/tmp/napplet-cvm-session-store-");
  temporaryDirectories.push(directory);
  const path = join(directory, "sessions.sqlite");
  const store = new SqliteSessionStore(path);
  store.createSession({ sessionId: "session-a", principalId: "principal-a", version: 0 });
  return { store, path };
}

describe("SqliteSessionStore", () => {
  test("survives close/reopen with exact replay and one evidence identity", async () => {
    const { store, path } = open();
    const first = await store.apply(action(), () => undefined);
    const evidence = store.evidence;
    store.close();

    const reopened = new SqliteSessionStore(path);
    const replay = await reopened.apply(action(), () => { throw new Error("must not evaluate replay"); });
    expect(replay).toEqual(first);
    expect(reopened.getSessionVersion("session-a")).toBe(1);
    expect(reopened.evidence).toEqual(evidence);
    reopened.close();
  });

  test("rolls back all durable rows on an injected evaluation failure and proves it after reopen", async () => {
    const { store, path } = open();
    await expect(store.apply(action(), () => { throw new Error("injected"); })).rejects.toThrow("injected");
    store.close();
    const reopened = new SqliteSessionStore(path);
    expect(reopened.getSessionVersion("session-a")).toBe(0);
    expect(reopened.evidence).toEqual([]);
    reopened.close();
  });

  test("serializes competing keys and exact duplicates in the file-backed authority", async () => {
    const { store } = open();
    const [left, right] = await Promise.all([
      store.apply(action({ idempotencyKey: "left" }), () => undefined),
      store.apply(action({ idempotencyKey: "right" }), () => undefined),
    ]);
    expect([left.code, right.code].sort()).toEqual(["ACTION_COMMITTED", "STALE_SESSION_VERSION"]);

    const duplicate = open().store;
    const [one, two] = await Promise.all([duplicate.apply(action(), () => undefined), duplicate.apply(action(), () => undefined)]);
    expect(one).toEqual(two);
    expect(duplicate.evidence).toHaveLength(1);
    store.close();
    duplicate.close();
  });
});
