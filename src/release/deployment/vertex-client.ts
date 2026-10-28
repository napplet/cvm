import { z } from "zod";
import { parseStoredVertexInput, parseVertexInteraction, type VertexInteraction } from "./vertex-interaction-wire";
import { advanceVertexRecovery, VERTEX_RECOVERY_GET_LIMIT, VERTEX_RECOVERY_PAGE_LIMIT, VERTEX_RECOVERY_DEADLINE_MS, type VertexRecoveryJournal } from "./vertex-recovery-scan";
import type { GoogleTokenSource } from "./google-auth";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().min(3).max(256).regex(/^[a-z][a-z0-9_:-]*$/u);
const ProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const InteractionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const CredentialReferenceSchema = z.string().regex(/^gcp:adc:[a-z][a-z0-9:_-]{2,127}$/u);
const MAX_RECOVERY_GETS = VERTEX_RECOVERY_GET_LIMIT;
const RECOVERY_DEADLINE_MS = VERTEX_RECOVERY_DEADLINE_MS;
/** The custom interaction carries the system text both as a top-level field
 * and inside the canonical recovery input. UTF-8 bytes are a conservative
 * tokenizer-independent upper bound because every token consumes >=1 byte. */
const MAX_INPUT_TOKEN_UPPER_BOUND = 100_000;
const PriceSchema = z.object({
  sourceUrl: z.string().url().refine((value) => new URL(value).hostname === "cloud.google.com"),
  sourceDocumentSha256: DigestSchema, quoteSha256: DigestSchema, observedAtMs: z.number().int().positive(), freshUntilMs: z.number().int().positive(), effectiveFromMs: z.number().int().positive(), effectiveUntilMs: z.number().int().positive(), currency: z.literal("USD"),
  inputMicrosPerMillion: z.number().int().positive(), cachedInputMicrosPerMillion: z.number().int().positive(), outputAndThoughtMicrosPerMillion: z.number().int().positive(),
}).strict().superRefine((value, context) => { if (value.freshUntilMs <= value.observedAtMs || value.effectiveUntilMs <= value.effectiveFromMs) context.addIssue({ code: "custom", message: "VERTEX_PRICE_SNAPSHOT_INVALID" }); });
/* The Interactions custom HTTP API is not the Vertex protobuf discovery API.
 * Its request and usage fields are snake_case. Keep this boundary literal: a
 * camelCase payload can be accepted by a mock yet be silently ignored by the
 * Preview service. */
const RequestSchema = z.object({ idea: z.string().min(1).max(4_000), systemInstruction: z.string().min(1).max(8_000), maximumOutputTokens: z.number().int().min(1).max(8_192), maximumInputTokens: z.number().int().min(1).max(MAX_INPUT_TOKEN_UPPER_BOUND).optional() }).strict();
const JournalSchema = z.object({ operationId: OperationSchema, requestSha256: DigestSchema, nonce: z.string().min(1).max(512), request: RequestSchema, candidateSha256: DigestSchema, projectId: ProjectSchema, model: z.literal("gemini-4-argon"), location: z.literal("global"), price: PriceSchema, interactionId: InteractionIdSchema.optional(), completedReceipt: z.unknown().optional() }).strict();
const ReceiptSchema = z.object({ status: z.enum(["completed", "incomplete"]), operationId: OperationSchema, interactionId: InteractionIdSchema, model: z.literal("gemini-4-argon"), requestSha256: DigestSchema, price: PriceSchema, generatedResult: z.string().min(1).max(1_000_000).optional(), usage: z.object({ inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), thoughtTokens: z.number().int().nonnegative() }).strict(), cost: z.object({ currency: z.literal("USD"), micros: z.number().int().nonnegative() }).strict(), completedAt: z.string().datetime() }).strict().superRefine((value, context) => { if (value.status === "completed" && value.generatedResult === undefined) context.addIssue({ code: "custom", message: "VERTEX_RECEIPT_RESULT_REQUIRED" }); if (value.status === "incomplete" && value.generatedResult !== undefined) context.addIssue({ code: "custom", message: "VERTEX_RECEIPT_INCOMPLETE_RESULT_REJECTED" }); });

type PriceSnapshot = z.infer<typeof PriceSchema>;
type JournalEntry = z.infer<typeof JournalSchema>;
type Interaction = VertexInteraction;
/** Immutable, source-priced USD evidence for the funding finalizer. Only a
 * completed/incomplete receipt is debit-eligible; pending/unknown outcomes
 * must remain unresolved and may never be converted to sats. */
export type VertexProviderReceipt = z.infer<typeof ReceiptSchema>;
export function parseVertexProviderReceipt(raw: unknown): VertexProviderReceipt | undefined { const result = ReceiptSchema.safeParse(raw); return result.success ? result.data : undefined; }
/** Claim must be a durable transactional CAS: only the successful claimer may
 * issue POST. File/memory journals are test seams, never Cloud Run authority. */
export type VertexOperationJournal = Readonly<{ claim(entry: JournalEntry): Promise<Readonly<{ claimed: boolean; entry: unknown }>>; read(operationId: string): Promise<unknown>; write(entry: JournalEntry): Promise<void>; /** Actual SQL adapters retain bounded progress; legacy test journals remain query-only. */ recovery?: VertexRecoveryJournal }>;
/** Server-owned journal reader for a separately owner-checked operational
 * recovery route. This does not relax any client candidate/project check. */
export async function readRetainedVertexOperation(journal: VertexOperationJournal, operation: unknown) {
  const operationId = OperationSchema.parse(operation);
  const raw = await journal.read(operationId);
  if (raw === undefined || raw === null) return undefined;
  const entry = JournalSchema.parse(raw);
  if (entry.operationId !== operationId || entry.nonce !== nonceFor(operationId, entry.requestSha256) || entry.requestSha256 !== await requestDigest({ candidateSha256: entry.candidateSha256, projectId: entry.projectId, model: entry.model, location: entry.location, request: entry.request })) throw new Error("VERTEX_RETAINED_OPERATION_BINDING_INVALID");
  return entry;
}
export type VertexInteractionsPort = Readonly<{
  create(input: Readonly<{ projectId: string; location: "global"; model: "gemini-4-argon"; store: true; input: readonly unknown[]; systemInstruction: string; responseMimeType: "application/json"; responseFormat: Readonly<Record<string, unknown>>; generationConfig: Readonly<{ maxOutputTokens: number; thinkingLevel: "low" }> }>): Promise<unknown>;
  get(input: Readonly<{ projectId: string; location: "global"; id: string }>): Promise<unknown>;
  list(input: Readonly<{ projectId: string; location: "global"; pageSize: 500; pageToken?: string }>): Promise<unknown>;
}>;

/** Exact, bounded REST wire adapter for the documented Preview Interactions API.
 * It receives a short-lived ADC token from the Plan 63 transport; it never
 * selects a project, emits credentials, or retries a paid POST. */
export function createVertexInteractionsHttpPort(input: Readonly<{ accessToken?: () => Promise<string>; tokenSource?: GoogleTokenSource; fetch?: typeof fetch; timeoutMs?: number; creationTimeoutMs?: number }>): VertexInteractionsPort {
  const requestFetch = input.fetch ?? fetch; const timeoutMs = input.timeoutMs ?? 10_000; const creationTimeoutMs = input.creationTimeoutMs ?? timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000 || !Number.isSafeInteger(creationTimeoutMs) || creationTimeoutMs < 1_000 || creationTimeoutMs > 540_000 || (!!input.accessToken === !!input.tokenSource)) throw new Error("VERTEX_HTTP_CONFIGURATION_INVALID");
  const accessToken = input.accessToken ?? (async () => (await input.tokenSource!.getAccessToken()).token);
  const parent = (projectId: string) => `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/locations/global/interactions`;
  async function request(url: string, init: RequestInit, requestTimeoutMs = timeoutMs): Promise<unknown> {
    const token = await accessToken(); if (!/^[A-Za-z0-9._~-]{20,4096}$/u.test(token)) throw new Error("VERTEX_ADC_TOKEN_INVALID");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try { const response = await requestFetch(url, { ...init, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      if (!response.ok) throw new Error(`VERTEX_HTTP_${response.status}`);
      if (!response.body) throw new Error("VERTEX_HTTP_BODY_INVALID");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 2_000_000) throw new Error("VERTEX_HTTP_BODY_INVALID"); chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      if (length === 0) throw new Error("VERTEX_HTTP_BODY_INVALID"); const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } finally { clearTimeout(timer); }
  }
  return frozen({
    create: async (value) => request(parent(value.projectId), { method: "POST", body: JSON.stringify({ model: value.model, input: value.input, system_instruction: value.systemInstruction, response_mime_type: value.responseMimeType, response_format: value.responseFormat, generation_config: { max_output_tokens: value.generationConfig.maxOutputTokens, thinking_level: value.generationConfig.thinkingLevel }, store: value.store, stream: false, background: false, tools: [] }) }, creationTimeoutMs),
    get: async (value) => request(`${parent(value.projectId)}/${encodeURIComponent(value.id)}`, { method: "GET" }),
    list: async (value) => request(`${parent(value.projectId)}?page_size=500${value.pageToken ? `&page_token=${encodeURIComponent(value.pageToken)}` : ""}`, { method: "GET" }),
  });
}

function frozen<T>(value: T): T { return Object.freeze(value); }
async function requestDigest(input: Readonly<{ candidateSha256: string; projectId: string; model: "gemini-4-argon"; location: "global"; request: z.infer<typeof RequestSchema> }>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input)); const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function ceilMillion(numerator: bigint): number { const charge = (numerator + 999_999n) / 1_000_000n; if (charge > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("VERTEX_RECEIPT_COST_OVERFLOW"); return Number(charge); }
function nonceFor(operationId: string, requestSha256: string): string { return `napplet-cvm:${operationId}:${requestSha256}`; }
const interactionFrom = parseVertexInteraction;
function requestContent(entry: JournalEntry) { return frozen([{ role: "user" as const, content: frozen([{ type: "text" as const, text: JSON.stringify({ nonce: entry.nonce, request_sha256: entry.requestSha256, idea: entry.request.idea, system_instruction: entry.request.systemInstruction, max_output_tokens: entry.request.maximumOutputTokens }) }]) }]); }
function responseFormat() { return frozen({ type: "text", mime_type: "application/json", schema: frozen({ type: "object", additionalProperties: false, required: ["files"], properties: frozen({ files: frozen({ type: "array", maxItems: 32, items: frozen({ type: "object" }) }) }) }) }); }
function assertInputBound(entry: JournalEntry): void {
  // Include the structured-output schema and request framing before claiming
  // a paid operation. The profile's input ceiling must cover the actual wire.
  const encoded = JSON.stringify({ input: requestContent(entry)[0]!.content, system_instruction: entry.request.systemInstruction, response_format: responseFormat() });
  if (new TextEncoder().encode(encoded).byteLength > (entry.request.maximumInputTokens ?? MAX_INPUT_TOKEN_UPPER_BOUND)) throw new Error("VERTEX_INPUT_CAP_EXCEEDED");
}
function sameInput(entry: JournalEntry, interaction: Interaction): boolean { return JSON.stringify(interaction.input) === JSON.stringify(requestContent(entry)); }
function generatedResult(interaction: Interaction): string | undefined {
  const output = interaction.steps?.flatMap((step) => step.model_output?.content.map((part) => part.text) ?? []);
  if (!output || output.length !== 1) return undefined;
  return output[0];
}
function validStructuredResult(result: string): boolean {
  try { const structured: unknown = JSON.parse(result); return !!structured && typeof structured === "object" && !Array.isArray(structured); } catch { return false; }
}
function completion(entry: JournalEntry, interaction: Interaction) {
  if (interaction.status !== "completed" && interaction.status !== "incomplete") return undefined;
  const usage = interaction.usage;
  /* Gemini 4 Argon's max_output_tokens is a unified server-side ceiling for
   * response, reasoning and function-call tokens.  We send no tools, then
   * reject a receipt which cannot possibly have honoured the persisted cap. */
  if (!usage || usage.tool_use_tokens !== 0 || usage.input_tokens > (entry.request.maximumInputTokens ?? MAX_INPUT_TOKEN_UPPER_BOUND) || usage.cached_input_tokens > usage.input_tokens || usage.output_tokens + usage.thought_tokens > entry.request.maximumOutputTokens) return undefined;
  const inputTokens = usage.input_tokens - usage.cached_input_tokens;
  const numerator = BigInt(inputTokens) * BigInt(entry.price.inputMicrosPerMillion) + BigInt(usage.cached_input_tokens) * BigInt(entry.price.cachedInputMicrosPerMillion) + BigInt(usage.output_tokens + usage.thought_tokens) * BigInt(entry.price.outputAndThoughtMicrosPerMillion);
  const costUsdMicros = ceilMillion(numerator);
  if (interaction.status === "incomplete") return frozen({ status: "incomplete" as const, operationId: entry.operationId, interactionId: interaction.id, model: entry.model, requestSha256: entry.requestSha256, price: entry.price, usage: frozen({ inputTokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens, thoughtTokens: usage.thought_tokens }), cost: frozen({ currency: "USD" as const, micros: costUsdMicros }), completedAt: interaction.created });
  const result = generatedResult(interaction); if (!result) return undefined;
  if (!validStructuredResult(result)) return undefined;
  return frozen({ status: "completed" as const, operationId: entry.operationId, interactionId: interaction.id, model: entry.model, requestSha256: entry.requestSha256, price: entry.price, generatedResult: result, usage: frozen({ inputTokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens, thoughtTokens: usage.thought_tokens }), cost: frozen({ currency: "USD" as const, micros: costUsdMicros }), completedAt: interaction.created });
}
function persistedReceipt(entry: JournalEntry, raw: unknown) {
  const receipt = ReceiptSchema.safeParse(raw);
  if (!receipt.success || receipt.data.operationId !== entry.operationId || receipt.data.requestSha256 !== entry.requestSha256 || receipt.data.model !== entry.model || entry.interactionId === undefined || receipt.data.interactionId !== entry.interactionId || JSON.stringify(receipt.data.price) !== JSON.stringify(entry.price)) return undefined;
  const usage = receipt.data.usage;
  // completion() already separates uncached input from cached input. Replaying
  // must price those same dimensions once, including a fully cached request.
  if (usage.inputTokens + usage.cachedInputTokens > (entry.request.maximumInputTokens ?? MAX_INPUT_TOKEN_UPPER_BOUND) || usage.outputTokens + usage.thoughtTokens > entry.request.maximumOutputTokens || (receipt.data.status === "completed" && (!receipt.data.generatedResult || !validStructuredResult(receipt.data.generatedResult))) || (receipt.data.status === "incomplete" && receipt.data.generatedResult !== undefined)) return undefined;
  const recomputed = ceilMillion(BigInt(usage.inputTokens) * BigInt(entry.price.inputMicrosPerMillion) + BigInt(usage.cachedInputTokens) * BigInt(entry.price.cachedInputMicrosPerMillion) + BigInt(usage.outputTokens + usage.thoughtTokens) * BigInt(entry.price.outputAndThoughtMicrosPerMillion));
  if (receipt.data.cost.currency !== "USD" || receipt.data.cost.micros !== recomputed) return undefined;
  return receipt.data;
}
function unknown(operationId: string, reason: "lost_response" | "unmatched_original" | "receipt_invalid") { return frozen({ status: "unknown" as const, operationId, reason, originalOperationOnly: true as const }); }
function pending(operationId: string) { return frozen({ status: "pending" as const, operationId, originalOperationOnly: true as const }); }

/** Production-only Gemini 4 Argon adapter. Its journal is injected durable
 * storage: it is written before POST. The preview Interactions API documents
 * no idempotency key, so an ambiguous create is never resent. */
export function createVertexDeploymentClient(input: Readonly<{
  candidateSha256: unknown; projectId: unknown; location: unknown; model: unknown; credentialReference: unknown; price: unknown;
  journal: VertexOperationJournal; interactions: VertexInteractionsPort; now?: () => number; /** Internal observation-clock seam; production uses wall time. */ recoveryClock?: () => number;
}>) {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256); const projectId = ProjectSchema.parse(input.projectId);
  if (input.location !== "global" || input.model !== "gemini-4-argon") throw new Error("VERTEX_PRODUCTION_MODEL_REQUIRED");
  const credentialReference = CredentialReferenceSchema.parse(input.credentialReference); const price = PriceSchema.parse(input.price); const now = input.now ?? Date.now;
  const assertFresh = (snapshot: PriceSnapshot) => { const at = now(); if (!Number.isSafeInteger(at) || at <= 0 || at < snapshot.observedAtMs || at >= snapshot.freshUntilMs || at < snapshot.effectiveFromMs || at >= snapshot.effectiveUntilMs) throw new Error("VERTEX_PRICE_SNAPSHOT_STALE"); };
  const same = (entry: JournalEntry, operationId: string, requestSha256: string) => entry.operationId === operationId && entry.requestSha256 === requestSha256 && entry.candidateSha256 === candidateSha256 && entry.projectId === projectId && entry.model === "gemini-4-argon" && entry.location === "global";
  async function recover(entry: JournalEntry) {
    if (entry.completedReceipt !== undefined) return persistedReceipt(entry, entry.completedReceipt) ?? unknown(entry.operationId, "receipt_invalid");
    /* A successful create persisted the provider ID. Recovery must query that
     * exact resource first; scanning unrelated pages can otherwise exhaust the
     * bounded read budget before reaching a known paid interaction. */
    if (entry.interactionId !== undefined) {
      let direct: Interaction | undefined;
      try { direct = interactionFrom(await input.interactions.get({ projectId, location: "global", id: entry.interactionId })); } catch { return unknown(entry.operationId, "unmatched_original"); }
      if (!direct || direct.id !== entry.interactionId || direct.model !== entry.model || !sameInput(entry, direct)) return unknown(entry.operationId, "receipt_invalid");
      if (direct.status === "in_progress" || direct.status === "queued") return pending(entry.operationId);
      const receipt = completion(entry, direct); if (!receipt) return unknown(entry.operationId, "receipt_invalid");
      await input.journal.write(frozen({ ...entry, completedReceipt: receipt })); return receipt;
    }
    if (input.journal.recovery) {
      const bound = (raw: unknown, id: string): "match" | "different" | "unproven" => {
        const header = z.object({ id: InteractionIdSchema, model: z.string().min(1).max(256) }).passthrough().safeParse(raw);
        if (!header.success || header.data.id !== id) return "unproven";
        if (header.data.model !== entry.model) return "different";
        const storedInput = parseStoredVertexInput(raw);
        if (!storedInput) return "unproven";
        return JSON.stringify(storedInput) === JSON.stringify(requestContent(entry)) ? "match" : "different";
      };
      const observed = await advanceVertexRecovery({ journal: input.journal.recovery, binding: { operationId: entry.operationId, requestSha256: entry.requestSha256 }, clock: input.recoveryClock,
        list: pageToken => input.interactions.list({ projectId, location: "global", pageSize: 500, ...(pageToken ? { pageToken } : {}) }),
        observe: async id => bound(await input.interactions.get({ projectId, location: "global", id }), id),
        readFinal: id => input.interactions.get({ projectId, location: "global", id }),
      });
      if (observed.status !== "found") return unknown(entry.operationId, "unmatched_original");
      if (bound(observed.raw, observed.id) !== "match") return unknown(entry.operationId, "receipt_invalid");
      // Unique stored input establishes the original native ID independently
      // of incomplete usage/output. Future observation can use the direct GET.
      const saved = JournalSchema.parse({ ...entry, interactionId: observed.id });
      await input.journal.write(saved);
      const item = interactionFrom(observed.raw);
      if (!item) return unknown(entry.operationId, "receipt_invalid");
      if (item.status === "in_progress" || item.status === "queued") return pending(entry.operationId);
      const receipt = completion(saved, item); if (!receipt) return unknown(entry.operationId, "receipt_invalid");
      await input.journal.write(frozen({ ...saved, completedReceipt: receipt })); return receipt;
    }
    let found: Interaction | undefined; let pageToken: string | undefined; const visitedTokens = new Set<string>(); const deadline = Date.now() + RECOVERY_DEADLINE_MS; let reads = 0;
    for (let page = 0; page < VERTEX_RECOVERY_PAGE_LIMIT; page += 1) {
      if (Date.now() >= deadline) return unknown(entry.operationId, "unmatched_original");
      const raw = await input.interactions.list({ projectId, location: "global", pageSize: 500, ...(pageToken ? { pageToken } : {}) });
      const value = z.object({ interaction_metadatas: z.array(z.object({ id: InteractionIdSchema }).passthrough()).max(500), next_page_token: z.string().min(1).max(2048).optional() }).passthrough().safeParse(raw);
      if (!value.success) return unknown(entry.operationId, "receipt_invalid");
      /* Serial (one-at-a-time) GETs cap in-flight response bytes; both total
       * reads and the full recovery window are bounded. Omitting a later ID is
       * intentionally unknown, never evidence that the paid POST did not run. */
      for (const metadata of value.data.interaction_metadatas) {
        if (reads >= MAX_RECOVERY_GETS || Date.now() >= deadline) return unknown(entry.operationId, "unmatched_original");
        reads += 1;
        const item = interactionFrom(await input.interactions.get({ projectId, location: "global", id: metadata.id }));
        if (!item || item.model !== entry.model || !sameInput(entry, item)) continue;
        if (item.id !== metadata.id) return unknown(entry.operationId, "receipt_invalid");
        if (found) return unknown(entry.operationId, "receipt_invalid"); found = item;
      }
      const next = value.data.next_page_token; if (!next) break;
      if (page === VERTEX_RECOVERY_PAGE_LIMIT - 1 || visitedTokens.has(next)) return unknown(entry.operationId, "unmatched_original");
      visitedTokens.add(next); pageToken = next;
    }
    if (!found) return unknown(entry.operationId, "unmatched_original");
    if (found.status === "in_progress" || found.status === "queued") return pending(entry.operationId);
    const receipt = completion(entry, found); if (!receipt) return unknown(entry.operationId, "receipt_invalid");
    await input.journal.write(frozen({ ...entry, interactionId: found.id, completedReceipt: receipt })); return receipt;
  }
  return frozen({
    discovery: () => frozen({ candidateSha256, projectId, location: "global" as const, model: "gemini-4-argon" as const, credentialReference, provider: "vertex_ai_gemini" as const, price }),
    async dispatch(value: Readonly<{ operationId: unknown; requestSha256?: unknown; idea: unknown; systemInstruction: unknown; maximumOutputTokens: unknown; maximumInputTokens?: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId); const request = RequestSchema.parse({ idea: value.idea, systemInstruction: value.systemInstruction, maximumOutputTokens: value.maximumOutputTokens, ...(value.maximumInputTokens !== undefined ? { maximumInputTokens: value.maximumInputTokens } : {}) }); const requestSha256 = await requestDigest({ candidateSha256, projectId, model: "gemini-4-argon", location: "global", request });
      if (value.requestSha256 !== undefined && DigestSchema.parse(value.requestSha256) !== requestSha256) throw new Error("VERTEX_REQUEST_DIGEST_MISMATCH");
      const existing = await input.journal.read(operationId);
      if (existing !== undefined && existing !== null) { const entry = JournalSchema.parse(existing); if (!same(entry, operationId, requestSha256) || JSON.stringify(entry.request) !== JSON.stringify(request)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(entry); }
      assertFresh(price); const entry = JournalSchema.parse({ operationId, requestSha256, nonce: nonceFor(operationId, requestSha256), request, candidateSha256, projectId, model: "gemini-4-argon", location: "global", price }); assertInputBound(entry); const claim = await input.journal.claim(entry); if (!claim.claimed) { const prior = JournalSchema.parse(claim.entry); if (!same(prior, operationId, requestSha256) || JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(prior); }
      try {
        const created = interactionFrom(await input.interactions.create({ projectId, location: "global", model: "gemini-4-argon", store: true, input: requestContent(entry)[0]!.content, systemInstruction: request.systemInstruction, responseMimeType: "application/json", responseFormat: responseFormat(), generationConfig: frozen({ maxOutputTokens: request.maximumOutputTokens, thinkingLevel: "low" }) }));
        if (!created || created.model !== entry.model || (!sameInput(entry, created) && !(created.wire === "current" && created.input === undefined))) return unknown(operationId, "receipt_invalid");
        const saved = JournalSchema.parse({ ...entry, interactionId: created.id }); await input.journal.write(saved);
        if (created.status === "in_progress" || created.status === "queued") return pending(operationId);
        const receipt = completion(saved, created); if (!receipt) return unknown(operationId, "receipt_invalid"); await input.journal.write(frozen({ ...saved, completedReceipt: receipt })); return receipt;
      } catch { return unknown(operationId, "lost_response"); }
    },
    async reconcileOriginal(value: Readonly<{ operationId: unknown; requestSha256?: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId); const raw = await input.journal.read(operationId);
      if (raw === undefined || raw === null) return unknown(operationId, "unmatched_original");
      const entry = JournalSchema.parse(raw);
      if (!same(entry, operationId, entry.requestSha256) || (value.requestSha256 !== undefined && entry.requestSha256 !== DigestSchema.parse(value.requestSha256))) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(entry);
    },
  });
}
