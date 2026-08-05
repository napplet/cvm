import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { runHermeticCommand, type CommandDisposition } from "../runner/hermetic-command";
import { ReleaseObservationBindingSchema } from "./contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const HashSchema = z.object({ alg: z.literal("SHA-256"), content: DigestSchema }).strict();
const ComponentSchema = z.object({ type: z.literal("library"), name: z.string().min(1).max(160), version: z.string().min(1).max(120), hashes: z.array(HashSchema).length(1) }).strict();
const ToolSchema = z.object({ vendor: z.string().min(1).max(160), name: z.string().min(1).max(160), version: z.string().min(1).max(120), hashes: z.array(HashSchema).length(1) }).strict();
const CycloneDxSchema = z.object({
  bomFormat: z.literal("CycloneDX"), specVersion: z.literal("1.5"),
  metadata: z.object({ tools: z.array(ToolSchema).min(1).max(32), properties: z.array(z.object({ name: z.string(), value: DigestSchema }).strict()).length(2) }).strict(),
  components: z.array(ComponentSchema).min(1).max(256),
}).strict();
const ProvenanceSchema = z.object({
  _type: z.literal("https://in-toto.io/Statement/v1"), subject: z.array(z.object({ name: z.string().min(1), digest: z.object({ sha256: DigestSchema }).strict() }).strict()).length(1),
  predicateType: z.literal("https://slsa.dev/provenance/v1"),
  predicate: z.object({ buildDefinition: z.object({ externalParameters: z.object({ candidateId: DigestSchema, sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/iu), sourceSha256: DigestSchema, lockSha256: DigestSchema, toolchainSha256: DigestSchema, datasetSha256: DigestSchema }).strict() }).strict() }).strict(),
}).strict();
const CosignSchema = z.object({ executable: z.string().regex(/^\/[^\0\r\n]*$/u), executableSha256: DigestSchema, signerIdentity: z.string().min(1).max(512), issuer: z.string().url().max(512), predicateType: z.literal("https://slsa.dev/provenance/v1") }).strict();
const SupplyChainInputSchema = z.object({
  version: z.literal(1), evidenceClass: z.literal("protected_live"), candidateId: DigestSchema, releaseBinding: ReleaseObservationBindingSchema,
  artifactReference: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/iu), artifactSha256: DigestSchema,
  cosign: CosignSchema, sbom: CycloneDxSchema, provenance: ProvenanceSchema, reviewedComponents: z.array(z.object({ name: z.string().min(1).max(160), version: z.string().min(1).max(120), sha256: DigestSchema }).strict()).min(1).max(256),
  workingDirectory: z.string().regex(/^\/[^\0\r\n]*$/u),
}).strict();

export const SupplyChainRecordSchema = z.object({
  version: z.literal(1), evidenceClass: z.literal("protected_live"), status: z.literal("verified"), candidateId: DigestSchema, artifactSha256: DigestSchema,
  releaseBindingSha256: DigestSchema, cosignExecutableSha256: DigestSchema, cosignCommandSha256: DigestSchema, signerIdentitySha256: DigestSchema, issuerSha256: DigestSchema,
  predicateType: z.literal("https://slsa.dev/provenance/v1"), sbomFormat: z.literal("CycloneDX"), sbomSpecVersion: z.literal("1.5"), sbomGeneratorSha256: DigestSchema, sbomSha256: DigestSchema, provenanceSha256: DigestSchema, reviewedComponentsSha256: DigestSchema, verifiedAtMs: z.number().int().nonnegative().finite(),
  evidenceSha256: DigestSchema, contentAddressedPath: z.string().regex(/^evidence\/certification\/supply-chain\/[a-f0-9]{64}\.json$/iu),
}).strict();
export type SupplyChainRecord = z.infer<typeof SupplyChainRecordSchema>;

export type PinnedCommandRunner = (command: Readonly<{ executable: string; argv: readonly string[] }>) => Promise<Readonly<{ disposition: CommandDisposition; stdout: string; stderr: string }>>;
export type SupplyChainDependencies = Readonly<{ readExecutable?: (path: string) => Promise<Uint8Array>; run?: PinnedCommandRunner; nowMs?: () => number }>;

async function sha256(value: unknown): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasSensitive(value: unknown): boolean {
  if (typeof value === "string") return /(?:supersecret|secret|private.?key|password|credential|access.?token|api.?key)/iu.test(value);
  if (Array.isArray(value)) return value.some(hasSensitive);
  return typeof value === "object" && value !== null && Object.entries(value).some(([key, entry]) => /(?:secret|private.?key|password|credential|token|api.?key)/iu.test(key) || hasSensitive(entry));
}

function closedArgv(input: z.infer<typeof SupplyChainInputSchema>): readonly string[] {
  const policy = input.releaseBinding.supplyChainPolicy.cosign;
  return ["verify-attestation", "--type", policy.predicateType, "--certificate-identity", policy.signerIdentity, "--certificate-oidc-issuer", policy.issuer, "--output", "json", input.artifactReference];
}

function verifyDocuments(input: z.infer<typeof SupplyChainInputSchema>): void {
  const policy = input.releaseBinding.supplyChainPolicy;
  if (input.cosign.executableSha256 !== policy.cosign.executableSha256 || input.cosign.signerIdentity !== policy.cosign.signerIdentity || input.cosign.issuer !== policy.cosign.issuer || input.cosign.predicateType !== policy.cosign.predicateType || input.provenance.predicateType !== policy.cosign.predicateType || input.sbom.bomFormat !== policy.sbom.bomFormat || input.sbom.specVersion !== policy.sbom.specVersion || !input.sbom.metadata.tools.some((tool) => tool.vendor === policy.sbom.generator.vendor && tool.name === policy.sbom.generator.name && tool.version === policy.sbom.generator.version)) throw new Error("SUPPLY_CHAIN_POLICY_MISMATCH");
  if (hasSensitive(input.sbom) || hasSensitive(input.provenance)) throw new Error("SUPPLY_CHAIN_SENSITIVE_DOCUMENT_REJECTED");
  if (input.artifactReference.slice(-64).toLowerCase() !== input.artifactSha256) throw new Error("SUPPLY_CHAIN_ARTIFACT_REFERENCE_INVALID");
  const properties = Object.fromEntries(input.sbom.metadata.properties.map((item) => [item.name, item.value]));
  if (Object.keys(properties).length !== 2 || properties["cvm.lock.sha256"] !== input.releaseBinding.inputs.packageLockSha256 || properties["cvm.toolchain.sha256"] !== input.releaseBinding.inputs.toolchainSha256) throw new Error("SUPPLY_CHAIN_SBOM_BINDING_INVALID");
  if (!input.sbom.metadata.tools.some((tool) => tool.hashes[0]!.content === input.releaseBinding.inputs.toolchainSha256)) throw new Error("SUPPLY_CHAIN_TOOLCHAIN_NOT_REVIEWED");
  const reviewed = [...input.reviewedComponents].sort((left, right) => left.name.localeCompare(right.name));
  const components = [...input.sbom.components].map((component) => ({ name: component.name, version: component.version, sha256: component.hashes[0]!.content })).sort((left, right) => left.name.localeCompare(right.name));
  if (canonicalJson(reviewed) !== canonicalJson(components) || new Set(reviewed.map((item) => item.name)).size !== reviewed.length) throw new Error("SUPPLY_CHAIN_COMPONENTS_NOT_REVIEWED");
  const subject = input.provenance.subject[0]!;
  const parameters = input.provenance.predicate.buildDefinition.externalParameters;
  if (subject.name !== input.artifactReference || subject.digest.sha256 !== input.artifactSha256 || parameters.candidateId !== input.candidateId || parameters.sourceRevision !== input.releaseBinding.sourceRevision || parameters.sourceSha256 !== input.releaseBinding.sourceSha256 || parameters.lockSha256 !== input.releaseBinding.inputs.packageLockSha256 || parameters.toolchainSha256 !== input.releaseBinding.inputs.toolchainSha256 || parameters.datasetSha256 !== input.releaseBinding.inputs.datasetSha256) throw new Error("SUPPLY_CHAIN_PROVENANCE_BINDING_INVALID");
}

function parseCosignDsse(stdout: string, input: z.infer<typeof SupplyChainInputSchema>): void {
  if (hasSensitive(stdout)) throw new Error("SUPPLY_CHAIN_TOOL_OUTPUT_REDACTED");
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("SUPPLY_CHAIN_COSIGN_JSON_INVALID"); }
  const envelope = z.array(z.object({ payloadType: z.literal("application/vnd.in-toto+json"), payload: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict()).length(1).safeParse(value);
  if (!envelope.success) throw new Error("SUPPLY_CHAIN_COSIGN_JSON_INVALID");
  const payload = Buffer.from(envelope.data[0]!.payload, "base64");
  if (payload.toString("base64") !== envelope.data[0]!.payload) throw new Error("SUPPLY_CHAIN_DSSE_INVALID");
  let statement: unknown;
  try { statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { throw new Error("SUPPLY_CHAIN_DSSE_INVALID"); }
  if (hasSensitive(statement) || canonicalJson(ProvenanceSchema.parse(statement)) !== canonicalJson(input.provenance)) throw new Error("SUPPLY_CHAIN_DSSE_BINDING_INVALID");
}

async function productionRunner(input: z.infer<typeof SupplyChainInputSchema>, argv: readonly string[]): Promise<Readonly<{ disposition: CommandDisposition; stdout: string; stderr: string }>> {
  const executableSha256 = input.releaseBinding.supplyChainPolicy.cosign.executableSha256;
  const evidence = await runHermeticCommand({ id: "phase07-cosign-verify-attestation", executable: input.cosign.executable, executableSha256, allowedExecutables: [{ path: input.cosign.executable, sha256: executableSha256 }], argv, cwd: input.workingDirectory, timeoutMs: 60_000, outputLimitBytes: 65_536, toolchainId: input.candidateId, imageDigest: input.releaseBinding.inputs.controlImageDigest });
  return evidence;
}

/** Verifies a reviewed attestation only after a digest-pinned Cosign invocation; no signature primitive is reimplemented here. */
export async function verifySupplyChainCertification(raw: unknown, dependencies: SupplyChainDependencies = {}): Promise<SupplyChainRecord> {
  const input = SupplyChainInputSchema.parse(raw);
  verifyDocuments(input);
  const executable = await (dependencies.readExecutable ?? (async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer())))(input.cosign.executable);
  if (await sha256(executable) !== input.releaseBinding.supplyChainPolicy.cosign.executableSha256) throw new Error("SUPPLY_CHAIN_COSIGN_DIGEST_INVALID");
  const argv = closedArgv(input);
  const result = await (dependencies.run ?? ((command) => productionRunner(input, command.argv)))({ executable: input.cosign.executable, argv });
  if (result.disposition !== "passed") throw new Error("SUPPLY_CHAIN_COSIGN_EXECUTION_FAILED");
  parseCosignDsse(result.stdout, input);
  const sbomSha256 = await sha256(input.sbom); const provenanceSha256 = await sha256(input.provenance);
  if (sbomSha256 !== input.releaseBinding.inputs.sbomSha256 || provenanceSha256 !== input.releaseBinding.inputs.provenanceSha256) throw new Error("SUPPLY_CHAIN_DOCUMENT_DIGEST_INVALID");
  const base = { version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId: input.candidateId, artifactSha256: input.artifactSha256, releaseBindingSha256: await sha256(input.releaseBinding), cosignExecutableSha256: input.releaseBinding.supplyChainPolicy.cosign.executableSha256, cosignCommandSha256: await sha256({ executable: input.cosign.executable, argv }), signerIdentitySha256: await sha256(input.releaseBinding.supplyChainPolicy.cosign.signerIdentity), issuerSha256: await sha256(input.releaseBinding.supplyChainPolicy.cosign.issuer), predicateType: input.releaseBinding.supplyChainPolicy.cosign.predicateType, sbomFormat: input.releaseBinding.supplyChainPolicy.sbom.bomFormat, sbomSpecVersion: input.releaseBinding.supplyChainPolicy.sbom.specVersion, sbomGeneratorSha256: await sha256(input.releaseBinding.supplyChainPolicy.sbom.generator), sbomSha256, provenanceSha256, reviewedComponentsSha256: await sha256([...input.reviewedComponents].sort((left, right) => left.name.localeCompare(right.name))), verifiedAtMs: dependencies.nowMs?.() ?? Date.now() };
  const evidenceSha256 = await sha256(base);
  return SupplyChainRecordSchema.parse({ ...base, evidenceSha256, contentAddressedPath: `evidence/certification/supply-chain/${evidenceSha256}.json` });
}

/** Revalidates the redacted persisted supply-chain facts before they can back a
 * release claim. Raw Cosign/SBOM/provenance material is never retained here. */
export async function validateSupplyChainVerificationRecord(value: unknown, expected: Readonly<{ candidateId: string; releaseBinding: unknown; artifactSha256: string; nowMs?: number; maxAgeMs?: number }>): Promise<SupplyChainRecord> {
  const record = SupplyChainRecordSchema.parse(value);
  const nowMs = expected.nowMs ?? Date.now(); const maxAgeMs = expected.maxAgeMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new Error("SUPPLY_CHAIN_FRESHNESS_INVALID");
  if (record.candidateId !== expected.candidateId.toLowerCase() || record.artifactSha256 !== expected.artifactSha256.toLowerCase()
    || record.releaseBindingSha256 !== await sha256(ReleaseObservationBindingSchema.parse(expected.releaseBinding))) throw new Error("SUPPLY_CHAIN_RELEASE_BINDING_INVALID");
  const policy = ReleaseObservationBindingSchema.parse(expected.releaseBinding).supplyChainPolicy;
  if (record.cosignExecutableSha256 !== policy.cosign.executableSha256 || record.signerIdentitySha256 !== await sha256(policy.cosign.signerIdentity) || record.issuerSha256 !== await sha256(policy.cosign.issuer) || record.predicateType !== policy.cosign.predicateType || record.sbomFormat !== policy.sbom.bomFormat || record.sbomSpecVersion !== policy.sbom.specVersion || record.sbomGeneratorSha256 !== await sha256(policy.sbom.generator)) throw new Error("SUPPLY_CHAIN_POLICY_MISMATCH");
  if (record.verifiedAtMs > nowMs) throw new Error("SUPPLY_CHAIN_RECORD_FROM_FUTURE");
  if (nowMs - record.verifiedAtMs > maxAgeMs) throw new Error("SUPPLY_CHAIN_RECORD_STALE");
  const { evidenceSha256, contentAddressedPath, ...base } = record;
  if (evidenceSha256 !== await sha256(base) || contentAddressedPath !== `evidence/certification/supply-chain/${evidenceSha256}.json`) throw new Error("SUPPLY_CHAIN_RECORD_DIGEST_INVALID");
  return record;
}

/** Persists exactly the finite, redacted verification facts with create-or-verify semantics. */
export async function writeSupplyChainRecord(directory: string, input: unknown, dependencies: SupplyChainDependencies = {}): Promise<SupplyChainRecord> {
  const record = await verifySupplyChainCertification(input, dependencies); await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.evidenceSha256}.json`); const content = `${canonicalJson(record)}\n`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; if (await readFile(path, "utf8") !== content) throw new Error("SUPPLY_CHAIN_RECORD_COLLISION"); }
  return record;
}
