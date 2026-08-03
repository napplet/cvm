/** Immutable identity contracts for a candidate promotion toolchain. */

export type CandidateStatus = "candidate" | "review-ready" | "blocked";

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
