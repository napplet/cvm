/**
 * Generates the next unpromoted capabilities-worker source profile from a
 * fixed, sorted source manifest.  It deliberately never edits a profile that
 * might describe a retained image or historical evidence.
 */
import { resolve } from "node:path";

const INPUTS = Object.freeze([
  "infra/toolchain/capabilities.Dockerfile",
  "infra/toolchain/production-bootstrap.sh",
  "infra/toolchain/production-job.ts",
  "infra/toolchain/production-probe.ts",
  "infra/toolchain/production-worker.ts",
  "toolchains/locks/capabilities-cli/deno.lock",
  "toolchains/locks/capabilities-worker/package.json",
  "toolchains/locks/capabilities-worker/pnpm-lock.yaml",
  "toolchains/overlays/capabilities-template/package.json",
  "toolchains/overlays/capabilities-template/pnpm-lock.yaml",
  "toolchains/overlays/capabilities-template/vite.config.ts",
] as const);

const PROFILE_PATH = "toolchains/recipes/capabilities-worker-profile-v3-unpromoted.json";
const SELECTOR_PATH = "toolchains/recipes/capabilities-worker-current.json";
const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;

export async function generateCapabilitiesWorkerProfile() {
  const inputs = await Promise.all([...INPUTS].sort((left, right) => left.localeCompare(right)).map(async path => Object.freeze({ path, sha256: sha256(await Bun.file(path).bytes()) })));
  const profile = Object.freeze({
    schemaVersion: 1,
    status: "prepared-profile-not-promoted",
    artifactContract: "nip5d-direct-v1",
    workerContract: "edge-native-v3-unpromoted",
    workerImageTarget: "edge-production-worker",
    sourceVersion: 3,
    transportBundleVersion: 4,
    sealedArtifactVersion: 3,
    cliSourceRecipe: "toolchains/recipes/napplet-cli-0.13.0-capabilities-source-build.json",
    inputManifestSha256: sha256(canonical(inputs)),
    inputs,
    purpose: Object.freeze({ source: "authenticated bounded request idea", maximumCharacters: 4096, file: ".napplet-cvm-authoring.json", authority: "root-owned data; generated source cannot edit configuration" }),
    promotion: Object.freeze({ selected: false, protectedEvidence: null, blockers: Object.freeze([
      "Original-toolchain profile selection for retries and the retained 30-day resume window remains required.",
      "Meaningful capability policy, complete direct publication helpers, owner artifact reader and ordinary preview/publication composition remain required.",
      "Actual compatible-host owner flow and all eight protected suites remain required.",
    ]) }),
  });
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  const selector = Object.freeze({ version: 1, status: "unpromoted", profile: PROFILE_PATH, profileSha256: sha256(canonical(profile)), sourceVersion: 3, promotion: Object.freeze({ selected: false, protectedEvidence: null }) });
  return Object.freeze({ profile, profileBytes, selector, selectorBytes: `${JSON.stringify(selector, null, 2)}\n` });
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--verify";
  if (mode !== "--write" && mode !== "--verify") throw new Error("CAPABILITIES_PROFILE_ARGUMENT_INVALID");
  const generated = await generateCapabilitiesWorkerProfile();
  if (mode === "--write") {
    await Bun.write(resolve(PROFILE_PATH), generated.profileBytes);
    await Bun.write(resolve(SELECTOR_PATH), generated.selectorBytes);
  } else {
    const [profile, selector] = await Promise.all([Bun.file(PROFILE_PATH).json(), Bun.file(SELECTOR_PATH).json()]);
    if (canonical(profile) !== canonical(generated.profile) || canonical(selector) !== canonical(generated.selector)) throw new Error("CAPABILITIES_PROFILE_STALE");
  }
}
