import { mkdir } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema.js";
import { loadProtectedCertificationAdapterRegistry } from "../src/certification/adapters.js";
import { ReleaseObservationBindingSchema } from "../src/certification/contracts.js";
import { PROTECTED_SUITES, runProtectedCertificationProfile, type ProtectedCertificationProfile } from "../src/certification/runner.js";

const DIGEST = /^[a-f0-9]{64}$/iu;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/iu;
async function digest(value: unknown): Promise<string> { const valueBytes = new TextEncoder().encode(canonicalJson(value)); const hash = await crypto.subtle.digest("SHA-256", valueBytes); return Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join(""); }
function argument(name: string): string | null { const value = Bun.argv.slice(2).find((item) => item.startsWith(`${name}=`)); return value ? value.slice(name.length + 1) : null; }
async function blockedProfile(): Promise<ProtectedCertificationProfile> { const blocked = await digest({ phase: "07", kind: "protected-profile-unavailable" }); return { candidate: { id: blocked, provider: "modal", image: `phase07/blocked@sha256:${blocked}`, sourceSha256: blocked }, datasetSha256: blocked, topologySha256: blocked, profileSha256: await digest({ configured: false }), credentialsAvailable: false }; }
async function profile(): Promise<ProtectedCertificationProfile> {
  const path = process.env.PHASE07_RELEASE_PROFILE_PATH; if (!path) return blockedProfile();
  try { const source = await Bun.file(path).text(); const value = JSON.parse(source) as Record<string, unknown>; const candidate = value.candidate as Record<string, unknown>;
    if (!candidate || typeof candidate.id !== "string" || !DIGEST.test(candidate.id) || (candidate.provider !== "modal" && candidate.provider !== "fly") || typeof candidate.image !== "string" || !IMAGE.test(candidate.image) || typeof candidate.sourceSha256 !== "string" || !DIGEST.test(candidate.sourceSha256) || typeof value.datasetSha256 !== "string" || !DIGEST.test(value.datasetSha256) || typeof value.topologySha256 !== "string" || !DIGEST.test(value.topologySha256)) return blockedProfile();
    const binding = ReleaseObservationBindingSchema.safeParse(value.releaseBinding);
    return { candidate: { id: candidate.id.toLowerCase(), provider: candidate.provider, image: candidate.image, sourceSha256: candidate.sourceSha256.toLowerCase() }, datasetSha256: value.datasetSha256.toLowerCase(), topologySha256: value.topologySha256.toLowerCase(), profileSha256: await digest(source), credentialsAvailable: Boolean(process.env.PHASE07_CERTIFICATION_SECRETS_PATH), ...(binding.success ? { releaseBinding: binding.data } : {}) };
  } catch { return blockedProfile(); }
}
async function main(): Promise<void> {
  const requested = argument("--suite") ?? "all"; const preflightOnly = Bun.argv.slice(2).includes("--preflight-only"); const unknown = Bun.argv.slice(2).filter((item) => !item.startsWith("--profile=") && !item.startsWith("--suite=") && item !== "--preflight-only");
  if (argument("--profile") !== "release" || unknown.length || (requested !== "all" && !PROTECTED_SUITES.includes(requested as typeof PROTECTED_SUITES[number]))) { console.error(JSON.stringify({ phase: "07", command: "certify", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  const releaseProfile = await profile(); const root = process.env.PHASE07_CERTIFICATION_EVIDENCE_DIRECTORY ?? `evidence/certification/${releaseProfile.candidate.id}/live`; await mkdir(root, { recursive: true });
  let registry; if (!preflightOnly && process.env.PHASE07_CERTIFICATION_ADAPTER_ROOT && process.env.PHASE07_CERTIFICATION_ADAPTER_MODULE && process.env.PHASE07_CERTIFICATION_ADAPTER_SHA256) { try { registry = await loadProtectedCertificationAdapterRegistry({ root: process.env.PHASE07_CERTIFICATION_ADAPTER_ROOT, modulePath: process.env.PHASE07_CERTIFICATION_ADAPTER_MODULE, sha256: process.env.PHASE07_CERTIFICATION_ADAPTER_SHA256 }); } catch {} }
  const result = await runProtectedCertificationProfile({ profile: releaseProfile, selectedSuites: requested === "all" ? PROTECTED_SUITES : [requested as typeof PROTECTED_SUITES[number]], evidenceDirectory: root, registry, preflightOnly });
  console.error(JSON.stringify({ phase: "07", command: "certify", profile: "release", status: result.status, records: result.records.map(({ evidenceSha256, status }) => ({ evidenceSha256, status })) })); process.exitCode = result.status === "passed" ? 0 : 1;
}
await main();
