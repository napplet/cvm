import { type ReleaseProviderId, type ReleaseProviderPort, type ReleaseProviderRegistry } from "./contracts";
import { RELEASE_PROVIDER_IDS } from "./topology";

const DIGEST = /^[a-f0-9]{64}$/iu;
const ZERO_DIGEST = "0".repeat(64);
const LOCATOR_ENVIRONMENT_NAMES = ["PATH", "HOME", "XDG_CONFIG_HOME", "CLOUDSDK_CONFIG", "MODAL_PROFILE", "FLY_CONFIG_DIR"] as const;

type NativeProbeSpec = Readonly<{
  provider: ReleaseProviderId;
  command: readonly string[];
  secretReferenceNames: readonly string[];
}>;

export type NativeReleaseDiscoveryProbeResult =
  | Readonly<{ status: "authorized"; accountScopeSha256: string }>
  | Readonly<{ status: "not_configured" }>
  | Readonly<{ status: "unavailable" }>;

export type NativeReleaseDiscoveryProbe = (input: NativeProbeSpec) => Promise<NativeReleaseDiscoveryProbeResult>;

/** The native child receives locations of user-owned CLI config only. It never
 * inherits bearer/token or credential-material environment variables. */
export function nativeDiscoveryLocatorEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return Object.fromEntries(LOCATOR_ENVIRONMENT_NAMES.flatMap((name) => env[name] ? [[name, env[name]!]] : []));
}

function redactedScopeScript(binary: "modal" | "flyctl", command: string): readonly string[] {
  const script = `
if ! command -v ${binary} >/dev/null 2>&1; then printf 'unavailable\\n'; exit 0; fi
value="$(${command} 2>/dev/null)" || { printf 'not_configured\\n'; exit 0; }
if [ -z "$value" ]; then printf 'not_configured\\n'; exit 0; fi
printf 'authorized '
printf '%s' "$value" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | awk '{print $1}'
`;
  return ["sh", "-c", script];
}

function redactedGcloudScopeScript(): readonly string[] {
  const script = `
if ! command -v gcloud >/dev/null 2>&1; then printf 'unavailable\\n'; exit 0; fi
account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" || { printf 'not_configured\\n'; exit 0; }
project="$(gcloud config get-value project 2>/dev/null)" || { printf 'not_configured\\n'; exit 0; }
gcloud auth application-default print-access-token >/dev/null 2>&1 || { printf 'not_configured\\n'; exit 0; }
if [ -z "$account" ] || [ -z "$project" ]; then printf 'not_configured\\n'; exit 0; fi
printf 'authorized '
printf 'account=%s\\nproject=%s\\n' "$account" "$project" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | awk '{print $1}'
`;
  return ["sh", "-c", script];
}

const NATIVE_PROBES: Readonly<Partial<Record<ReleaseProviderId, NativeProbeSpec>>> = Object.freeze({
  cloud_run: { provider: "cloud_run", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"] },
  gcs: { provider: "gcs", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"] },
  collector: { provider: "collector", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"] },
  cloud_sql_postgres: { provider: "cloud_sql_postgres", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"] },
  modal: { provider: "modal", command: redactedScopeScript("modal", "modal profile current"), secretReferenceNames: ["modal-profile"] },
  fly: { provider: "fly", command: redactedScopeScript("flyctl", "flyctl auth whoami"), secretReferenceNames: ["flyctl-auth"] },
});

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runReadOnlyNativeProbe(input: NativeProbeSpec): Promise<NativeReleaseDiscoveryProbeResult> {
  try {
    const child = Bun.spawn([...input.command], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: nativeDiscoveryLocatorEnvironment() });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (exitCode !== 0) return { status: "unavailable" };
    const output = stdout.trim();
    const match = /^authorized ([a-f0-9]{64})$/iu.exec(output);
    if (match) return { status: "authorized", accountScopeSha256: match[1]!.toLowerCase() };
    return { status: output === "not_configured" ? "not_configured" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

function unimplemented(provider: ReleaseProviderId): ReleaseProviderPort {
  return {
    discover: async () => ({
      capability: "unsupported",
      authentication: "unavailable",
      accountScopeSha256: ZERO_DIGEST,
      costEstimateSha256: ZERO_DIGEST,
      secretReferenceNames: [],
      reasonCode: "UNSUPPORTED_CAPABILITY",
    }),
  };
}

function portFor(spec: NativeProbeSpec, run: NativeReleaseDiscoveryProbe): ReleaseProviderPort {
  return {
    discover: async () => {
      const result = await run(spec);
      if (result.status === "unavailable") {
        return { capability: "unavailable", authentication: "unavailable", accountScopeSha256: ZERO_DIGEST, costEstimateSha256: ZERO_DIGEST, secretReferenceNames: [], reasonCode: "CAPABILITY_UNAVAILABLE" };
      }
      if (result.status === "not_configured") {
        return { capability: "available", authentication: "not_configured", accountScopeSha256: ZERO_DIGEST, costEstimateSha256: ZERO_DIGEST, secretReferenceNames: [], reasonCode: "AUTHORIZATION_REQUIRED" };
      }
      if (!DIGEST.test(result.accountScopeSha256)) throw new Error("RELEASE_PROVIDER_DISCOVERY_METADATA_INVALID");
      return {
        capability: "available",
        authentication: "authorized",
        accountScopeSha256: result.accountScopeSha256.toLowerCase(),
        costEstimateSha256: await sha256({ version: 1, provider: spec.provider, purpose: "controller-owned-authorization-cost-plan" }),
        secretReferenceNames: [...spec.secretReferenceNames],
        reasonCode: "AVAILABLE",
      };
    },
  };
}

/**
 * Produces the product-owned, read-only discovery registry. The only native
 * command output admitted into TypeScript is an authentication status and a
 * SHA-256 digest; account identifiers and tokens never cross this boundary.
 * Provider families without an approved native port are explicit unsupported
 * facts, so this preflight cannot be confused with a live executor.
 */
export function createNativeReleaseDiscoveryRegistry(input: Readonly<{ run?: NativeReleaseDiscoveryProbe }> = {}): ReleaseProviderRegistry {
  const run = input.run ?? runReadOnlyNativeProbe;
  return Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, NATIVE_PROBES[provider] ? portFor(NATIVE_PROBES[provider]!, run) : unimplemented(provider)])) as ReleaseProviderRegistry;
}
