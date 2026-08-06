import { expect, test } from "bun:test";
import { createNativeReleaseDiscoveryRegistry, nativeDiscoveryLocatorEnvironment } from "../../src/release/native-discovery";

const digest = (letter: string) => letter.repeat(64);

test("controller-owned native discovery retains finite auth hashes and references without native output", async () => {
  const commands: string[] = [];
  const registry = createNativeReleaseDiscoveryRegistry({
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

test("unimplemented provider families remain finite and fail closed", async () => {
  const registry = createNativeReleaseDiscoveryRegistry({
    run: async () => ({ status: "unavailable" }),
  });

  await expect(registry.contextvm!.discover()).resolves.toEqual(expect.objectContaining({
    capability: "unsupported",
    authentication: "unavailable",
    accountScopeSha256: digest("0"),
    costEstimateSha256: digest("0"),
    secretReferenceNames: [],
    reasonCode: "UNSUPPORTED_CAPABILITY",
  }));
});
