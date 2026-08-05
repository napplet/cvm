import { mkdir } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema.js";
import { writeCertificationObservation } from "../src/certification/evidence.js";
import type { CertificationObservationInput } from "../src/certification/contracts.js";

const suites = ["admission", "telemetry", "chaos", "restore", "security-host", "supply-chain", "contextvm-payment-model", "publication"] as const;
type Suite = typeof suites[number];

type ReleaseProfile = Readonly<{
  candidate: { id: string; provider: "modal" | "fly"; image: string; sourceSha256: string };
  datasetSha256: string;
  topologySha256: string;
}>;

const DIGEST = /^[a-f0-9]{64}$/iu;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/iu;

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join("");
}

function argument(name: string): string | null {
  const value = Bun.argv.slice(2).find((item) => item.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : null;
}

function parseProfile(value: unknown): ReleaseProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release_profile_invalid");
  const record = value as Record<string, unknown>;
  const candidate = record.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("release_profile_candidate_invalid");
  const item = candidate as Record<string, unknown>;
  if (typeof item.id !== "string" || !DIGEST.test(item.id) || (item.provider !== "modal" && item.provider !== "fly") || typeof item.image !== "string" || !IMAGE.test(item.image) || typeof item.sourceSha256 !== "string" || !DIGEST.test(item.sourceSha256) || typeof record.datasetSha256 !== "string" || !DIGEST.test(record.datasetSha256) || typeof record.topologySha256 !== "string" || !DIGEST.test(record.topologySha256)) throw new Error("release_profile_identity_invalid");
  return { candidate: { id: item.id.toLowerCase(), provider: item.provider, image: item.image, sourceSha256: item.sourceSha256.toLowerCase() }, datasetSha256: record.datasetSha256.toLowerCase(), topologySha256: record.topologySha256.toLowerCase() };
}

async function blockedProfile(): Promise<ReleaseProfile> {
  const blocked = await digest({ phase: "07", kind: "protected-profile-unavailable" });
  return { candidate: { id: blocked, provider: "modal", image: `phase07/blocked@sha256:${blocked}`, sourceSha256: blocked }, datasetSha256: blocked, topologySha256: blocked };
}

async function profileForPreflight(): Promise<Readonly<{ profile: ReleaseProfile; profileSha256: string; status: "blocked" | "not_observed"; reasonCode: "INPUT_UNAVAILABLE" | "TOPOLOGY_UNAVAILABLE" }>> {
  const profilePath = process.env.PHASE07_RELEASE_PROFILE_PATH;
  if (!profilePath) return { profile: await blockedProfile(), profileSha256: await digest({ configured: false }), status: "blocked", reasonCode: "INPUT_UNAVAILABLE" };
  try {
    const source = await Bun.file(profilePath).text();
    return { profile: parseProfile(JSON.parse(source)), profileSha256: await digest(source), status: "not_observed", reasonCode: "TOPOLOGY_UNAVAILABLE" };
  } catch {
    return { profile: await blockedProfile(), profileSha256: await digest({ configured: true, readable: false }), status: "blocked", reasonCode: "INPUT_UNAVAILABLE" };
  }
}

function requiresSecrets(suite: Suite): readonly string[] {
  if (suite === "admission" || suite === "contextvm-payment-model") return ["PHASE07_CERTIFICATION_SECRETS_PATH"];
  if (suite === "security-host" || suite === "publication") return ["PHASE07_COMPATIBLE_HOST_URL", "NAPPLET_CLI_SOURCE_CHECKOUT"];
  if (suite === "restore" || suite === "chaos") return ["PHASE07_CERTIFICATION_SECRETS_PATH"];
  return [];
}

async function recordSuite(root: string, suite: Suite, state: Awaited<ReturnType<typeof profileForPreflight>>): Promise<Readonly<{ suite: Suite; status: string; evidenceSha256: string }>> {
  const now = Date.now();
  const missing = requiresSecrets(suite).some((name) => !process.env[name]);
  const status = missing ? "blocked" as const : state.status;
  const reasonCode = missing ? "CREDENTIALS_UNAVAILABLE" as const : state.reasonCode;
  const record: CertificationObservationInput = {
    version: 1, status, candidate: state.profile.candidate,
    input: { datasetSha256: state.profile.datasetSha256, profileSha256: state.profileSha256, topologySha256: state.profile.topologySha256, command: ["certify-phase-07", `suite:${suite}`] },
    startedAtMs: now, completedAtMs: now, expiresAtMs: now + 60_000, claims: [], limitations: [`suite-${suite}`, "protected-live-required"], reasonCode,
  };
  const evidence = await writeCertificationObservation(root, record);
  return { suite, status: evidence.status, evidenceSha256: evidence.evidenceSha256 };
}

async function main(): Promise<void> {
  const profile = argument("--profile");
  const suiteArgument = argument("--suite") ?? "all";
  const preflightOnly = Bun.argv.slice(2).includes("--preflight-only");
  const unknown = Bun.argv.slice(2).filter((item) => !item.startsWith("--profile=") && !item.startsWith("--suite=") && item !== "--preflight-only");
  if (profile !== "release" || unknown.length || (suiteArgument !== "all" && !suites.includes(suiteArgument as Suite))) {
    console.error(JSON.stringify({ phase: "07", command: "certify", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return;
  }
  const state = await profileForPreflight();
  const selected = preflightOnly || suiteArgument === "all" ? suites : [suiteArgument as Suite];
  const root = `evidence/certification/${state.profile.candidate.id}/live`;
  await mkdir(root, { recursive: true });
  const records = await Promise.all(selected.map((suite) => recordSuite(root, suite, state)));
  // This local runner intentionally has no provider client constructors.  It is a
  // protected inventory writer: a profile makes observations eligible to run, not passed.
  console.error(JSON.stringify({ phase: "07", command: "certify", profile: "release", status: "blocked", records }));
  process.exitCode = 1;
}

await main();
