/** Immutable identity contracts for a candidate promotion toolchain. */

export type CandidateStatus = "candidate" | "review-ready" | "promoted" | "blocked";

export type PromotionStage = {
  readonly id: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly expectedOutput: Readonly<Record<string, unknown>>;
};

export type PromotionManifest = {
  readonly schemaVersion: 1;
  readonly status: "candidate";
  readonly protocol: {
    readonly nip5dRevision: string;
    readonly napRevisions: readonly string[];
  };
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
    readonly sourceCommit: string;
  }[];
  readonly executables: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly lockfileSha256: string;
  readonly scaffoldRevision: string;
  readonly imageDigest: string;
  readonly runtimeVersion: string;
  readonly browserVersion: string;
  readonly fixtures: readonly { readonly name: string; readonly revision: string; readonly sha256: string }[];
  readonly goldens: readonly { readonly name: string; readonly revision: string; readonly sha256: string }[];
  readonly policyVersion: string;
  readonly workingDirectory: string;
  readonly stages: readonly PromotionStage[];
};

/** One immutable, candidate-independent release input set.  These fields close the
 * Phase 1/6 deferrals without reimplementing the napplet manifest or CLI contract. */
export type ReleaseCertificationManifest = {
  readonly version: 1;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly sourceSha256: string;
  readonly supplyChainPolicy: {
    readonly cosign: { readonly executableSha256: string; readonly signerIdentity: string; readonly issuer: string; readonly predicateType: "https://slsa.dev/provenance/v1" };
    readonly sbom: { readonly bomFormat: "CycloneDX"; readonly specVersion: "1.5"; readonly generator: { readonly vendor: string; readonly name: string; readonly version: string } };
  };
  readonly inputs: {
    readonly controlImageDigest: string;
    readonly workerImageDigest: string;
    readonly packageLockSha256: string;
    readonly toolchainSha256: string;
    readonly migrationSha256: string;
    readonly configSha256: string;
    readonly policySha256: string;
    readonly datasetSha256: string;
    readonly goldenSha256: string;
    readonly sbomSha256: string;
    readonly provenanceSha256: string;
  };
  readonly requirements: readonly ReleaseEvidenceRequirement[];
  readonly waivers: readonly ReleaseWaiver[];
};

export type ReleaseEvidenceRequirement = { readonly id: string; readonly claim: string; readonly freshnessMs: number; readonly live: boolean };
export type ReleaseWaiver = { readonly class: string; readonly owner: string; readonly reason: string; readonly evidenceSha256: string; readonly expiresAtMs: number; readonly rollbackTrigger: string; readonly affectedIdentity: string };

/** The release gate owns this inventory. Callers may supply freshness windows,
 * never substitute, omit, or invent the claims that make up a v1 release. */
export const RELEASE_CLAIM_INVENTORY = Object.freeze([
  { id: "deterministic-fault-matrix", claim: "release.deterministic_fault_matrix", live: false },
  { id: "telemetry-policy", claim: "release.telemetry_policy", live: false },
  { id: "supply-chain", claim: "release.supply_chain", live: false },
  { id: "admission-slo", claim: "release.admission_slo", live: true },
  { id: "contextvm-relay", claim: "release.contextvm_relay", live: true },
  { id: "cep8-lightning", claim: "release.cep8_lightning", live: true },
  { id: "cashu", claim: "release.cashu", live: true },
  { id: "model-reconciliation", claim: "release.model_reconciliation", live: true },
  { id: "worker", claim: "release.worker", live: true },
  { id: "checkpoint-object", claim: "release.checkpoint_object", live: true },
  { id: "database-failover", claim: "release.database_failover", live: true },
  { id: "control-plane", claim: "release.control_plane", live: true },
  { id: "compatible-host", claim: "release.compatible_host", live: true },
  { id: "owner-signer", claim: "release.owner_signer", live: true },
  { id: "promoted-cli", claim: "release.promoted_cli", live: true },
  { id: "sealed-upload", claim: "release.sealed_upload", live: true },
  { id: "publication-relay", claim: "release.publication_relay", live: true },
] as const);

/** D-129: no waiver may weaken these release safety or live-certification gates. */
export const NON_WAIVABLE_RELEASE_CLASSES = new Set([
  "nip5d-conformance", "sealed-identity", "user-key-custody", "direct-authority-escape", "ledger-double-charge",
  "duplicate-ownership-publication", "five-second-slo", "required-live-certification",
]);

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40,64}$/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`manifest.${key} must be a non-empty string`);
  return value;
}

function sha256(record: JsonRecord, key: string): string {
  const value = requiredString(record, key);
  if (!SHA256.test(value)) throw new Error(`manifest.${key} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function revision(value: string, label: string): string {
  if (!COMMIT.test(value)) throw new Error(`${label} must be a 40-64 character revision pin`);
  return value.toLowerCase();
}

function records(value: unknown, label: string): readonly JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) {
    throw new Error(`${label} must be a non-empty array of objects`);
  }
  return value;
}

function parsePinnedArtifacts(value: unknown, label: string): PromotionManifest["fixtures"] {
  return records(value, `manifest.${label}`).map((entry) => ({
    name: requiredString(entry, "name"),
    revision: revision(requiredString(entry, "revision"), `${label}.revision`),
    sha256: sha256(entry, "sha256"),
  }));
}

function parseStage(value: unknown): PromotionStage {
  if (!isRecord(value)) throw new Error("manifest.stages entries must be objects");
  const executable = requiredString(value, "executable");
  if (!executable.startsWith("/")) throw new Error("manifest stage executable must be absolute");
  const argv = value.argv;
  if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === "string")) {
    throw new Error("manifest stage argv must be a string array");
  }
  const timeoutMs = value.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 60_000) {
    throw new Error("manifest stage timeoutMs must be an integer between 1 and 60000");
  }
  if (!isRecord(value.expectedOutput)) throw new Error("manifest stage expectedOutput must be an object");
  return { id: requiredString(value, "id"), executable, argv, timeoutMs: timeoutMs as number, expectedOutput: value.expectedOutput };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): JsonRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error(`${label} must contain exactly its required immutable fields`);
  return value;
}

function releaseClaim(value: unknown, label: string): string {
  const claim = requiredString({ value }, "value");
  if (!/^[a-z][a-z0-9_.-]{2,127}$/u.test(claim)) throw new Error(`${label} must be a bounded claim`);
  return claim;
}

/** Parses the single authoritative release gate input.  It deliberately accepts
 * digests and observations only; vendor output, credentials, and key material never enter it. */
export function parseReleaseCertificationManifest(value: unknown): ReleaseCertificationManifest {
  const record = exactRecord(value, "release manifest", ["version", "releaseId", "sourceRevision", "sourceSha256", "supplyChainPolicy", "inputs", "requirements", "waivers"]);
  if (record.version !== 1) throw new Error("release manifest.version must be 1");
  const inputsRecord = exactRecord(record.inputs, "release manifest.inputs", [
    "controlImageDigest", "workerImageDigest", "packageLockSha256", "toolchainSha256", "migrationSha256", "configSha256",
    "policySha256", "datasetSha256", "goldenSha256", "sbomSha256", "provenanceSha256",
  ]);
  const supplyChainPolicy = exactRecord(record.supplyChainPolicy, "release manifest.supplyChainPolicy", ["cosign", "sbom"]);
  const cosignPolicy = exactRecord(supplyChainPolicy.cosign, "release manifest.supplyChainPolicy.cosign", ["executableSha256", "signerIdentity", "issuer", "predicateType"]);
  const sbomPolicy = exactRecord(supplyChainPolicy.sbom, "release manifest.supplyChainPolicy.sbom", ["bomFormat", "specVersion", "generator"]);
  const sbomGenerator = exactRecord(sbomPolicy.generator, "release manifest.supplyChainPolicy.sbom.generator", ["vendor", "name", "version"]);
  if (cosignPolicy.predicateType !== "https://slsa.dev/provenance/v1" || sbomPolicy.bomFormat !== "CycloneDX" || sbomPolicy.specVersion !== "1.5") throw new Error("release manifest supply-chain policy is unsupported");
  const requirementsRaw = records(record.requirements, "release manifest.requirements");
  const requirements = requirementsRaw.map((entry) => {
    const freshnessMs = entry.freshnessMs;
    if (!Number.isInteger(freshnessMs) || (freshnessMs as number) < 1 || (freshnessMs as number) > 31 * 24 * 60 * 60 * 1000) throw new Error("release requirement freshnessMs is invalid");
    if (typeof entry.live !== "boolean") throw new Error("release requirement live must be boolean");
    return { id: requiredString(entry, "id"), claim: releaseClaim(entry.claim, "release requirement claim"), freshnessMs: freshnessMs as number, live: entry.live };
  });
  if (new Set(requirements.map((item) => item.id)).size !== requirements.length || new Set(requirements.map((item) => item.claim)).size !== requirements.length) throw new Error("release requirement IDs and claims must be unique");
  if (requirements.length !== RELEASE_CLAIM_INVENTORY.length || requirements.some((item) => !RELEASE_CLAIM_INVENTORY.some((required) => required.id === item.id && required.claim === item.claim && required.live === item.live))) {
    throw new Error("release requirements must match the closed required-claim inventory");
  }
  if (!Array.isArray(record.waivers) || !record.waivers.every(isRecord)) throw new Error("release manifest.waivers must be an array");
  const waivers = record.waivers.map((entry) => {
    const waiver = exactRecord(entry, "release waiver", ["class", "owner", "reason", "evidenceSha256", "expiresAtMs", "rollbackTrigger", "affectedIdentity"]);
    const waiverClass = requiredString(waiver, "class");
    if (NON_WAIVABLE_RELEASE_CLASSES.has(waiverClass)) throw new Error(`release waiver class ${waiverClass} is non-waivable`);
    const expiresAtMs = waiver.expiresAtMs;
    if (!Number.isInteger(expiresAtMs) || (expiresAtMs as number) <= 0) throw new Error("release waiver expiry must be a positive integer");
    return { class: waiverClass, owner: requiredString(waiver, "owner"), reason: requiredString(waiver, "reason"), evidenceSha256: sha256(waiver, "evidenceSha256"), expiresAtMs: expiresAtMs as number, rollbackTrigger: requiredString(waiver, "rollbackTrigger"), affectedIdentity: sha256(waiver, "affectedIdentity") };
  });
  if (new Set(waivers.map((item) => item.class)).size !== waivers.length) throw new Error("release waiver classes must be unique");
  return deepFreeze({
    version: 1, releaseId: sha256(record, "releaseId"), sourceRevision: revision(requiredString(record, "sourceRevision"), "release sourceRevision"), sourceSha256: sha256(record, "sourceSha256"),
    supplyChainPolicy: { cosign: { executableSha256: sha256(cosignPolicy, "executableSha256"), signerIdentity: requiredString(cosignPolicy, "signerIdentity"), issuer: requiredString(cosignPolicy, "issuer"), predicateType: "https://slsa.dev/provenance/v1" }, sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: requiredString(sbomGenerator, "vendor"), name: requiredString(sbomGenerator, "name"), version: requiredString(sbomGenerator, "version") } } },
    inputs: {
      controlImageDigest: sha256(inputsRecord, "controlImageDigest"), workerImageDigest: sha256(inputsRecord, "workerImageDigest"), packageLockSha256: sha256(inputsRecord, "packageLockSha256"), toolchainSha256: sha256(inputsRecord, "toolchainSha256"), migrationSha256: sha256(inputsRecord, "migrationSha256"), configSha256: sha256(inputsRecord, "configSha256"), policySha256: sha256(inputsRecord, "policySha256"), datasetSha256: sha256(inputsRecord, "datasetSha256"), goldenSha256: sha256(inputsRecord, "goldenSha256"), sbomSha256: sha256(inputsRecord, "sbomSha256"), provenanceSha256: sha256(inputsRecord, "provenanceSha256"),
    }, requirements, waivers,
  });
}

/** Parses every D-04 pin before an executable can be invoked. */
export function parsePromotionManifest(value: unknown): PromotionManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
  if (value.status !== "candidate") throw new Error("manifest.status must be candidate");
  if (!isRecord(value.protocol)) throw new Error("manifest.protocol must be an object");

  const packages = records(value.packages, "manifest.packages").map((entry) => {
    const version = requiredString(entry, "version");
    if (version === "latest" || /[~^*]/.test(version)) throw new Error("manifest package version must be an exact pin");
    const integrity = requiredString(entry, "integrity");
    if (!integrity.startsWith("sha512-")) throw new Error("manifest package integrity must be sha512-");
    return { name: requiredString(entry, "name"), version, integrity, sourceCommit: revision(requiredString(entry, "sourceCommit"), "package.sourceCommit") };
  });
  const executables = records(value.executables, "manifest.executables").map((entry) => {
    const path = requiredString(entry, "path");
    if (!path.startsWith("/")) throw new Error("manifest executable path must be absolute");
    return { path, sha256: sha256(entry, "sha256") };
  });
  if (new Set(executables.map((entry) => entry.path)).size !== executables.length) throw new Error("manifest executable paths must be unique");
  const napRevisions = value.protocol.napRevisions;
  if (!Array.isArray(napRevisions) || napRevisions.length === 0 || !napRevisions.every((item) => typeof item === "string")) {
    throw new Error("manifest.protocol.napRevisions must be a non-empty revision array");
  }
  const stages = records(value.stages, "manifest.stages").map(parseStage);
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) throw new Error("manifest stage IDs must be unique");
  for (const stage of stages) {
    if (!executables.some((entry) => entry.path === stage.executable)) throw new Error(`manifest stage ${stage.id} references an unapproved executable`);
  }
  const workingDirectory = requiredString(value, "workingDirectory");
  if (!workingDirectory.startsWith("/")) throw new Error("manifest.workingDirectory must be absolute");

  return deepFreeze({
    schemaVersion: 1,
    status: "candidate",
    protocol: { nip5dRevision: revision(requiredString(value.protocol, "nip5dRevision"), "protocol.nip5dRevision"), napRevisions: napRevisions.map((item) => revision(item, "protocol.napRevisions")) },
    packages,
    executables,
    lockfileSha256: sha256(value, "lockfileSha256"),
    scaffoldRevision: revision(requiredString(value, "scaffoldRevision"), "scaffoldRevision"),
    imageDigest: sha256(value, "imageDigest"),
    runtimeVersion: requiredString(value, "runtimeVersion"),
    browserVersion: requiredString(value, "browserVersion"),
    fixtures: parsePinnedArtifacts(value.fixtures, "fixtures"),
    goldens: parsePinnedArtifacts(value.goldens, "goldens"),
    policyVersion: requiredString(value, "policyVersion"),
    workingDirectory,
    stages,
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Text(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A stable SHA-256 identity over every immutable manifest pin. */
export async function canonicalToolchainId(manifest: PromotionManifest): Promise<string> {
  return sha256Text(canonicalJson(manifest));
}
