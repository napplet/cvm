import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../promotion/schema";
import { CertificationBundleSchema, CertificationObservationInputSchema, CertificationObservationSchema, type CertificationBundle, type CertificationObservation, type CertificationObservationInput } from "./contracts";

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join("");
}

function observationPayload(value: CertificationObservation): Omit<CertificationObservation, "evidenceSha256"> {
  const { evidenceSha256: _digest, ...payload } = value;
  return payload;
}

/** Validates a standalone observation before it can satisfy a specific owned claim. */
export async function validateCertificationObservation(value: unknown, requirements?: Readonly<{ nowMs: number; candidateId?: string; requiredClaim?: string }>): Promise<CertificationObservation> {
  const parsed = CertificationObservationSchema.parse(value);
  if (await digest(observationPayload(parsed)) !== parsed.evidenceSha256) throw new Error("CERTIFICATION_OBSERVATION_DIGEST_INVALID");
  if (requirements?.candidateId && parsed.candidate.id !== requirements.candidateId) throw new Error("CERTIFICATION_OBSERVATION_CANDIDATE_INVALID");
  if (requirements?.nowMs !== undefined && parsed.expiresAtMs <= requirements.nowMs) throw new Error("CERTIFICATION_OBSERVATION_STALE");
  if (requirements?.requiredClaim && (parsed.status !== "passed" || !parsed.claims.includes(requirements.requiredClaim))) throw new Error("CERTIFICATION_CLAIM_UNSATISFIED");
  return parsed;
}

/** Immutable create-or-verify record write. Same bytes replay; different bytes never overwrite. */
export async function writeCertificationObservation(directory: string, input: CertificationObservationInput): Promise<CertificationObservation> {
  const payload = CertificationObservationInputSchema.parse(input);
  const observation = CertificationObservationSchema.parse({ ...payload, evidenceSha256: await digest(payload) });
  await validateCertificationObservation(observation);
  await mkdir(directory, { recursive: true });
  const content = `${canonicalJson(observation)}\n`;
  const path = join(directory, `${observation.evidenceSha256}.json`);
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error("CERTIFICATION_OBSERVATION_COLLISION");
  }
  return observation;
}

/** Assembles an immutable bundle only from fresh passed records of the exact candidate, then atomically advances its pointer. */
export async function assembleCertificationBundle(directory: string, input: Readonly<{ candidateId: string; observations: readonly unknown[]; nowMs?: number; pointer?: string }>): Promise<CertificationBundle> {
  const nowMs = input.nowMs ?? Date.now();
  const observations = await Promise.all(input.observations.map((item) => validateCertificationObservation(item, { nowMs, candidateId: input.candidateId })));
  if (observations.some((item) => item.status !== "passed")) throw new Error("CERTIFICATION_BUNDLE_NON_PASS");
  const claims = [...new Set(observations.flatMap((item) => item.claims))].sort();
  if (claims.length === 0) throw new Error("CERTIFICATION_BUNDLE_CLAIMS_REQUIRED");
  const base = { version: 1 as const, candidateId: input.candidateId, observationDigests: observations.map((item) => item.evidenceSha256).sort(), claims, assembledAtMs: nowMs };
  const evidenceSha256 = await digest(base);
  const bundle = CertificationBundleSchema.parse({ ...base, evidenceSha256, pointer: `current/${evidenceSha256}.json` });
  await mkdir(directory, { recursive: true });
  const bundlePath = join(directory, `${bundle.evidenceSha256}.bundle.json`);
  const content = `${canonicalJson(bundle)}\n`;
  try { await writeFile(bundlePath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(bundlePath, "utf8") !== content) throw new Error("CERTIFICATION_BUNDLE_COLLISION"); }
  const pointerDirectory = join(directory, "current"); await mkdir(pointerDirectory, { recursive: true });
  const pointerPath = join(directory, input.pointer ?? "current.json");
  const temporary = join(pointerDirectory, `.${bundle.evidenceSha256}.tmp`);
  await writeFile(temporary, `${canonicalJson({ bundle: bundle.evidenceSha256 })}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, pointerPath);
  return bundle;
}
