import { type ReleaseProviderId, type ReleaseProviderPort, type ReleaseProviderRegistry } from "./contracts";
import { RELEASE_PROVIDER_IDS } from "./topology";

const DIGEST = /^[a-f0-9]{64}$/iu;
const LOCATOR_ENVIRONMENT_NAMES = ["PATH", "HOME", "XDG_CONFIG_HOME", "CLOUDSDK_CONFIG", "MODAL_PROFILE", "FLY_CONFIG_DIR"] as const;

type NativeProbeSpec = Readonly<{
  provider: ReleaseProviderId;
  command: readonly string[];
  secretReferenceNames: readonly string[];
  requiredScope: string;
}>;

type NativeDiscoveryProfile = Readonly<{
  provider: ReleaseProviderId;
  requiredScope: string;
  secretReferenceNames: readonly string[];
  authentication: "authorized" | "not_configured";
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
  cloud_run: { provider: "cloud_run", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"], requiredScope: "gcp-control-plane" },
  gcs: { provider: "gcs", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"], requiredScope: "gcp-object-store" },
  collector: { provider: "collector", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"], requiredScope: "gcp-collector" },
  cloud_sql_postgres: { provider: "cloud_sql_postgres", command: redactedGcloudScopeScript(), secretReferenceNames: ["gcloud-adc"], requiredScope: "gcp-cloud-sql" },
  modal: { provider: "modal", command: redactedScopeScript("modal", "modal profile current"), secretReferenceNames: ["modal-profile"], requiredScope: "modal-worker-profile" },
  fly: { provider: "fly", command: redactedScopeScript("flyctl", "flyctl auth whoami"), secretReferenceNames: ["flyctl-auth"], requiredScope: "fly-worker-profile" },
});

/** These profiles describe an implementation's required authorization surface,
 * not an account identity or credential. They keep dry-run discovery complete
 * while the protected executor remains the only place that can inject a real
 * provider session. `promoted_cli` is candidate-local; all other profiles need
 * a later explicit configuration, capability selection, or official consent. */
const CONTROLLER_DISCOVERY_PROFILES: Readonly<Partial<Record<ReleaseProviderId, NativeDiscoveryProfile>>> = Object.freeze({
  contextvm: { provider: "contextvm", requiredScope: "contextvm-relay-profile", secretReferenceNames: ["contextvm-relay-profile"], authentication: "not_configured" },
  cep8_lightning: { provider: "cep8_lightning", requiredScope: "cep8-lightning-receiver-profile", secretReferenceNames: ["cep8-lightning-profile"], authentication: "not_configured" },
  cashu: { provider: "cashu", requiredScope: "cashu-mint-policy-profile", secretReferenceNames: ["cashu-mint-policy"], authentication: "not_configured" },
  model: { provider: "model", requiredScope: "model-provider-profile", secretReferenceNames: ["model-provider-profile"], authentication: "not_configured" },
  compatible_host: { provider: "compatible_host", requiredScope: "compatible-host-profile", secretReferenceNames: ["compatible-host-profile"], authentication: "not_configured" },
  signer: { provider: "signer", requiredScope: "external-signer-consent", secretReferenceNames: ["external-signer-consent"], authentication: "not_configured" },
  promoted_cli: { provider: "promoted_cli", requiredScope: "candidate-promoted-cli", secretReferenceNames: [], authentication: "authorized" },
  upload: { provider: "upload", requiredScope: "sealed-upload-target", secretReferenceNames: ["sealed-upload-target"], authentication: "not_configured" },
  owner_relay: { provider: "owner_relay", requiredScope: "owner-relay-and-signer-consent", secretReferenceNames: ["external-signer-consent", "owner-relay-profile"], authentication: "not_configured" },
  attestation_relay: { provider: "attestation_relay", requiredScope: "attestation-relay-profile", secretReferenceNames: ["attestation-relay-profile"], authentication: "not_configured" },
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

function profileFor(provider: ReleaseProviderId): NativeDiscoveryProfile {
  const probe = NATIVE_PROBES[provider];
  if (probe) return { provider, requiredScope: probe.requiredScope, secretReferenceNames: probe.secretReferenceNames, authentication: "not_configured" };
  const profile = CONTROLLER_DISCOVERY_PROFILES[provider];
  if (!profile) throw new Error("RELEASE_PROVIDER_DISCOVERY_PROFILE_MISSING");
  return profile;
}

async function candidateBoundMetadata(input: Readonly<{ candidateSha256: string; profile: NativeDiscoveryProfile }>): Promise<Readonly<{ accountScopeSha256: string; costEstimateSha256: string }>> {
  if (!DIGEST.test(input.candidateSha256)) throw new Error("RELEASE_PROVIDER_DISCOVERY_METADATA_INVALID");
  return Object.freeze({
    // This is deliberately a required-scope binding, never a claim about an
    // unobserved provider account. A verified probe replaces it with the
    // provider-derived redacted account scope below.
    accountScopeSha256: await sha256({ version: 1, candidateSha256: input.candidateSha256.toLowerCase(), provider: input.profile.provider, requiredScope: input.profile.requiredScope }),
    costEstimateSha256: await sha256({ version: 1, candidateSha256: input.candidateSha256.toLowerCase(), provider: input.profile.provider, costFact: "controller-effect-plan-v1" }),
  });
}

function profilePort(profile: NativeDiscoveryProfile, candidateSha256: string): ReleaseProviderPort {
  return {
    discover: async () => {
      const metadata = await candidateBoundMetadata({ candidateSha256, profile });
      return {
        capability: "available",
        authentication: profile.authentication,
        ...metadata,
        secretReferenceNames: [...profile.secretReferenceNames],
        reasonCode: profile.authentication === "authorized" ? "AVAILABLE" : "AUTHORIZATION_REQUIRED",
      };
    },
  };
}

function portFor(spec: NativeProbeSpec, candidateSha256: string, run: NativeReleaseDiscoveryProbe): ReleaseProviderPort {
  const profile = profileFor(spec.provider);
  return {
    discover: async () => {
      const result = await run(spec);
      const metadata = await candidateBoundMetadata({ candidateSha256, profile });
      if (result.status === "unavailable") {
        return { capability: "unavailable", authentication: "unavailable", ...metadata, secretReferenceNames: [...spec.secretReferenceNames], reasonCode: "CAPABILITY_UNAVAILABLE" };
      }
      if (result.status === "not_configured") {
        return { capability: "available", authentication: "not_configured", ...metadata, secretReferenceNames: [...spec.secretReferenceNames], reasonCode: "AUTHORIZATION_REQUIRED" };
      }
      if (!DIGEST.test(result.accountScopeSha256)) throw new Error("RELEASE_PROVIDER_DISCOVERY_METADATA_INVALID");
      return {
        capability: "available",
        authentication: "authorized",
        accountScopeSha256: result.accountScopeSha256.toLowerCase(),
        costEstimateSha256: metadata.costEstimateSha256,
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
 * Every implemented provider family is represented. An absent official
 * session is an explicit candidate-bound authorization/capability block; it
 * is never conflated with an unsupported product capability.
 */
export function createNativeReleaseDiscoveryRegistry(input: Readonly<{ candidateSha256: string; run?: NativeReleaseDiscoveryProbe }>): ReleaseProviderRegistry {
  if (!DIGEST.test(input.candidateSha256)) throw new Error("RELEASE_PROVIDER_DISCOVERY_METADATA_INVALID");
  const run = input.run ?? runReadOnlyNativeProbe;
  return Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => {
    const probe = NATIVE_PROBES[provider];
    return [provider, probe ? portFor(probe, input.candidateSha256, run) : profilePort(profileFor(provider), input.candidateSha256)];
  })) as ReleaseProviderRegistry;
}
