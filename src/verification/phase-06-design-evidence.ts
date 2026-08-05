import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../promotion/schema.js";

const SHA256 = /^[a-f0-9]{64}$/iu;
const REQUIREMENTS = ["PREV-01", "PREV-02", "PREV-03", "PREV-04", "PUB-01", "PUB-02", "PUB-03", "PUB-04", "PUB-05"] as const;
const DECISIONS = Array.from({ length: 18 }, (_, index) => `D-${index + 96}`);
const THREATS = ["T-06-07-S", "T-06-07-C", "T-06-07-T", "T-06-07-R", "T-06-07-I", "T-06-07-E", "T-06-SC"] as const;
const LIVE_OBSERVATIONS = ["live_host", "external_signer", "promoted_cli_asset", "relay", "blossom", "postgres_cockroach", "selected_provider"] as const;

const EffectSchema = z.object({ deploy: z.number().int().nonnegative(), observe: z.number().int().nonnegative(), attestation: z.number().int().nonnegative() }).strict();
const ComparisonSchema = z.object({ id: z.string().min(1), expected: z.object({ status: z.string(), effects: z.string(), value: z.string() }).strict(), observed: z.object({ status: z.string(), effects: z.string(), value: z.string() }).strict(), effects: EffectSchema }).strict();
const MappingSchema = z.record(z.string(), z.array(z.string()).min(1));
const ApiRowSchema = z.object({ id: z.string().min(1), disposition: z.enum(["INTEGRATE", "OPT-OUT"]), reason: z.string().min(1), coverage: z.array(z.string()).min(1) }).strict();
export const Phase06ProviderObservationSchema = z.object({ provider: z.string().min(1), status: z.enum(["passed", "not_observed"]), owner: z.string().min(1), reasonCode: z.string().min(1), selection: z.literal("unselected") }).strict();

const EvidenceBaseSchema = z.object({
  version: z.literal(1), phase: z.literal("06"), certificationProfile: z.literal("design"), verdict: z.enum(["design-ready", "blocked"]), offlineVerdict: z.enum(["passed", "blocked"]),
  checks: z.object({ referenceSet: z.literal("passed"), sourceContract: z.literal("available"), apiCoverage: z.literal("passed"), determinism: z.literal("passed"), redaction: z.literal("passed") }).strict(),
  requirementMappings: MappingSchema, decisionMappings: MappingSchema, threatMappings: MappingSchema, apiCoverage: z.array(ApiRowSchema).min(1), edgeProbeMappings: MappingSchema, uiMappings: MappingSchema,
  identities: z.object({ promotedCliSourceCommit: z.string().regex(/^[a-f0-9]{40}$/iu), promotedCliLinuxSha256: z.string().regex(SHA256), sourceContractStatus: z.literal("available"), sourceContractLiveExecution: z.literal("not_observed") }).strict(),
  aggregateEffects: EffectSchema.extend({ cases: z.number().int().nonnegative() }).strict(), caseComparisons: z.array(ComparisonSchema).length(26), observations: z.array(Phase06ProviderObservationSchema).length(9),
}).strict();
export const Phase06DesignEvidenceSchema = EvidenceBaseSchema.extend({ evidenceSha256: z.string().regex(SHA256), contentAddressedPath: z.string().regex(/^evidence\/design\/[a-f0-9]{64}\.json$/iu) }).strict();
export type Phase06DesignEvidence = z.infer<typeof Phase06DesignEvidenceSchema>;
export type Phase06DesignInput = Readonly<{ fixture: unknown; comparisons: readonly z.infer<typeof ComparisonSchema>[]; apiRows: readonly z.infer<typeof ApiRowSchema>[]; sourceContract: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(values: readonly string[], required: readonly string[]): boolean { return values.length === required.length && new Set(values).size === required.length && required.every((value) => values.includes(value)); }
function safe(value: unknown): boolean {
  if (typeof value === "string") return !/(?:bearer\s+\S+|-----BEGIN(?:[A-Z ]+)?PRIVATE KEY-----|raw[_ -]?(?:cli|provider|transport)[_-]?payload|protected[_ -]?payload)/iu.test(value);
  if (Array.isArray(value)) return value.every(safe);
  return !isRecord(value) || Object.entries(value).every(([key, nested]) => !/(?:private|token|bearer|credential|raw|protected|prompt|reasoning)/iu.test(key) && safe(nested));
}
function payload(evidence: Omit<Phase06DesignEvidence, "evidenceSha256" | "contentAddressedPath"> | Phase06DesignEvidence) {
  const { evidenceSha256: _digest, contentAddressedPath: _path, ...withoutIdentity } = evidence as Phase06DesignEvidence;
  return withoutIdentity;
}
export function canonicalPhase06EvidenceBytes(evidence: Omit<Phase06DesignEvidence, "evidenceSha256" | "contentAddressedPath"> | Phase06DesignEvidence): Uint8Array { return new TextEncoder().encode(canonicalJson(payload(evidence))); }
export function phase06EvidenceSha256(evidence: Omit<Phase06DesignEvidence, "evidenceSha256" | "contentAddressedPath"> | Phase06DesignEvidence): string { return createHash("sha256").update(canonicalPhase06EvidenceBytes(evidence)).digest("hex"); }

export function buildPhase06DesignEvidence(input: Phase06DesignInput): Phase06DesignEvidence {
  const fixture = z.object({ cases: z.array(z.object({ id: z.string(), requirements: z.array(z.string()), decisions: z.array(z.string()), threats: z.array(z.string()), edge: z.string(), expected: ComparisonSchema.shape.expected, expectedEffects: EffectSchema, liveObservationClass: z.enum(["deterministic", "source_contract"]) }).passthrough()).length(26) }).passthrough().parse(input.fixture);
  const comparisons = z.array(ComparisonSchema).length(26).parse(input.comparisons);
  const apiRows = z.array(ApiRowSchema).min(1).parse(input.apiRows);
  const source = z.object({ status: z.literal("available"), liveExecution: z.literal("not_observed"), identity: z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/iu), linuxSha256: z.string().regex(SHA256) }).passthrough() }).passthrough().parse(input.sourceContract);
  if (!safe({ comparisons, source }) || !exact(comparisons.map((item) => item.id), fixture.cases.map((item) => item.id))) throw new Error("Phase 06 evidence comparisons are malformed or disclose protected data");
  if (comparisons.some((item) => canonicalJson(item.expected) !== canonicalJson(item.observed))) throw new Error("Phase 06 evidence has an expected/observed mismatch");
  const mapping = (field: "requirements" | "decisions" | "threats", ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, fixture.cases.filter((item) => item[field].includes(id)).map((item) => item.id)]));
  const requirements = mapping("requirements", REQUIREMENTS); const decisions = mapping("decisions", DECISIONS); const threats = mapping("threats", THREATS);
  if ([...Object.values(requirements), ...Object.values(decisions), ...Object.values(threats)].some((value) => value.length === 0)) throw new Error("Phase 06 evidence mappings are incomplete");
  const edgeProbeMappings = Object.fromEntries(fixture.cases.filter((item) => /^E-\d{2}$/u.test(item.edge)).map((item) => [item.edge, [item.id]]));
  if (!exact(Object.keys(edgeProbeMappings), Array.from({ length: 23 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`))) throw new Error("Phase 06 edge mapping is incomplete");
  if (apiRows.some((item) => !item.reason || item.coverage.length === 0) || apiRows.some((item) => item.id === "PKG-01" && item.disposition !== "OPT-OUT")) throw new Error("Phase 06 API coverage is unsafe or incomplete");
  const aggregateEffects = comparisons.reduce((total, item) => ({ deploy: total.deploy + item.effects.deploy, observe: total.observe + item.effects.observe, attestation: total.attestation + item.effects.attestation, cases: total.cases + 1 }), { deploy: 0, observe: 0, attestation: 0, cases: 0 });
  const base = {
    version: 1 as const, phase: "06" as const, certificationProfile: "design" as const, verdict: "design-ready" as const, offlineVerdict: "passed" as const,
    checks: { referenceSet: "passed" as const, sourceContract: "available" as const, apiCoverage: "passed" as const, determinism: "passed" as const, redaction: "passed" as const },
    requirementMappings: requirements, decisionMappings: decisions, threatMappings: threats, apiCoverage: [...apiRows], edgeProbeMappings,
    uiMappings: { empty: ["P06-HOST-SURFACE-01"], loading: ["P06-HOST-SURFACE-01"], error: ["P06-HOST-SURFACE-01"], populated: ["P06-HOST-SURFACE-01"], partial: ["P06-HOST-SURFACE-01"], overflow: ["P06-HOST-SURFACE-01"], zero_one_many: ["P06-HOST-SURFACE-01"], long_text: ["P06-HOST-SURFACE-01"] },
    identities: { promotedCliSourceCommit: source.identity.sourceCommit.toLowerCase(), promotedCliLinuxSha256: source.identity.linuxSha256.toLowerCase(), sourceContractStatus: "available" as const, sourceContractLiveExecution: "not_observed" as const },
    aggregateEffects, caseComparisons: comparisons.map((item) => ({ ...item })),
    observations: [
      { provider: "deterministic_reference", status: "passed" as const, owner: "Phase 06", reasonCode: "IN_PROCESS_AUTHORITY_EXECUTED", selection: "unselected" as const },
      { provider: "source_contract", status: "passed" as const, owner: "Phase 06", reasonCode: "SOURCE_INSPECTION_ONLY", selection: "unselected" as const },
      ...LIVE_OBSERVATIONS.map((provider) => ({ provider, status: "not_observed" as const, owner: "Phase 7", reasonCode: "PHASE_07_LIVE_CERTIFICATION_REQUIRED", selection: "unselected" as const })),
    ],
  };
  const evidenceSha256 = phase06EvidenceSha256(base);
  return Phase06DesignEvidenceSchema.parse({ ...base, evidenceSha256, contentAddressedPath: `evidence/design/${evidenceSha256}.json` });
}

export function validatePhase06DesignEvidence(evidence: unknown): Phase06DesignEvidence {
  const parsed = Phase06DesignEvidenceSchema.parse(evidence);
  if (!safe(parsed) || phase06EvidenceSha256(parsed) !== parsed.evidenceSha256 || parsed.contentAddressedPath !== `evidence/design/${parsed.evidenceSha256}.json`) throw new Error("Phase 06 evidence digest, path, or redaction validation failed");
  if (!exact(Object.keys(parsed.requirementMappings), REQUIREMENTS) || !exact(Object.keys(parsed.decisionMappings), DECISIONS) || !exact(Object.keys(parsed.threatMappings), THREATS) || Object.values(parsed.requirementMappings).some((value) => value.length === 0) || Object.values(parsed.decisionMappings).some((value) => value.length === 0) || Object.values(parsed.threatMappings).some((value) => value.length === 0)) throw new Error("Phase 06 evidence mapping validation failed");
  if (parsed.observations.filter((item) => LIVE_OBSERVATIONS.includes(item.provider as (typeof LIVE_OBSERVATIONS)[number])).some((item) => item.status !== "not_observed" || item.owner !== "Phase 7") || parsed.identities.sourceContractLiveExecution !== "not_observed") throw new Error("Phase 06 live observation honesty validation failed");
  return parsed;
}
