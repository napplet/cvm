import { expect, test } from "bun:test";

import { createLocalOperatorFundingSetup } from "../../src/release/deployment/local-setup";

const digest = (letter: string) => letter.repeat(64);

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
        return { close: async () => {} };
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
  await expect(submit!({ state: seen[0]!.state, csrf: seen[0]!.csrf, rail: "cashu", material: "chat-shaped-secret" })).rejects.toThrow("LOCAL_FUNDING_MATERIAL_REJECTED");
  await submit!({ state: seen[0]!.state, csrf: seen[0]!.csrf, rail: "cashu", material: new Uint8Array([3, 4]) });
  const readiness = await setup.readiness();
  expect(readiness.status).toBe("ready");
  expect(JSON.stringify(readiness)).not.toContain("1,2");
  expect(JSON.stringify(persisted)).not.toContain("1,2");
});
