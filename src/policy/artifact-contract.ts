import { canonicalJson } from "../promotion/schema";

export type UpstreamVerdict = "pass" | "block" | "manual_review";
export type ArtifactContractInput = {
  readonly purpose: { readonly kind: "focused" | "arbitrary-site" | "full-stack"; readonly statements: readonly string[] };
  readonly surface: { readonly hasBackend: boolean; readonly hasSecondPurpose: boolean; readonly serviceWorker: boolean; readonly dynamicAuthority: boolean };
  readonly dependencies: { readonly appOwnedSignerOrRelay: boolean; readonly privateNappletImport: boolean };
  readonly capabilities: { readonly declaredHard: readonly string[]; readonly observedDomains: readonly string[]; readonly optionalIntentPresenceRead: boolean; readonly intentUsedThroughSdk: boolean };
  readonly upstream: { readonly scanner: { readonly verdict: UpstreamVerdict; readonly checkId?: string }; readonly conformance: { readonly verdict: UpstreamVerdict; readonly checkId?: string } };
};

export type ArtifactContractFinding = { readonly owner: "upstream" | "cvm-gap"; readonly checkId: string; readonly reason: string };
export type ArtifactContractDecision = { readonly verdict: "pass" | "block" | "manual_review"; readonly findings: readonly ArtifactContractFinding[]; readonly evidenceSha256: string };

const SHA256 = /^[a-f0-9]{64}$/i;
const KNOWN_DOMAINS = new Set(["storage", "intent"]);

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finding(owner: ArtifactContractFinding["owner"], checkId: string, reason: string): ArtifactContractFinding {
  return Object.freeze({ owner, checkId, reason });
}

function upstreamFinding(source: "scanner" | "conformance", result: ArtifactContractInput["upstream"]["scanner"]): ArtifactContractFinding | undefined {
  if (result.verdict === "pass" && typeof result.checkId === "string" && result.checkId.startsWith("upstream:")) return undefined;
  if (result.verdict === "block" && typeof result.checkId === "string" && result.checkId.startsWith("upstream:")) return finding("upstream", result.checkId, `${source} reported a blocking native finding`);
  return finding("cvm-gap", "cvm:evidence:upstream-unknown", `${source} report is malformed, unknown, or requires manual review`);
}

async function decision(findings: readonly ArtifactContractFinding[]): Promise<ArtifactContractDecision> {
  const verdict = findings.length === 0 ? "pass" : "block";
  const immutableFindings = Object.freeze([...findings]);
  return Object.freeze({ verdict, findings: immutableFindings, evidenceSha256: await sha256({ version: 1, verdict, findings: immutableFindings }) });
}

/**
 * Evaluates only CVM-owned policy gaps. Native scanner and conformance results are
 * immutable inputs; this function neither parses manifests nor repairs artifacts.
 */
export async function evaluateArtifactContract(input: ArtifactContractInput): Promise<ArtifactContractDecision> {
  const upstream = upstreamFinding("scanner", input.upstream.scanner) ?? upstreamFinding("conformance", input.upstream.conformance);
  if (upstream) return decision([upstream]);

  if (input.purpose.kind !== "focused" || input.purpose.statements.length !== 1 || input.surface.hasBackend || input.surface.hasSecondPurpose) {
    return decision([finding("cvm-gap", "cvm:scope:focused-only", "artifact must be one focused client-side purpose")]);
  }
  if (input.surface.serviceWorker) return decision([finding("cvm-gap", "cvm:gap:service-worker", "service worker registration is outside the allowed napplet surface")]);
  if (input.dependencies.appOwnedSignerOrRelay || input.dependencies.privateNappletImport) return decision([finding("cvm-gap", "cvm:gap:signer-relay", "app-owned signer, relay, protocol client, or private napplet import is prohibited")]);
  if (input.surface.dynamicAuthority) return decision([finding("cvm-gap", "cvm:gap:dynamic-authority", "dynamic authority construction cannot be safely inspected")]);

  const hard = [...input.capabilities.declaredHard];
  const observed = [...input.capabilities.observedDomains];
  if (new Set(hard).size !== hard.length || new Set(observed).size !== observed.length || hard.some((domain) => !KNOWN_DOMAINS.has(domain)) || observed.some((domain) => !KNOWN_DOMAINS.has(domain)) || observed.some((domain) => !hard.includes(domain) && domain !== "intent")) {
    return decision([finding("cvm-gap", "cvm:capability:necessary-hard", "capability set is unknown, duplicated, or observed without declaration")]);
  }
  if (hard.some((domain) => !observed.includes(domain))) return decision([finding("cvm-gap", "cvm:capability:necessary-hard", "every hard capability must be observed in the focused path")]);
  if (input.capabilities.optionalIntentPresenceRead && (!observed.includes("intent") || !input.capabilities.intentUsedThroughSdk)) {
    return decision([finding("cvm-gap", "cvm:capability:optional-intent-sdk", "optional intent presence reads require a public SDK invocation when intent is present")]);
  }
  if (!input.capabilities.optionalIntentPresenceRead && (observed.includes("intent") || input.capabilities.intentUsedThroughSdk)) {
    return decision([finding("cvm-gap", "cvm:capability:optional-intent-sdk", "intent may only be observed after the sanctioned presence read")]);
  }
  return decision([]);
}
