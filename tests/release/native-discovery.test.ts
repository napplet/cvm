import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNativeReleaseDiscoveryRegistry, nativeDiscoveryLocatorEnvironment } from "../../src/release/native-discovery";
import { ReleaseCertificationController } from "../../src/release/controller";
import { RELEASE_PROVIDER_IDS } from "../../src/release/topology";

const digest = (letter: string) => letter.repeat(64);

test("controller-owned native discovery retains finite auth hashes and references without native output", async () => {
  const commands: string[] = [];
  const registry = createNativeReleaseDiscoveryRegistry({
    candidateSha256: digest("c"),
    run: async ({ provider, command }) => {
      commands.push(`${provider}:${command[0]}`);
      return provider === "modal"
        ? { status: "authorized", accountScopeSha256: digest("a") }
        : { status: "not_configured" };
    },
  });

  const modal = await registry.modal!.discover();
  expect(modal).toEqual(expect.objectContaining({
    capability: "available",
    authentication: "authorized",
    accountScopeSha256: digest("a"),
    costEstimateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    secretReferenceNames: ["modal-profile"],
    reasonCode: "AVAILABLE",
  }));
  expect(modal.costEstimateSha256).not.toBe(digest("0"));
  expect(JSON.stringify(modal)).not.toContain("modal-account-canary");
  expect(commands).toEqual(["modal:sh"]);
});

test("gcloud discovery binds active account and selected project while discarding the ADC token", async () => {
  let command = "";
  const registry = createNativeReleaseDiscoveryRegistry({
    candidateSha256: digest("c"),
    run: async ({ provider, command: probeCommand }) => {
      if (provider === "cloud_run") command = probeCommand.join(" ");
      return { status: "authorized", accountScopeSha256: digest("b") };
    },
  });

  const discovery = await registry.cloud_run!.discover();
  expect(discovery).toEqual(expect.objectContaining({ authentication: "authorized", accountScopeSha256: digest("b"), secretReferenceNames: ["gcloud-adc"] }));
  expect(command).toContain("gcloud config get-value project");
  expect(command).toContain("gcloud auth application-default print-access-token >/dev/null 2>&1");
  expect(command).toContain("account=%s");
  expect(command).toContain("project=%s");
});

test("authorized Google, Modal, and Fly probes retain their observed redacted account hashes", async () => {
  const accountScopes = {
    cloud_run: digest("a"),
    gcs: digest("b"),
    collector: digest("c"),
    cloud_sql_postgres: digest("d"),
    modal: digest("e"),
    fly: digest("f"),
  } as const;
  const registry = createNativeReleaseDiscoveryRegistry({
    candidateSha256: digest("9"),
    run: async ({ provider }) => ({ status: "authorized", accountScopeSha256: accountScopes[provider as keyof typeof accountScopes] }),
  });

  for (const [provider, expectedScope] of Object.entries(accountScopes)) {
    await expect(registry[provider as keyof typeof registry]!.discover()).resolves.toMatchObject({
      authentication: "authorized",
      accountScopeSha256: expectedScope,
      reasonCode: "AVAILABLE",
    });
  }
});

test("native discovery preserves CLI configuration locators while excluding token and credential environment variables", () => {
  const environment = nativeDiscoveryLocatorEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    XDG_CONFIG_HOME: "/safe/xdg",
    CLOUDSDK_CONFIG: "/safe/gcloud",
    MODAL_PROFILE: "operator",
    FLY_CONFIG_DIR: "/safe/fly",
    FLY_API_TOKEN: "fly-token-canary",
    GOOGLE_APPLICATION_CREDENTIALS: "/unsafe/credential.json",
    GOOGLE_OAUTH_ACCESS_TOKEN: "google-token-canary",
    MODAL_TOKEN_ID: "modal-id-canary",
    MODAL_TOKEN_SECRET: "modal-token-canary",
  });

  expect(environment).toEqual({ PATH: "/safe/bin", HOME: "/safe/home", XDG_CONFIG_HOME: "/safe/xdg", CLOUDSDK_CONFIG: "/safe/gcloud", MODAL_PROFILE: "operator", FLY_CONFIG_DIR: "/safe/fly" });
  expect(JSON.stringify(environment)).not.toContain("canary");
  expect(environment).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
});

test("every implemented family has candidate-bound finite discovery metadata without a provider effect", async () => {
  const commands: string[] = [];
  const registry = createNativeReleaseDiscoveryRegistry({
    candidateSha256: digest("c"),
    run: async ({ provider }) => {
      commands.push(provider);
      return provider === "modal"
        ? { status: "authorized", accountScopeSha256: digest("a") }
        : { status: "not_configured" };
    },
  });

  const discoveries = await Promise.all(RELEASE_PROVIDER_IDS.map(async (provider) => [provider, await registry[provider]!.discover()] as const));
  expect(commands.sort()).toEqual(["cloud_run", "cloud_sql_postgres", "collector", "fly", "gcs", "modal"]);
  for (const [provider, discovery] of discoveries) {
    expect(discovery).not.toHaveProperty("provider");
    expect(discovery.capability).not.toBe("unsupported");
    expect(discovery.reasonCode).not.toBe("UNSUPPORTED_CAPABILITY");
    expect(discovery.accountScopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(discovery.accountScopeSha256).not.toBe(digest("0"));
    expect(discovery.costEstimateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(discovery.costEstimateSha256).not.toBe(digest("0"));
    expect(JSON.stringify(discovery)).not.toContain(`${provider}-account-canary`);
  }

  const byProvider = Object.fromEntries(discoveries);
  expect(byProvider.modal).toEqual(expect.objectContaining({
    capability: "available",
    authentication: "authorized",
    accountScopeSha256: digest("a"),
    reasonCode: "AVAILABLE",
  }));
  expect(byProvider.promoted_cli).toEqual(expect.objectContaining({
    capability: "available",
    authentication: "authorized",
    reasonCode: "AVAILABLE",
  }));
  for (const provider of ["contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "upload", "owner_relay", "attestation_relay"] as const) {
    expect(byProvider[provider]).toEqual(expect.objectContaining({
      capability: "available",
      authentication: "not_configured",
      reasonCode: "AUTHORIZATION_REQUIRED",
    }));
  }

  const differentCandidate = createNativeReleaseDiscoveryRegistry({
    candidateSha256: digest("d"),
    run: async ({ provider }) => provider === "modal"
      ? { status: "authorized", accountScopeSha256: digest("a") }
      : { status: "not_configured" },
  });
  const [changedContextVm, changedModal] = await Promise.all([
    differentCandidate.contextvm!.discover(),
    differentCandidate.modal!.discover(),
  ]);
  expect(changedContextVm.accountScopeSha256).not.toBe(byProvider.contextvm.accountScopeSha256);
  expect(changedContextVm.costEstimateSha256).not.toBe(byProvider.contextvm.costEstimateSha256);
  expect(changedModal.accountScopeSha256).toBe(byProvider.modal.accountScopeSha256);
  expect(changedModal.costEstimateSha256).not.toBe(byProvider.modal.costEstimateSha256);
});

test("candidate-bound discovery changes regenerate the authorization request", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-native-discovery-"));
  const candidatePath = join(workspace, "candidate.json");
  try {
    await writeFile(candidatePath, JSON.stringify({ schemaVersion: 1, status: "review_ready", sourceRevision: "a".repeat(40) }));
    const candidateSha256 = digest("c");
    const initial = await new ReleaseCertificationController({
      candidatePath,
      workspace,
      now: () => 1_000,
      providers: createNativeReleaseDiscoveryRegistry({
        candidateSha256,
        run: async () => ({ status: "not_configured" }),
      }),
    }).dryRun();
    const changed = await new ReleaseCertificationController({
      candidatePath,
      workspace,
      now: () => 1_001,
      providers: createNativeReleaseDiscoveryRegistry({
        candidateSha256,
        run: async ({ provider }) => provider === "modal"
          ? { status: "authorized", accountScopeSha256: digest("a") }
          : { status: "not_configured" },
      }),
    }).dryRun();

    expect(changed.authorizationRequest.authorizationRequestSha256).not.toBe(initial.authorizationRequest.authorizationRequestSha256);
    expect(changed.authorizationRequest.supersedesAuthorizationRequestSha256).toBe(initial.authorizationRequest.authorizationRequestSha256);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
