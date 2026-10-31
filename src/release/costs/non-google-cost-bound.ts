import { canonicalJson } from "../../promotion/schema";
import { z } from "zod";
import { OPENAI_RESPONSES_PRICING_URL, type OpenAiResponsesPricingDocument } from "./official-sources";
import type { NonGoogleModelCostCatalogPort, OfficialPricingSourcePort } from "./production-catalog";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PositiveMicrosSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonnegativeMicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ModelSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}$/u);

/** Closed v2 accounting roles. They describe evidence semantics, rather than
 * reusing the historic v1 fixed provider/invoice enumeration. */
export const NON_GOOGLE_COST_ROLES = Object.freeze([
  "authoritative_native_usage",
  "documented_scoped_zero",
  "included_parent",
  "explicit_approved_shared_standing",
  "unknown_held",
] as const);
const CostRoleSchema = z.enum(NON_GOOGLE_COST_ROLES);
const CostTypeSchema = z.enum([
  "model_api_usage",
  "worker_sandbox_usage",
  "database_authority",
  "object_authority",
  "homelab_host",
  "funding_rail_fee",
  "contextvm_protocol",
  "publication_transport",
] as const);

export const OpenAiResponsesRateSnapshotSchema = z.object({
  version: z.literal(2),
  sourceUrl: z.literal(OPENAI_RESPONSES_PRICING_URL),
  sourceDocumentSha256: DigestSchema,
  sourceArtifactSha256: DigestSchema,
  quoteSha256: DigestSchema,
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  model: ModelSchema,
  currency: z.literal("USD"),
  inputMicrosPerMillion: PositiveMicrosSchema,
  cachedInputMicrosPerMillion: PositiveMicrosSchema,
  outputMicrosPerMillion: PositiveMicrosSchema,
  cacheWriteMicrosPerMillion: PositiveMicrosSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.freshUntilMs <= value.observedAtMs || value.sourceArtifactSha256 !== value.sourceDocumentSha256) context.addIssue({ code: "custom", message: "OPENAI_PRICE_SOURCE_STALE" });
});
export type OpenAiResponsesRateSnapshot = z.infer<typeof OpenAiResponsesRateSnapshotSchema>;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Reasoning is a subset of output and is recorded as evidence only. */
  reasoningTokens: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.cachedInputTokens + value.cacheWriteTokens > value.inputTokens) context.addIssue({ code: "custom", message: "OPENAI_USAGE_INPUT_PARTITION_INVALID" });
  if (value.reasoningTokens > value.outputTokens) context.addIssue({ code: "custom", message: "OPENAI_USAGE_OUTPUT_PARTITION_INVALID" });
});
export type OpenAiResponsesUsage = z.infer<typeof UsageSchema>;

/** Evidence is mandatory even when a fact is held.  It records precisely what
 * was (or was not) established; callers cannot turn an unbound quote into an
 * available accounting fact by choosing a provider label or clock. */
const CostEvidenceSchema = z.object({
  artifactReference: z.string().regex(/^evidence:[a-z0-9._:-]{3,255}$/u),
  sourceKind: z.enum(["official_openai_model", "official_modal_pricing", "official_fly_pricing", "contextvm_transport_policy", "operator_homelab_policy", "operator_approval_policy", "funding_fee_contract", "publication_contract", "unknown"]),
  sourceUrl: z.string().url().max(2048),
  sourceArtifactSha256: DigestSchema,
  sourceDocumentSha256: DigestSchema,
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  currency: z.literal("USD"),
  fx: z.object({ kind: z.literal("native_usd"), sourceDocumentSha256: DigestSchema, numerator: z.literal(1), denominator: z.literal(1) }).strict(),
  unit: z.string().min(3).max(128),
  precision: z.number().int().min(0).max(6),
  scope: z.string().min(16).max(1024),
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
}).strict().superRefine((value, context) => {
  if (value.freshUntilMs <= value.observedAtMs) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_EVIDENCE_STALE" });
  if (value.fx.sourceDocumentSha256 !== value.sourceDocumentSha256) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_FX_UNBOUND" });
});
const NativeFactSchema = z.object({ role: z.literal("authoritative_native_usage"), costType: CostTypeSchema, provider: z.literal("openai_responses"), status: z.literal("available"), rate: OpenAiResponsesRateSnapshotSchema, evidence: CostEvidenceSchema }).strict().superRefine((value, context) => {
  if (value.evidence.sourceUrl !== value.rate.sourceUrl || value.evidence.sourceArtifactSha256 !== value.rate.sourceArtifactSha256 || value.evidence.sourceDocumentSha256 !== value.rate.sourceDocumentSha256 || value.evidence.observedAtMs !== value.rate.observedAtMs || value.evidence.freshUntilMs !== value.rate.freshUntilMs) context.addIssue({ code: "custom", message: "NON_GOOGLE_COST_NATIVE_EVIDENCE_UNBOUND" });
});
const ScopedZeroFactSchema = z.object({ role: z.literal("documented_scoped_zero"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), documentedScope: z.string().min(16).max(1024), evidence: CostEvidenceSchema }).strict();
const IncludedParentFactSchema = z.object({ role: z.literal("included_parent"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), parentCostType: z.string().min(3).max(128), evidence: CostEvidenceSchema }).strict();
const SharedStandingFactSchema = z.object({ role: z.literal("explicit_approved_shared_standing"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("available"), approvalReference: z.string().min(3).max(128), evidence: CostEvidenceSchema }).strict();
const HeldFactSchema = z.object({ role: z.literal("unknown_held"), costType: CostTypeSchema, provider: z.string().min(3).max(128), status: z.literal("held"), holdReason: z.string().min(8).max(1024), evidence: CostEvidenceSchema }).strict();
export const NonGoogleCostFactSchema = z.discriminatedUnion("role", [NativeFactSchema, ScopedZeroFactSchema, IncludedParentFactSchema, SharedStandingFactSchema, HeldFactSchema]);
export type NonGoogleCostFact = z.infer<typeof NonGoogleCostFactSchema>;
export type CostEvidenceArtifactResolver = Readonly<{ read(reference: string): Promise<Readonly<{ sourceUrl: string; bytes: Uint8Array }>> }>;

/** The successor graph deliberately has no relation to the historic sixteen
 * provider IDs.  These are the only certification suites a later native
 * factory may satisfy, and Plan 67 represents them as explicit requirements
 * while their backends remain unavailable. */
const SuccessorSuiteSchema = z.enum([
  "admission", "telemetry", "chaos", "restore", "security-host", "supply-chain",
  "contextvm-payment-model", "publication",
]);
const GraphRevisionSchema = z.literal("non-google-v1");
const RoleIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u);
const EffectIdentifierSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/u);
const ModulePathSchema = z.string().min(1).max(256);
const ExportNameSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{2,127}$/u);
const PurposeSchema = z.string().regex(/^[a-z][a-z0-9-]{2,127}$/u);
const NamespaceSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}:[a-z][a-z0-9-]{1,63}$/u);
const LEGACY_SUCCESSOR_ROLE_IDS = new Set<string>([
  "cloud_run", "gcs", "collector", "cloud_sql_postgres", "modal", "fly", "contextvm",
  "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli",
  "upload", "owner_relay", "attestation_relay",
]);

const SuccessorRoleSchema = z.object({
  roleId: RoleIdentifierSchema,
  effectId: EffectIdentifierSchema,
  costComponentId: RoleIdentifierSchema,
  suite: SuccessorSuiteSchema,
  constructor: z.object({
    modulePath: ModulePathSchema,
    exportName: ExportNameSchema,
    purpose: PurposeSchema,
    namespace: NamespaceSchema,
  }).strict(),
  /** `native` identifies a reviewed concrete constructor seam; it is never a
   * claim that the constructor was run. `unconstructed` remains an explicit
   * no-effect hold until plans 68–70 supply and prove it. */
  construction: z.enum(["native", "unconstructed"]),
}).strict();
type SuccessorRole = z.infer<typeof SuccessorRoleSchema>;
export type SuccessorGraphRole = SuccessorRole;

/** Closed, product-owned provenance. `unconstructed` references only an
 * existing checkpoint seam and is never authority to construct that backend. */
const PRODUCT_SUCCESSOR_ROLE_REGISTRY = Object.freeze([
  { roleId: "model.openai-responses", effectId: "model.generate", costComponentId: "model.api-usage", suite: "contextvm-payment-model", constructor: { modulePath: "src/release/deployment/openai-responses-client.ts", exportName: "createOpenAiResponsesClient", purpose: "openai-responses", namespace: "openai:responses" }, construction: "native" },
  { roleId: "worker.modal", effectId: "worker.start", costComponentId: "worker.modal-seconds", suite: "admission", constructor: { modulePath: "src/release/native/modal.ts", exportName: "createModalLiveWorkerProvider", purpose: "worker-sandbox", namespace: "modal:sandbox" }, construction: "unconstructed" },
  { roleId: "object.postgres-bytea", effectId: "object.seal", costComponentId: "object.postgres-storage", suite: "restore", constructor: { modulePath: "src/continuity/postgres-bytea-object-store.ts", exportName: "PostgresByteaObjectStoreAdapter", purpose: "immutable-objects", namespace: "postgres:objects" }, construction: "unconstructed" },
  { roleId: "telemetry.otlp", effectId: "telemetry.record", costComponentId: "telemetry.otlp", suite: "telemetry", constructor: { modulePath: "src/telemetry/redaction.ts", exportName: "redactLifecycleObservation", purpose: "telemetry", namespace: "otlp:collector" }, construction: "unconstructed" },
  { roleId: "chaos.fault-harness", effectId: "chaos.exercise", costComponentId: "chaos.harness", suite: "chaos", constructor: { modulePath: "src/resilience/fault-harness.ts", exportName: "runFaultScenario", purpose: "chaos", namespace: "fault:harness" }, construction: "unconstructed" },
  { roleId: "security.host", effectId: "security.inspect", costComponentId: "security.host", suite: "security-host", constructor: { modulePath: "src/certification/live/security-host.ts", exportName: "runLiveSecurityHostCertification", purpose: "security-host", namespace: "security:host" }, construction: "unconstructed" },
  { roleId: "supply.chain", effectId: "supply.verify", costComponentId: "supply.chain", suite: "supply-chain", constructor: { modulePath: "src/certification/supply-chain.ts", exportName: "verifySupplyChainCertification", purpose: "supply-chain", namespace: "supply:chain" }, construction: "unconstructed" },
  { roleId: "publication.napplet", effectId: "publication.verify", costComponentId: "publication.transport", suite: "publication", constructor: { modulePath: "src/publication/contracts.ts", exportName: "PublicationEffectIntentSchema", purpose: "publication", namespace: "napplet:publication" }, construction: "unconstructed" },
  { roleId: "worker.fly", effectId: "worker.reclaim", costComponentId: "worker.fly-seconds", suite: "admission", constructor: { modulePath: "src/release/native/fly.ts", exportName: "createFlyLiveWorkerProvider", purpose: "worker-sandbox", namespace: "fly:machines" }, construction: "unconstructed" },
] as const satisfies readonly SuccessorRole[]);

export type SuccessorGraphInventory = Readonly<{
  graphRevision: "non-google-v1";
  candidateSha256: string;
  topologySha256: string;
  roles: readonly (SuccessorRole & Readonly<{ constructorSha256: string }>)[];
  inventorySha256: string;
}>;

/** Rebuilds the graph from product code, rather than accepting a caller's
 * role list as a provenance authority at the controller boundary. */
export async function createProductSuccessorGraphInventory(input: Readonly<{
  candidateSha256: string;
  topologySha256: string;
}>): Promise<SuccessorGraphInventory> {
  return createSuccessorGraphInventory({
    graphRevision: "non-google-v1",
    candidateSha256: input.candidateSha256,
    topologySha256: input.topologySha256,
    roles: PRODUCT_SUCCESSOR_ROLE_REGISTRY,
  });
}

const SuccessorCostDispositionSchema = z.enum([
  "authoritative_native_usage",
  "documented_scoped_zero",
  "included_parent",
  "explicit_approved_shared_standing",
  "unknown_held",
]);
const SuccessorNativeModelUsageIntentSchema = z.object({
  maximumInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumChargeMicros: PositiveMicrosSchema,
}).strict();
const SuccessorRoleCostFactSchema = z.object({
  roleId: RoleIdentifierSchema,
  effectId: EffectIdentifierSchema,
  costComponentId: RoleIdentifierSchema,
  constructorSha256: DigestSchema,
  disposition: SuccessorCostDispositionSchema,
  status: z.enum(["available", "held"]),
  provider: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u),
  holdReason: z.string().min(8).max(1024).optional(),
  rate: OpenAiResponsesRateSnapshotSchema.optional(),
  usageIntent: SuccessorNativeModelUsageIntentSchema.optional(),
  evidence: CostEvidenceSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "held") !== (value.disposition === "unknown_held")) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_COST_STATUS_INVALID" });
  if (value.status === "held" && value.holdReason === undefined) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_COST_HOLD_REASON_REQUIRED" });
  if (value.status === "available" && value.holdReason !== undefined) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_COST_HOLD_REASON_INVALID" });
  const isModel = value.roleId === "model.openai-responses";
  if (isModel && value.status === "available" && (value.rate === undefined || value.usageIntent === undefined)) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_MODEL_RATE_REQUIRED" });
  if (!isModel && (value.rate !== undefined || value.usageIntent !== undefined)) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_MODEL_RATE_REUSE_REJECTED" });
  if (isModel && value.status === "available" && (value.evidence.sourceKind !== "official_openai_model" || value.evidence.sourceUrl !== OPENAI_RESPONSES_PRICING_URL || value.rate === undefined
    || value.rate.sourceUrl !== value.evidence.sourceUrl || value.rate.sourceArtifactSha256 !== value.evidence.sourceArtifactSha256
    || value.rate.sourceDocumentSha256 !== value.evidence.sourceDocumentSha256 || value.rate.observedAtMs !== value.evidence.observedAtMs
    || value.rate.freshUntilMs !== value.evidence.freshUntilMs)) context.addIssue({ code: "custom", message: "SUCCESSOR_GRAPH_MODEL_RATE_EVIDENCE_UNBOUND" });
});
export type SuccessorRoleCostFact = z.infer<typeof SuccessorRoleCostFactSchema>;

export type SuccessorRoleCostBound = Readonly<{
  schemaVersion: "non-google-successor-role-cost-v1";
  graphRevision: "non-google-v1";
  candidateSha256: string;
  topologySha256: string;
  inventorySha256: string;
  boundSha256: string;
  facts: readonly SuccessorRoleCostFact[];
  heldRoleIds: readonly string[];
}>;
const WorkerPricingSnapshotSchema = z.object({
  sourceId: z.string().min(3).max(128),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024, "SUCCESSOR_GRAPH_WORKER_SOURCE_BYTES_REJECTED"),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
  quotes: z.array(z.object({
    provider: z.enum(["modal", "fly"]),
    componentId: z.string().min(3).max(128),
    skuId: z.string().min(3).max(128),
    region: z.string().min(1).max(128),
    currency: z.literal("USD"),
    unit: z.string().min(1).max(128),
    priceMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(8),
}).strict();

function freeze<T>(value: T): T { return Object.freeze(value); }
async function sha256(value: Uint8Array): Promise<string> { return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer)).toString("hex"); }
async function hashCanonical(value: unknown): Promise<string> { return sha256(new TextEncoder().encode(canonicalJson(value))); }
function ceilDiv(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function safeMicros(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OPENAI_USAGE_COST_OVERFLOW"); return Number(value); }
function charge(tokens: number, microsPerMillion: number): number { return safeMicros(ceilDiv(BigInt(tokens) * BigInt(microsPerMillion), 1_000_000n)); }

/** Builds a disjoint, candidate-bound successor inventory.  It accepts only
 * repository constructor provenance, never configuration-provided provider
 * labels or transport maps.  The result is a preparation record, not a
 * factory or an authority to resolve credentials, create clients, or issue a
 * request. */
export async function createSuccessorGraphInventory(input: Readonly<{
  graphRevision: "non-google-v1";
  candidateSha256: string;
  topologySha256: string;
  roles: readonly SuccessorRole[];
}>): Promise<SuccessorGraphInventory> {
  if (GraphRevisionSchema.parse(input.graphRevision) !== "non-google-v1") throw new Error("SUCCESSOR_GRAPH_REVISION_INVALID");
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const topologySha256 = DigestSchema.parse(input.topologySha256);
  const roles = input.roles.map((candidate) => SuccessorRoleSchema.parse(candidate));
  if (roles.length === 0 || new Set(roles.map((role) => role.roleId)).size !== roles.length) throw new Error("SUCCESSOR_GRAPH_ROLE_COVERAGE_REQUIRED");
  if (new Set(roles.map((role) => role.effectId)).size !== roles.length) throw new Error("SUCCESSOR_GRAPH_EFFECT_DUPLICATE");
  if (new Set(roles.map((role) => role.costComponentId)).size !== roles.length) throw new Error("SUCCESSOR_GRAPH_COST_COMPONENT_DUPLICATE");
  for (const role of roles) {
    if (LEGACY_SUCCESSOR_ROLE_IDS.has(role.roleId)) throw new Error("SUCCESSOR_GRAPH_LEGACY_ROLE_REJECTED");
    const approved = PRODUCT_SUCCESSOR_ROLE_REGISTRY.find((entry) => entry.roleId === role.roleId);
    if (!approved || canonicalJson(role) !== canonicalJson(approved)) throw new Error("SUCCESSOR_GRAPH_CONSTRUCTOR_PROVENANCE_REQUIRED");
  }
  if (roles.length !== PRODUCT_SUCCESSOR_ROLE_REGISTRY.length) throw new Error("SUCCESSOR_GRAPH_ROLE_COVERAGE_REQUIRED");
  const boundRoles = await Promise.all(roles.map(async (role) => Object.freeze({
    ...role,
    constructorSha256: await hashCanonical({
      modulePath: role.constructor.modulePath,
      exportName: role.constructor.exportName,
      purpose: role.constructor.purpose,
      namespace: role.constructor.namespace,
    }),
  })));
  const inventorySha256 = await hashCanonical({ graphRevision: "non-google-v1", candidateSha256, topologySha256, roles: boundRoles });
  return freeze({ graphRevision: "non-google-v1" as const, candidateSha256, topologySha256, roles: freeze(boundRoles), inventorySha256 });
}

/** Captures a bounded public Modal/Fly source as the role's own evidence
 * producer. The result intentionally remains held: a public price cannot
 * establish the selected placement, account arrangement, availability or
 * native backend. It therefore cannot be mistaken for an OpenAI rate or a
 * production authorization line. */
export async function createHeldSuccessorWorkerCostFact(input: Readonly<{
  graph: SuccessorGraphInventory;
  roleId: "worker.modal" | "worker.fly";
  source: OfficialPricingSourcePort;
}>): Promise<SuccessorRoleCostFact> {
  const role = input.graph.roles.find((candidate) => candidate.roleId === input.roleId);
  if (!role) throw new Error("SUCCESSOR_GRAPH_WORKER_ROLE_REQUIRED");
  const provider = input.roleId === "worker.modal" ? "modal" : "fly";
  const snapshot = WorkerPricingSnapshotSchema.parse(await input.source.readOfficialPricing({ provider }));
  if (snapshot.freshUntilMs <= snapshot.observedAtMs
    || snapshot.quotes.length !== 1
    || snapshot.quotes[0]?.provider !== provider
    || snapshot.quotes[0]?.currency !== "USD"
    || snapshot.quotes[0]?.unit !== "worker-100-seconds") {
    throw new Error("SUCCESSOR_GRAPH_WORKER_SOURCE_INVALID");
  }
  const sourceDocumentSha256 = await sha256(snapshot.bytes);
  const sourceUrl = provider === "modal" ? "https://modal.com/pricing" : "https://docs.fly.io/about/pricing";
  return SuccessorRoleCostFactSchema.parse({
    roleId: role.roleId,
    effectId: role.effectId,
    costComponentId: role.costComponentId,
    constructorSha256: role.constructorSha256,
    disposition: "unknown_held",
    status: "held",
    provider,
    holdReason: "official price captured but selected placement, account contract and native backend remain unverified",
    evidence: {
      artifactReference: `evidence:official-${provider}-worker:${sourceDocumentSha256}`,
      sourceKind: provider === "modal" ? "official_modal_pricing" : "official_fly_pricing",
      sourceUrl,
      sourceArtifactSha256: sourceDocumentSha256,
      sourceDocumentSha256,
      observedAtMs: snapshot.observedAtMs,
      freshUntilMs: snapshot.freshUntilMs,
      currency: "USD",
      fx: { kind: "native_usd", sourceDocumentSha256, numerator: 1, denominator: 1 },
      unit: snapshot.quotes[0].unit,
      precision: 6,
      scope: `${provider} worker candidate source only; no placement or account authority`,
      candidateSha256: input.graph.candidateSha256,
      topologySha256: input.graph.topologySha256,
    },
  });
}

/** Links a concrete successor role/effect to its own source-bound cost fact.
 * It is intentionally incapable of producing a maximum charge.  A later
 * native factory must supply all backends and the precise pricing/usage
 * adapters; until then, every held component blocks preapproval. */
export async function createSuccessorRoleCostBound(input: Readonly<{
  graph: SuccessorGraphInventory;
  facts: readonly SuccessorRoleCostFact[];
  modelCatalog?: NonGoogleModelCostCatalogPort;
}>): Promise<SuccessorRoleCostBound> {
  const graph = input.graph;
  if (GraphRevisionSchema.parse(graph.graphRevision) !== "non-google-v1") throw new Error("SUCCESSOR_GRAPH_REVISION_INVALID");
  const facts = input.facts.map((fact) => SuccessorRoleCostFactSchema.parse(fact));
  if (facts.length !== graph.roles.length || new Set(facts.map((fact) => fact.roleId)).size !== graph.roles.length) throw new Error("SUCCESSOR_GRAPH_COST_COVERAGE_REQUIRED");
  const byRole = new Map(graph.roles.map((role) => [role.roleId, role]));
  for (const fact of facts) {
    const role = byRole.get(fact.roleId);
    if (!role || role.effectId !== fact.effectId || role.costComponentId !== fact.costComponentId || role.constructorSha256 !== fact.constructorSha256) throw new Error("SUCCESSOR_GRAPH_COST_BINDING_INVALID");
    if (fact.evidence.candidateSha256 !== graph.candidateSha256 || fact.evidence.topologySha256 !== graph.topologySha256) throw new Error("SUCCESSOR_GRAPH_COST_SCOPE_INVALID");
    if (fact.provider === "openai_responses" && role.roleId !== "model.openai-responses") throw new Error("SUCCESSOR_GRAPH_MODEL_RATE_REUSE_REJECTED");
    if (role.roleId === "model.openai-responses" && fact.status === "available" && (fact.provider !== "openai_responses" || fact.disposition !== "authoritative_native_usage")) throw new Error("SUCCESSOR_GRAPH_MODEL_RATE_REUSE_REJECTED");
    if (role.roleId === "model.openai-responses" && fact.status === "available") {
      const rate = OpenAiResponsesRateSnapshotSchema.parse(fact.rate);
      const usageIntent = SuccessorNativeModelUsageIntentSchema.parse(fact.usageIntent);
      if (!input.modelCatalog) throw new Error("SUCCESSOR_GRAPH_MODEL_CATALOG_REQUIRED");
      const trustedRate = OpenAiResponsesRateSnapshotSchema.parse(await input.modelCatalog.readModelRate());
      if (canonicalJson(rate) !== canonicalJson(trustedRate)) throw new Error("SUCCESSOR_GRAPH_MODEL_RATE_UNBOUND");
      const maximum = priceOpenAiResponsesUsage({ rate, usage: { inputTokens: usageIntent.maximumInputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: usageIntent.maximumOutputTokens, reasoningTokens: 0 } });
      if (maximum.status !== "priced" || maximum.costMicros > usageIntent.maximumChargeMicros) throw new Error("SUCCESSOR_GRAPH_MODEL_MAXIMUM_INVALID");
    }
    /* Plan 67 can capture a non-model source but not turn it into a price or
     * a free resource. Plans 68–70 must add the matching native usage or
     * approved-standing consumer before any non-model role can be available. */
    if (role.roleId !== "model.openai-responses" && fact.status === "available") throw new Error("SUCCESSOR_GRAPH_NONMODEL_AVAILABILITY_UNIMPLEMENTED");
  }
  const heldRoleIds = facts.filter((fact) => fact.status === "held").map((fact) => fact.roleId);
  const boundSha256 = await hashCanonical({
    schemaVersion: "non-google-successor-role-cost-v1",
    graphRevision: "non-google-v1",
    candidateSha256: graph.candidateSha256,
    topologySha256: graph.topologySha256,
    inventorySha256: graph.inventorySha256,
    facts,
  });
  return freeze({
    schemaVersion: "non-google-successor-role-cost-v1" as const,
    graphRevision: "non-google-v1" as const,
    candidateSha256: graph.candidateSha256,
    topologySha256: graph.topologySha256,
    inventorySha256: graph.inventorySha256,
    boundSha256,
    facts: freeze(facts),
    heldRoleIds: freeze(heldRoleIds),
  });
}

/** Plan 67's sole normal-path result. It checks canonical graph bytes and
 * returns a typed throw before any credential/client/provider boundary. */
export async function assertSuccessorGraphPreapprovalHeld(input: Readonly<{
  graph: SuccessorGraphInventory;
  bound: SuccessorRoleCostBound;
  nowMs: number;
  evidence: CostEvidenceArtifactResolver;
}>): Promise<never> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 1) throw new Error("SUCCESSOR_GRAPH_CLOCK_INVALID");
  if (input.bound.graphRevision !== input.graph.graphRevision || input.bound.candidateSha256 !== input.graph.candidateSha256 || input.bound.topologySha256 !== input.graph.topologySha256 || input.bound.inventorySha256 !== input.graph.inventorySha256) throw new Error("SUCCESSOR_GRAPH_BINDING_INVALID");
  for (const fact of input.bound.facts) {
    if (fact.evidence.freshUntilMs <= input.nowMs) throw new Error("SUCCESSOR_GRAPH_COST_STALE");
    const artifact = await input.evidence.read(fact.evidence.artifactReference);
    if (!(artifact.bytes instanceof Uint8Array)
      || artifact.sourceUrl !== fact.evidence.sourceUrl
      || await sha256(artifact.bytes) !== fact.evidence.sourceArtifactSha256
      || fact.evidence.sourceArtifactSha256 !== fact.evidence.sourceDocumentSha256) {
      throw new Error("SUCCESSOR_GRAPH_COST_EVIDENCE_INVALID");
    }
  }
  const missingSuites = SuccessorSuiteSchema.options.filter((suite) => !input.graph.roles.some((role) => role.suite === suite));
  if (missingSuites.length > 0) throw new Error("SUCCESSOR_GRAPH_SUITE_BACKEND_MISSING");
  if (input.graph.roles.some((role) => role.construction !== "native")) throw new Error("SUCCESSOR_GRAPH_BACKEND_UNCONSTRUCTED");
  if (input.bound.heldRoleIds.length > 0) throw new Error("SUCCESSOR_GRAPH_COST_HELD");
  throw new Error("SUCCESSOR_GRAPH_ARCHITECTURE_GUARD_ACTIVE");
}

const CapturedPricingDocumentSchema = z.object({
  sourceUrl: z.literal(OPENAI_RESPONSES_PRICING_URL),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024, "OPENAI_PRICE_SOURCE_BYTES_REJECTED"),
  observedAtMs: z.number().int().positive(),
  freshUntilMs: z.number().int().positive(),
}).strict();
const MoneyPerMillionSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/u);
function micros(value: string): number {
  const [whole, fraction = ""] = MoneyPerMillionSchema.parse(value).split(".");
  const parsed = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("OPENAI_PRICE_SOURCE_PRECISION_REJECTED");
  return Number(parsed);
}
const MAX_OPENAI_MODEL_NODES = 12_000;
const MAX_OPENAI_MODEL_DEPTH = 128;
const MAX_OPENAI_MODEL_TEXT_BYTES = 2 * 1024 * 1024;
const HtmlVoidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const OpenAiPriceGroupClass = "flex flex-col gap-2 md:flex-row";
const OpenAiPriceCardClass = "flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4";
const OpenAiPriceValueClass = "text-2xl font-semibold";
const OpenAiPrimaryPricingPath = [
  { childIndex: 1, className: OpenAiPriceGroupClass },
  { childIndex: 1, className: "flex flex-col gap-4" },
  { childIndex: 1, className: "flex flex-1 flex-col gap-4" },
  { childIndex: 4, className: "flex flex-col gap-4 lg:flex-row" },
  { childIndex: 1, className: "flex flex-col gap-8" },
  { childIndex: 0, className: "relative mx-4 flex flex-col gap-4 overflow-hidden px-4 pt-8 pb-10 sm:mx-8 md:mx-auto md:w-full md:max-w-6xl md:px-12 xl:px-4" },
  { childIndex: 0, className: "relative" },
] as const;
type OpenAiModelElement = {
  readonly parent?: OpenAiModelElement;
  readonly children: OpenAiModelElement[];
  readonly directText: string[];
  readonly tagName: string;
  readonly className: string;
  readonly modelIdentity?: string;
  readonly componentExport?: string;
  readonly componentUrl?: string;
  readonly props?: string;
  readonly modelView: boolean;
};
type OpenAiPriceCard = Readonly<{ label: "Input" | "Cached input" | "Output"; value: string }>;

function openAiModelText(element: OpenAiModelElement, cache: Map<OpenAiModelElement, string>): string {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const text = `${element.directText.join("")} ${element.children.map(child => openAiModelText(child, cache)).join(" ")}`.replace(/\s+/gu, " ").trim();
  cache.set(element, text);
  return text;
}
function openAiModelDescendant(element: OpenAiModelElement, ancestor: OpenAiModelElement): boolean {
  for (let current: OpenAiModelElement | undefined = element.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
}
function openAiNestedModelContainer(element: OpenAiModelElement): boolean {
  return element.modelView || ((element.tagName === "article" || element.tagName === "section") && element.modelIdentity !== undefined);
}
function openAiModelFamily(model: string): string {
  const matched = /^([a-z0-9][a-z0-9.-]*)-\d{4}-\d{2}-\d{2}$/u.exec(model);
  if (!matched?.[1]) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  return matched[1];
}
function decodeOpenAiModelViewProps(value: string): unknown {
  if (/&(?!quot;|amp;|lt;|gt;|#39;)/iu.test(value)) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  return JSON.parse(value.replace(/&(quot|amp|lt|gt|#39);/giu, (_all, entity: string) => ({ quot: "\"", amp: "&", lt: "<", gt: ">", "#39": "'" })[entity.toLowerCase()] ?? ""));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function openAiModelViewFamily(element: OpenAiModelElement): string | undefined {
  if (element.componentExport !== "ModelView" || element.componentUrl === undefined || !/^\/_astro\/ModelView\.react\.[A-Za-z0-9_-]+\.js(?:\?[^\s]*)?$/u.test(element.componentUrl) || element.props === undefined) return undefined;
  try {
    const props = decodeOpenAiModelViewProps(element.props);
    const modelName = isRecord(props) ? props.modelName : undefined;
    return Array.isArray(modelName) && modelName.length === 2 && modelName[0] === 0 && typeof modelName[1] === "string" && /^[a-z0-9][a-z0-9.-]*$/u.test(modelName[1]) ? modelName[1] : undefined;
  } catch { return undefined; }
}
function openAiPriceCard(element: OpenAiModelElement, text: Map<OpenAiModelElement, string>): OpenAiPriceCard | undefined {
  if (element.className !== OpenAiPriceCardClass || element.children.length !== 2 || element.children[0]!.className !== "" || element.children[1]!.className !== OpenAiPriceValueClass) return undefined;
  const label = openAiModelText(element.children[0]!, text);
  const value = /^\$([0-9]+(?:\.[0-9]{1,6})?)$/u.exec(openAiModelText(element.children[1]!, text))?.[1];
  if ((label !== "Input" && label !== "Cached input" && label !== "Output") || value === undefined) return undefined;
  return { label, value };
}
function openAiPriceGroup(element: OpenAiModelElement, text: Map<OpenAiModelElement, string>): readonly [OpenAiPriceCard, OpenAiPriceCard, OpenAiPriceCard] | undefined {
  if (element.className !== OpenAiPriceGroupClass || element.children.length !== 3) return undefined;
  const cards = element.children.map(child => openAiPriceCard(child, text));
  if (cards.some(card => card === undefined)) return undefined;
  const [input, cached, output] = cards as [OpenAiPriceCard, OpenAiPriceCard, OpenAiPriceCard];
  return input.label === "Input" && cached.label === "Cached input" && output.label === "Output" ? [input, cached, output] : undefined;
}
function openAiApprovedPrimaryPricingPath(group: OpenAiModelElement, modelView: OpenAiModelElement): boolean {
  let current: OpenAiModelElement | undefined = group;
  for (const expected of OpenAiPrimaryPricingPath) {
    if (!current || current.tagName !== "div" || current.className !== expected.className || !current.parent || current.parent.children.indexOf(current) !== expected.childIndex) return false;
    current = current.parent;
  }
  return current === modelView;
}
/** Parse the actual ModelView tree rather than scanning for an early closing
 * tag. A model can only receive rates from its one balanced container and its
 * one direct three-card group; any nested model container holds the quote. */
async function parseOfficialHtml(bytes: Uint8Array, model: string) {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^\s*<!doctype html|^\s*<html\b/iu.test(html) || /\u0000/u.test(html)) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const stack: OpenAiModelElement[] = [];
  const elements: OpenAiModelElement[] = [];
  const encoder = new TextEncoder();
  let textBytes = 0;
  try {
    const parsed = new HTMLRewriter().on("*", {
      element(element) {
        const parent = stack.at(-1);
        const tagName = element.tagName.toLowerCase();
        const componentExport = element.getAttribute("component-export");
        const componentUrl = element.getAttribute("component-url");
        const current: OpenAiModelElement = {
          ...(parent ? { parent } : {}), children: [], directText: [], tagName, className: element.getAttribute("class") ?? "",
          ...(element.getAttribute("data-openai-model") === null ? {} : { modelIdentity: element.getAttribute("data-openai-model")! }),
          ...(componentExport === null ? {} : { componentExport }), ...(componentUrl === null ? {} : { componentUrl }),
          ...(element.getAttribute("props") === null ? {} : { props: element.getAttribute("props")! }),
          modelView: tagName === "astro-island" && (componentExport === "ModelView" || componentUrl?.includes("ModelView") === true),
        };
        if (parent) parent.children.push(current);
        elements.push(current);
        if (elements.length > MAX_OPENAI_MODEL_NODES || stack.length >= MAX_OPENAI_MODEL_DEPTH) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
        if (!HtmlVoidElements.has(tagName)) {
          stack.push(current);
          element.onEndTag(() => { if (stack.pop() !== current) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); });
        }
      },
      text(chunk) {
        const current = stack.at(-1);
        if (!current || !chunk.text) return;
        textBytes += encoder.encode(chunk.text).byteLength;
        if (textBytes > MAX_OPENAI_MODEL_TEXT_BYTES) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
        current.directText.push(chunk.text);
      },
    }).transform(new Response(html));
    await parsed.text();
  } catch { throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); }
  if (stack.length !== 0) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const text = new Map<OpenAiModelElement, string>();
  const modelViews = elements.filter(element => element.modelView && openAiModelViewFamily(element) !== undefined);
  if (modelViews.length === 0) throw new Error("OPENAI_PRICE_SOURCE_MODEL_HELD");
  const selectedFamily = openAiModelFamily(model);
  const candidates = modelViews.filter(element => openAiModelViewFamily(element) === selectedFamily);
  if (candidates.length !== 1) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const container = candidates[0]!;
  const modelCodes = elements.filter(element => element.tagName === "code" && openAiModelDescendant(element, container) && ModelSchema.safeParse(openAiModelText(element, text)).success).map(element => openAiModelText(element, text));
  if (modelCodes.length !== 1 || modelCodes[0] !== model) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  if (elements.some(element => element !== container && openAiNestedModelContainer(element) && openAiModelDescendant(element, container))) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const groups = elements.filter(element => openAiModelDescendant(element, container) && openAiPriceGroup(element, text) !== undefined && openAiApprovedPrimaryPricingPath(element, container));
  if (groups.length !== 1) throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const [input, cached, output] = openAiPriceGroup(groups[0]!, text)!;
  return { currency: "USD" as const, inputMicrosPerMillion: micros(input.value), cachedInputMicrosPerMillion: micros(cached.value), outputMicrosPerMillion: micros(output.value) };
}
async function parseCapturedPrices(document: OpenAiResponsesPricingDocument, model: string) {
  const parsed = CapturedPricingDocumentSchema.parse(document);
  const selectedModel = ModelSchema.parse(model);
  try { return { document: parsed, ...await parseOfficialHtml(parsed.bytes, selectedModel) }; }
  catch (error) { if (error instanceof Error && /OPENAI_PRICE_SOURCE_(?:MODEL_HELD|PARSER_DRIFT|PRECISION_REJECTED)/u.test(error.message)) throw error; throw new Error("OPENAI_PRICE_SOURCE_PARSER_DRIFT"); }
}

/** A quote is derived only from a bounded fixed-origin capture. The parser is
 * deliberately closed: an OpenAI document shape change holds the candidate
 * instead of accepting caller-selected rates. */
export async function createOpenAiResponsesRateSnapshot(input: Readonly<{ document: OpenAiResponsesPricingDocument; model: string }>): Promise<OpenAiResponsesRateSnapshot> {
  const parsed = await parseCapturedPrices(input.document, input.model);
  if (parsed.document.freshUntilMs <= parsed.document.observedAtMs) throw new Error("OPENAI_PRICE_SOURCE_STALE");
  const sourceDocumentSha256 = await sha256(parsed.document.bytes);
  const quoteSha256 = await hashCanonical({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion });
  return freeze(OpenAiResponsesRateSnapshotSchema.parse({ version: 2, sourceUrl: parsed.document.sourceUrl, sourceDocumentSha256, sourceArtifactSha256: sourceDocumentSha256, quoteSha256, observedAtMs: parsed.document.observedAtMs, freshUntilMs: parsed.document.freshUntilMs, model: input.model, currency: parsed.currency, inputMicrosPerMillion: parsed.inputMicrosPerMillion, cachedInputMicrosPerMillion: parsed.cachedInputMicrosPerMillion, outputMicrosPerMillion: parsed.outputMicrosPerMillion }));
}

export function priceOpenAiResponsesUsage(input: Readonly<{ rate: OpenAiResponsesRateSnapshot; usage: OpenAiResponsesUsage }>): Readonly<{ status: "priced"; costMicros: number; inputChargeMicros: number; cachedInputChargeMicros: number; cacheWriteChargeMicros: number; outputChargeMicros: number }> | Readonly<{ status: "held"; reason: "cache_write_rate_unknown" }> {
  const rate = OpenAiResponsesRateSnapshotSchema.parse(input.rate);
  const usage = UsageSchema.parse(input.usage);
  if (usage.cacheWriteTokens > 0 && rate.cacheWriteMicrosPerMillion === undefined) return freeze({ status: "held" as const, reason: "cache_write_rate_unknown" as const });
  const inputChargeMicros = charge(usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens, rate.inputMicrosPerMillion);
  const cachedInputChargeMicros = charge(usage.cachedInputTokens, rate.cachedInputMicrosPerMillion);
  const cacheWriteChargeMicros = charge(usage.cacheWriteTokens, rate.cacheWriteMicrosPerMillion ?? 1);
  /* Output already includes reasoning tokens according to the Responses API. */
  const outputChargeMicros = charge(usage.outputTokens, rate.outputMicrosPerMillion);
  return freeze({ status: "priced" as const, costMicros: safeMicros(BigInt(inputChargeMicros) + BigInt(cachedInputChargeMicros) + BigInt(cacheWriteChargeMicros) + BigInt(outputChargeMicros)), inputChargeMicros, cachedInputChargeMicros, cacheWriteChargeMicros, outputChargeMicros });
}

export function createNonGoogleCostBound(input: Readonly<{ maximumChargeMicros: number; candidateSha256: string; topologySha256: string; facts: readonly NonGoogleCostFact[] }>) {
  const maximumChargeMicros = NonnegativeMicrosSchema.parse(input.maximumChargeMicros);
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const topologySha256 = DigestSchema.parse(input.topologySha256);
  const facts = input.facts.map((fact) => NonGoogleCostFactSchema.parse(fact));
  if (facts.length !== CostTypeSchema.options.length || new Set(facts.map((fact) => fact.costType)).size !== CostTypeSchema.options.length || !CostTypeSchema.options.every(type => facts.some(fact => fact.costType === type))) throw new Error("NON_GOOGLE_COST_COMPONENT_COVERAGE_REQUIRED");
  if (facts.some((fact) => fact.evidence.candidateSha256 !== candidateSha256)) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
  if (facts.some((fact) => fact.evidence.topologySha256 !== topologySha256)) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
  for (const fact of facts) {
    const kind = fact.evidence.sourceKind;
    const expected = fact.role === "authoritative_native_usage" ? "official_openai_model"
      : fact.role === "documented_scoped_zero" ? "contextvm_transport_policy"
        : fact.role === "included_parent" ? "operator_homelab_policy"
          : fact.role === "explicit_approved_shared_standing" ? "operator_approval_policy" : "unknown";
    if (kind !== expected) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
    if (kind === "official_openai_model" && fact.evidence.sourceUrl !== OPENAI_RESPONSES_PRICING_URL) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
    if (kind !== "official_openai_model" && fact.evidence.sourceUrl === OPENAI_RESPONSES_PRICING_URL) throw new Error("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
  }
  const heldCostTypes = facts.filter((fact): fact is z.infer<typeof HeldFactSchema> => fact.status === "held").map((fact) => fact.costType);
  return freeze({ schemaVersion: "non-google-cost-bound-v2" as const, maximumChargeMicros, candidateSha256, topologySha256, facts: freeze(facts), heldCostTypes: freeze(heldCostTypes) });
}

/** The admission path must call this immediately before asserting a bound. */
export async function assertNonGoogleCostBoundAuthorizable(input: Readonly<{ bound: ReturnType<typeof createNonGoogleCostBound>; candidateSha256: string; topologySha256: string; nowMs: number; evidence: CostEvidenceArtifactResolver }>): Promise<void> {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 1) throw new Error("NON_GOOGLE_COST_CLOCK_INVALID");
  if (input.bound.candidateSha256 !== candidateSha256) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
  if (input.bound.topologySha256 !== DigestSchema.parse(input.topologySha256)) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
  for (const fact of input.bound.facts) {
    if (fact.status !== "available") throw new Error("NON_GOOGLE_COST_BOUND_HELD");
    if (fact.evidence.freshUntilMs <= input.nowMs) throw new Error("NON_GOOGLE_COST_EVIDENCE_STALE");
    if (fact.evidence.candidateSha256 !== candidateSha256) throw new Error("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
    if (fact.evidence.topologySha256 !== input.bound.topologySha256) throw new Error("NON_GOOGLE_COST_TOPOLOGY_MISMATCH");
    const artifact = await input.evidence.read(fact.evidence.artifactReference);
    if (!(artifact.bytes instanceof Uint8Array) || artifact.sourceUrl !== fact.evidence.sourceUrl || await sha256(artifact.bytes) !== fact.evidence.sourceArtifactSha256 || fact.evidence.sourceArtifactSha256 !== fact.evidence.sourceDocumentSha256) throw new Error("NON_GOOGLE_COST_EVIDENCE_ARTIFACT_INVALID");
  }
  if (input.bound.heldCostTypes.length > 0) throw new Error("NON_GOOGLE_COST_BOUND_HELD");
}

export function assertOpenAiUsageWithinApprovedMaximum(input: Readonly<{ usage: OpenAiResponsesUsage; maximumInputTokens: number; maximumOutputTokens: number }>): void {
  const usage = UsageSchema.parse(input.usage);
  if (!Number.isSafeInteger(input.maximumInputTokens) || !Number.isSafeInteger(input.maximumOutputTokens) || input.maximumInputTokens < 1 || input.maximumOutputTokens < 1 || usage.inputTokens > input.maximumInputTokens || usage.outputTokens > input.maximumOutputTokens) throw new Error("OPENAI_USAGE_CAP_EXCEEDED");
}
