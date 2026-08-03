import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../promotion/schema";

type BundleStatus = "review-ready" | "blocked";
type Digest = string;

export type EvidenceBundleInput = {
  readonly verdict: { readonly status: BundleStatus; readonly responsibleStage: string };
  readonly manifest: { readonly candidateId: Digest; readonly sha256: Digest };
  readonly nativeReports: readonly { readonly id: string; readonly sha256: Digest }[];
  readonly integrationResults: readonly { readonly id: string; readonly reportDigests: readonly Digest[] }[];
  readonly artifacts: { readonly sha256: Digest; readonly goldenSha256: Digest };
  readonly reproducibility: { readonly status: "matched" | "mismatched"; readonly diffSha256: Digest };
  readonly provenance: { readonly links: readonly string[] };
};

export type EvidenceBundle = EvidenceBundleInput & {
  readonly version: 1;
  readonly evidenceSha256: Digest;
};

const SHA256 = /^[a-f0-9]{64}$/i;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requiredDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function validateInput(input: EvidenceBundleInput): void {
  if (!input.verdict || !["review-ready", "blocked"].includes(input.verdict.status)) throw new Error("verdict layer is required");
  requiredDigest(input.manifest?.candidateId, "manifest candidate ID");
  requiredDigest(input.manifest?.sha256, "manifest digest");
  if (!Array.isArray(input.nativeReports) || input.nativeReports.length === 0) throw new Error("nativeReports layer is required");
  const reportDigests = new Set(input.nativeReports.map((report) => {
    requiredDigest(report.sha256, "native report digest");
    return report.sha256;
  }));
  if (!Array.isArray(input.integrationResults) || input.integrationResults.length === 0) throw new Error("integrationResults layer is required");
  for (const result of input.integrationResults) {
    if (!Array.isArray(result.reportDigests) || result.reportDigests.length === 0) throw new Error("integration result must reference a native report digest");
    for (const digest of result.reportDigests) {
      requiredDigest(digest, "integration report digest");
      if (!reportDigests.has(digest)) throw new Error("integration result references an absent native report digest");
    }
  }
  requiredDigest(input.artifacts?.sha256, "artifacts digest");
  requiredDigest(input.artifacts?.goldenSha256, "artifacts golden digest");
  if (!input.reproducibility || !["matched", "mismatched"].includes(input.reproducibility.status)) throw new Error("reproducibility layer is required");
  requiredDigest(input.reproducibility.diffSha256, "reproducibility diff digest");
  if (!input.provenance || !Array.isArray(input.provenance.links) || input.provenance.links.length === 0 || !input.provenance.links.every((link) => typeof link === "string" && link.length > 0)) {
    throw new Error("provenance layer is required");
  }
}

export async function validateEvidenceBundle(bundle: EvidenceBundle): Promise<void> {
  validateInput(bundle);
  const { evidenceSha256, version, ...input } = bundle;
  if (version !== 1) throw new Error("evidence bundle version is invalid");
  const expected = await sha256(canonicalJson(input));
  if (evidenceSha256 !== expected) throw new Error("evidence bundle digest does not match its canonical layers");
}

/** Writes only a complete, canonically digested D-15 evidence bundle. */
export async function writeEvidenceBundle(directory: string, input: EvidenceBundleInput): Promise<EvidenceBundle> {
  validateInput(input);
  const evidenceSha256 = await sha256(canonicalJson(input));
  const bundle: EvidenceBundle = { version: 1, ...input, evidenceSha256 };
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(bundle)}\n`;
  const path = `${directory}/${evidenceSha256}.json`;
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== content) throw new Error("immutable evidence bundle collision");
  }
  return bundle;
}
