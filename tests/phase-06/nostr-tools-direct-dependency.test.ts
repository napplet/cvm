import { expect, test } from "bun:test";

test("pins nostr-tools as an exact root dependency and exposes only the pure verification surface", async () => {
  const manifest = JSON.parse(await Bun.file(new URL("../../package.json", import.meta.url)).text()) as { dependencies?: Record<string, string> };
  const lock = Bun.JSONC.parse(await Bun.file(new URL("../../bun.lock", import.meta.url)).text()) as {
    workspaces?: { ""?: { dependencies?: Record<string, string> } };
    packages?: Record<string, unknown>;
  };

  expect(manifest.dependencies?.["nostr-tools"]).toBe("2.24.1");
  expect(lock.workspaces?.[""]?.dependencies?.["nostr-tools"]).toBe("2.24.1");
  expect(lock.packages?.["nostr-tools"]).toEqual(expect.arrayContaining(["nostr-tools@2.24.1"]));

  const pure = await import("nostr-tools/pure");
  expect(typeof pure.serializeEvent).toBe("function");
  expect(typeof pure.getEventHash).toBe("function");
  expect(typeof pure.verifyEvent).toBe("function");
});
