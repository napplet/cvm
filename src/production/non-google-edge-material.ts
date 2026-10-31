import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";

import { canonicalJson } from "../promotion/schema";
import { assertNonGoogleSuccessorRequestHeld, verifyNonGoogleAuthorizationReceiptV4 } from "../release/contracts";
import { createSuccessorRoleCostBound, OpenAiResponsesRateSnapshotSchema, type SuccessorGraphInventory, type SuccessorRoleCostFact } from "../release/costs/non-google-cost-bound";
import type { NonGoogleModelCostCatalogPort } from "../release/costs/production-catalog";
import { createOpenAiResponsesClient, createOpenAiResponsesHttpPort } from "../release/deployment/openai-responses-client";
import { createPostgresOpenAiResponsesOperationJournal } from "../release/deployment/postgres-openai-responses-journal";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const CredentialReference = z.string().regex(/^openai:api-key:[a-z][a-z0-9:_-]{2,127}$/u);
const Model = z.string().regex(/^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}$/u);
const PositiveMicros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Closed successor-only material. It contains a key reference and recorded
 * source-bound rate, never a key value, provider response, or user input. */
export const NonGoogleEdgeMaterialSchema = z.object({
  version: z.literal("non-google-edge-v1"),
  candidateSha256: Digest,
  topologySha256: Digest,
  successorAuthorization: z.object({ request: z.unknown(), receipt: z.unknown() }).strict(),
  openAiResponses: z.object({
    credentialReference: CredentialReference,
    model: Model,
    rate: OpenAiResponsesRateSnapshotSchema,
    maximumChargeMicros: PositiveMicros,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.openAiResponses.rate.model !== value.openAiResponses.model) {
    context.addIssue({ code: "custom", message: "NON_GOOGLE_EDGE_OPENAI_RATE_MODEL_MISMATCH" });
  }
});
export type NonGoogleEdgeMaterial = z.infer<typeof NonGoogleEdgeMaterialSchema>;

const costAuthorities = new WeakSet<object>();
export type NonGoogleEdgeCostAuthority = Readonly<{
  candidateSha256: string;
  topologySha256: string;
  roleCostBoundSha256: string;
  rateQuoteSha256: string;
  model: string;
  maximumChargeMicros: number;
}>;

/** Consumes controller-owned cost facts through the canonical successor
 * resolver. This does not issue authority: it rejects a record unless the
 * official catalog, source digest, role, usage maximum and v4 bound all agree. */
export async function consumeNonGoogleEdgeCostAuthority(input: Readonly<{
  material: unknown;
  graph: SuccessorGraphInventory;
  facts: readonly SuccessorRoleCostFact[];
  modelCatalog: NonGoogleModelCostCatalogPort;
}>): Promise<NonGoogleEdgeCostAuthority> {
  const material = NonGoogleEdgeMaterialSchema.parse(input.material);
  const receipt = await verifyNonGoogleAuthorizationReceiptV4({ request: material.successorAuthorization.request, receipt: material.successorAuthorization.receipt });
  const bound = await createSuccessorRoleCostBound({ graph: input.graph, facts: input.facts, modelCatalog: input.modelCatalog });
  const modelFact = bound.facts.find(fact => fact.roleId === "model.openai-responses");
  if (!modelFact || modelFact.status !== "available" || modelFact.provider !== "openai_responses" || modelFact.disposition !== "authoritative_native_usage" || modelFact.rate === undefined || modelFact.usageIntent === undefined
    || bound.boundSha256 !== receipt.roleCostBoundSha256 || bound.candidateSha256 !== material.candidateSha256 || bound.topologySha256 !== material.topologySha256
    || canonicalJson(modelFact.rate) !== canonicalJson(material.openAiResponses.rate) || modelFact.rate.model !== material.openAiResponses.model
    || modelFact.usageIntent.maximumChargeMicros !== material.openAiResponses.maximumChargeMicros) throw new Error("NON_GOOGLE_EDGE_COST_BINDING_REQUIRED");
  const authority = Object.freeze({ candidateSha256: material.candidateSha256, topologySha256: material.topologySha256, roleCostBoundSha256: bound.boundSha256, rateQuoteSha256: material.openAiResponses.rate.quoteSha256, model: material.openAiResponses.model, maximumChargeMicros: material.openAiResponses.maximumChargeMicros });
  costAuthorities.add(authority);
  return authority;
}

/** Plan 70 owns the controller-authenticated issuer for this opaque
 * capability. Its private brand prevents mounted JSON, a legacy receipt, or a
 * certification request from manufacturing native OpenAI authority. */
export type NonGoogleEdgeConsumptionAuthority = Readonly<{
  candidateSha256: string;
  topologySha256: string;
  requestSha256: string;
  receiptSha256: string;
  materialSha256: string;
}>;
const consumptionAuthorities = new WeakSet<object>();

function isConsumptionAuthority(value: object): value is NonGoogleEdgeConsumptionAuthority {
  return "candidateSha256" in value && typeof value.candidateSha256 === "string"
    && "topologySha256" in value && typeof value.topologySha256 === "string"
    && "requestSha256" in value && typeof value.requestSha256 === "string"
    && "receiptSha256" in value && typeof value.receiptSha256 === "string"
    && "materialSha256" in value && typeof value.materialSha256 === "string";
}

async function sha256(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function assertConsumptionAuthority(input: Readonly<{
  authority: unknown;
  material: NonGoogleEdgeMaterial;
  receipt: Readonly<{ requestSha256: string; candidateSha256: string; topologySha256: string; receiptSha256: string }>;
}>): Promise<NonGoogleEdgeConsumptionAuthority> {
  if (!input.authority || typeof input.authority !== "object" || !consumptionAuthorities.has(input.authority) || !isConsumptionAuthority(input.authority)) {
    throw new Error("NON_GOOGLE_EDGE_CONTROLLER_AUTHORITY_REQUIRED");
  }
  const authority = input.authority;
  if (authority.candidateSha256 !== input.material.candidateSha256
    || authority.topologySha256 !== input.material.topologySha256
    || authority.requestSha256 !== input.receipt.requestSha256
    || authority.receiptSha256 !== input.receipt.receiptSha256
    || authority.materialSha256 !== await sha256(input.material)) {
    throw new Error("NON_GOOGLE_EDGE_CONTROLLER_BINDING_REQUIRED");
  }
  return authority;
}

function assertCostAuthority(input: Readonly<{ authority: unknown; material: NonGoogleEdgeMaterial; receipt: Readonly<{ roleCostBoundSha256: string }> }>): NonGoogleEdgeCostAuthority {
  if (!input.authority || typeof input.authority !== "object" || !costAuthorities.has(input.authority)) throw new Error("NON_GOOGLE_EDGE_COST_AUTHORITY_REQUIRED");
  const authority = input.authority as NonGoogleEdgeCostAuthority;
  if (authority.candidateSha256 !== input.material.candidateSha256 || authority.topologySha256 !== input.material.topologySha256
    || authority.roleCostBoundSha256 !== input.receipt.roleCostBoundSha256 || authority.rateQuoteSha256 !== input.material.openAiResponses.rate.quoteSha256
    || authority.model !== input.material.openAiResponses.model || authority.maximumChargeMicros !== input.material.openAiResponses.maximumChargeMicros) throw new Error("NON_GOOGLE_EDGE_COST_BINDING_REQUIRED");
  return authority;
}

/** Pure normal-mount boundary. It validates only supplied bytes and successor
 * lineage, then preserves the Plan 70 hold before secret, provider, SDK or
 * database material can be touched. */
export async function assertMountedNonGoogleEdgePrecredential(material: unknown): Promise<never> {
  const parsed = NonGoogleEdgeMaterialSchema.parse(material);
  await verifyNonGoogleAuthorizationReceiptV4({ request: parsed.successorAuthorization.request, receipt: parsed.successorAuthorization.receipt });
  return assertNonGoogleSuccessorRequestHeld(parsed.successorAuthorization.request);
}

/** Mount-only resolver. It performs no read during construction and reads only
 * the fixed referenced key after the Responses client has claimed an original
 * operation. It never exposes the key outside the authorization header. */
export class MountedOpenAiApiKeyBroker {
  readonly #root: string;
  readonly #reference: string;

  constructor(input: Readonly<{ credentialReference: string; root?: string }>) {
    this.#reference = CredentialReference.parse(input.credentialReference);
    this.#root = resolve(input.root ?? "/var/run/secrets/napplet-cvm");
  }

  async authorization(): Promise<string> {
    const name = this.#reference.replaceAll(/[^a-z0-9._-]/giu, "_");
    const path = resolve(this.#root, name);
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("NON_GOOGLE_EDGE_CREDENTIAL_PATH_DENIED");
    const bytes = new Uint8Array(await readFile(path));
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536 || bytes.includes(0)) throw new Error("NON_GOOGLE_EDGE_CREDENTIAL_INVALID");
      const key = new TextDecoder().decode(bytes).trim();
      if (key.length < 16 || key.length > 4_096) throw new Error("NON_GOOGLE_EDGE_CREDENTIAL_INVALID");
      return `Bearer ${key}`;
    } finally { bytes.fill(0); }
  }
}

/**
 * This is the only successor-native Responses construction path. It first
 * revalidates the disjoint v3/v4 lineage then stops at the deliberate held
 * authority gate. Plan 70 must supply controller verification before this
 * function can open a credentialed client; legacy v2/v3 authority can never
 * cross that gate. The unreachable-after-gate construction documents the exact
 * fixed-purpose native graph for that later authority without creating a
 * client, resolving a key, or issuing a request today.
 */
export async function createMountedNonGoogleEdgeClient(input: Readonly<{
  material: unknown;
  authority?: unknown;
  costAuthority?: unknown;
  pool: PostgresSqlPool;
  now?: () => number;
  secretRoot?: string;
}>) {
  const material = NonGoogleEdgeMaterialSchema.parse(input.material);
  const receipt = await verifyNonGoogleAuthorizationReceiptV4({ request: material.successorAuthorization.request, receipt: material.successorAuthorization.receipt });
  if (receipt.candidateSha256 !== material.candidateSha256 || receipt.topologySha256 !== material.topologySha256) {
    throw new Error("NON_GOOGLE_EDGE_SUCCESSOR_BINDING_REQUIRED");
  }
  // Until Plan 70 installs the private controller issuer, retain the existing
  // explicit hold. A v3/v4 shape match alone is never authority to resolve a
  // key, create a client, or issue a request.
  if (input.authority === undefined) assertNonGoogleSuccessorRequestHeld(material.successorAuthorization.request);
  await assertConsumptionAuthority({ authority: input.authority, material, receipt });
  assertCostAuthority({ authority: input.costAuthority, material, receipt });

  const broker = new MountedOpenAiApiKeyBroker({ credentialReference: material.openAiResponses.credentialReference, ...(input.secretRoot === undefined ? {} : { root: input.secretRoot }) });
  const journal = createPostgresOpenAiResponsesOperationJournal(new PostgresOperationJournal(input.pool, {
    namespace: "openai:responses", scopeSha256: material.candidateSha256, purpose: "openai-responses",
  }));
  const client = createOpenAiResponsesClient({
    candidateSha256: material.candidateSha256,
    credentialReference: material.openAiResponses.credentialReference,
    model: material.openAiResponses.model,
    rate: material.openAiResponses.rate,
    maximumChargeMicros: material.openAiResponses.maximumChargeMicros,
    journal,
    port: createOpenAiResponsesHttpPort({ authorization: () => broker.authorization() }),
    now: input.now,
  });
  return Object.freeze({
    provenance: Object.freeze({ module: "src/release/deployment/openai-responses-client.ts", export: "createOpenAiResponsesClient", purpose: "openai-responses" as const, journalNamespace: "openai:responses" as const, rateQuoteSha256: material.openAiResponses.rate.quoteSha256 }),
    client,
  });
}
