import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const InteractionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const CredentialReferenceSchema = z.string().regex(/^gcp:adc:[a-z][a-z0-9:_-]{2,127}$/u);
const PriceSchema = z.object({
  sourceUrl: z.string().url().refine((value) => new URL(value).hostname === "cloud.google.com"),
  sourceDocumentSha256: DigestSchema, quoteSha256: DigestSchema, observedAtMs: z.number().int().positive(), freshUntilMs: z.number().int().positive(), effectiveFromMs: z.number().int().positive(), effectiveUntilMs: z.number().int().positive(), currency: z.literal("USD"),
  inputMicrosPerMillion: z.number().int().positive(), cachedInputMicrosPerMillion: z.number().int().positive(), outputAndThoughtMicrosPerMillion: z.number().int().positive(),
}).strict().superRefine((value, context) => { if (value.freshUntilMs <= value.observedAtMs || value.effectiveUntilMs <= value.effectiveFromMs) context.addIssue({ code: "custom", message: "VERTEX_PRICE_SNAPSHOT_INVALID" }); });
const UsageSchema = z.object({ totalInputTokens: z.number().int().nonnegative(), totalCachedTokens: z.number().int().nonnegative(), totalOutputTokens: z.number().int().nonnegative(), totalThoughtTokens: z.number().int().nonnegative(), totalToolUseTokens: z.number().int().nonnegative() }).strict();
const RequestSchema = z.object({ idea: z.string().min(1).max(4_000), systemInstruction: z.string().min(1).max(8_000), maximumOutputTokens: z.number().int().min(1).max(8_192) }).strict();
const InteractionSchema = z.object({ id: InteractionIdSchema, model: z.literal("gemini-3.8-flash"), input: z.unknown(), status: z.enum(["in_progress", "completed", "failed"]), created: z.iso.datetime(), usage: UsageSchema.optional(), output_text: z.string().max(1_000_000).optional() }).strict();
const JournalSchema = z.object({ operationId: OperationSchema, requestSha256: DigestSchema, nonce: z.string().min(1).max(512), request: RequestSchema, candidateSha256: DigestSchema, projectId: ProjectSchema, model: z.literal("gemini-3.8-flash"), location: z.literal("global"), price: PriceSchema, interactionId: InteractionIdSchema.optional(), completedReceipt: z.unknown().optional() }).strict();

type PriceSnapshot = z.infer<typeof PriceSchema>;
type JournalEntry = z.infer<typeof JournalSchema>;
type Interaction = z.infer<typeof InteractionSchema>;
/** Claim must be a durable transactional CAS: only the successful claimer may
 * issue POST. File/memory journals are test seams, never Cloud Run authority. */
export type VertexOperationJournal = Readonly<{ claim(entry: JournalEntry): Promise<Readonly<{ claimed: boolean; entry: unknown }>>; read(operationId: string): Promise<unknown>; write(entry: JournalEntry): Promise<void> }>;
export type VertexInteractionsPort = Readonly<{
  create(input: Readonly<{ projectId: string; location: "global"; model: "gemini-3.8-flash"; store: true; input: readonly unknown[]; systemInstruction: string; responseMimeType: "application/json"; responseFormat: Readonly<Record<string, unknown>>; generationConfig: Readonly<{ maxOutputTokens: number; thinkingLevel: "LOW" }> }>): Promise<unknown>;
  get(input: Readonly<{ projectId: string; location: "global"; id: string }>): Promise<unknown>;
  list(input: Readonly<{ projectId: string; location: "global"; pageSize: 500; pageToken?: string }>): Promise<unknown>;
}>;

/** Exact, bounded REST wire adapter for the documented Preview Interactions API.
 * It receives a short-lived ADC token from the Plan 63 transport; it never
 * selects a project, emits credentials, or retries a paid POST. */
export function createVertexInteractionsHttpPort(input: Readonly<{ accessToken: () => Promise<string>; fetch?: typeof fetch; timeoutMs?: number }>): VertexInteractionsPort {
  const requestFetch = input.fetch ?? fetch; const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new Error("VERTEX_HTTP_TIMEOUT_INVALID");
  const parent = (projectId: string) => `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/locations/global/interactions`;
  async function request(url: string, init: RequestInit): Promise<unknown> {
    const token = await input.accessToken(); if (!/^[A-Za-z0-9._~-]{20,4096}$/u.test(token)) throw new Error("VERTEX_ADC_TOKEN_INVALID");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { const response = await requestFetch(url, { ...init, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      if (!response.ok) throw new Error(`VERTEX_HTTP_${response.status}`); const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > 2_000_000) throw new Error("VERTEX_HTTP_BODY_INVALID");
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } finally { clearTimeout(timer); }
  }
  return frozen({
    create: async (value) => request(parent(value.projectId), { method: "POST", body: JSON.stringify({ model: value.model, input: value.input, system_instruction: value.systemInstruction, response_mime_type: value.responseMimeType, response_format: value.responseFormat, generation_config: value.generationConfig, store: value.store, stream: false, tools: [] }) }),
    get: async (value) => request(`${parent(value.projectId)}/${encodeURIComponent(value.id)}`, { method: "GET" }),
    list: async (value) => request(`${parent(value.projectId)}?page_size=500${value.pageToken ? `&page_token=${encodeURIComponent(value.pageToken)}` : ""}`, { method: "GET" }),
  });
}

function frozen<T>(value: T): T { return Object.freeze(value); }
function ceilMillion(numerator: bigint): number { const charge = (numerator + 999_999n) / 1_000_000n; if (charge > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("VERTEX_RECEIPT_COST_OVERFLOW"); return Number(charge); }
function nonceFor(operationId: string, requestSha256: string): string { return `napplet-cvm:${operationId}:${requestSha256}`; }
function interactionFrom(value: unknown): Interaction | undefined { const parsed = InteractionSchema.safeParse(value); return parsed.success ? parsed.data : undefined; }
function requestContent(entry: JournalEntry) { return frozen([{ role: "user", parts: [{ text: JSON.stringify({ nonce: entry.nonce, idea: entry.request.idea }) }] }]); }
function sameInput(entry: JournalEntry, interaction: Interaction): boolean { return JSON.stringify(interaction.input) === JSON.stringify(requestContent(entry)); }
function completion(entry: JournalEntry, interaction: Interaction) {
  if (interaction.status !== "completed") return undefined;
  const usage = interaction.usage;
  if (!usage || usage.totalToolUseTokens !== 0 || usage.totalCachedTokens > usage.totalInputTokens) return undefined;
  const inputTokens = usage.totalInputTokens - usage.totalCachedTokens;
  const numerator = BigInt(inputTokens) * BigInt(entry.price.inputMicrosPerMillion) + BigInt(usage.totalCachedTokens) * BigInt(entry.price.cachedInputMicrosPerMillion) + BigInt(usage.totalOutputTokens + usage.totalThoughtTokens) * BigInt(entry.price.outputAndThoughtMicrosPerMillion);
  const costUsdMicros = ceilMillion(numerator);
  if (!interaction.output_text) return undefined;
  return frozen({ status: "completed" as const, operationId: entry.operationId, interactionId: interaction.id, model: entry.model, requestSha256: entry.requestSha256, price: entry.price, generatedResult: interaction.output_text, usage: frozen({ inputTokens, cachedInputTokens: usage.totalCachedTokens, outputTokens: usage.totalOutputTokens, thoughtTokens: usage.totalThoughtTokens }), cost: frozen({ currency: "USD" as const, micros: costUsdMicros }), completedAt: interaction.created });
}
function unknown(operationId: string, reason: "lost_response" | "unmatched_original" | "receipt_invalid") { return frozen({ status: "unknown" as const, operationId, reason, originalOperationOnly: true as const }); }
function pending(operationId: string) { return frozen({ status: "pending" as const, operationId, originalOperationOnly: true as const }); }

/** Production-only Gemini 3.8 Flash adapter. Its journal is injected durable
 * storage: it is written before POST. The preview Interactions API documents
 * no idempotency key, so an ambiguous create is never resent. */
export function createVertexDeploymentClient(input: Readonly<{
  candidateSha256: unknown; projectId: unknown; location: unknown; model: unknown; credentialReference: unknown; price: unknown;
  journal: VertexOperationJournal; interactions: VertexInteractionsPort; now?: () => number;
}>) {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256); const projectId = ProjectSchema.parse(input.projectId);
  if (input.location !== "global" || input.model !== "gemini-3.8-flash") throw new Error("VERTEX_PRODUCTION_MODEL_REQUIRED");
  const credentialReference = CredentialReferenceSchema.parse(input.credentialReference); const price = PriceSchema.parse(input.price); const now = input.now ?? Date.now;
  const assertFresh = (snapshot: PriceSnapshot) => { const at = now(); if (!Number.isSafeInteger(at) || at <= 0 || at < snapshot.observedAtMs || at >= snapshot.freshUntilMs || at < snapshot.effectiveFromMs || at >= snapshot.effectiveUntilMs) throw new Error("VERTEX_PRICE_SNAPSHOT_STALE"); };
  const same = (entry: JournalEntry, operationId: string, requestSha256: string) => entry.operationId === operationId && entry.requestSha256 === requestSha256 && entry.candidateSha256 === candidateSha256 && entry.projectId === projectId && entry.model === "gemini-3.8-flash" && entry.location === "global";
  async function recover(entry: JournalEntry) {
    if (entry.completedReceipt !== undefined) return entry.completedReceipt;
    let found: Interaction | undefined;
    if (entry.interactionId) found = interactionFrom(await input.interactions.get({ projectId, location: "global", id: entry.interactionId }));
    else {
      let pageToken: string | undefined;
      const visitedTokens = new Set<string>();
      for (let page = 0; page < 3; page += 1) {
        const raw = await input.interactions.list({ projectId, location: "global", pageSize: 500, ...(pageToken ? { pageToken } : {}) });
        const value = z.object({ interaction_metadatas: z.array(z.object({ id: InteractionIdSchema }).strict()).max(500), next_page_token: z.string().min(1).max(2048).optional() }).strict().safeParse(raw);
        if (!value.success) return unknown(entry.operationId, "receipt_invalid");
        const records = await Promise.all(value.data.interaction_metadatas.map((metadata) => input.interactions.get({ projectId, location: "global", id: metadata.id }).then(interactionFrom)));
        const matches = records.filter((item): item is Interaction => !!item && item.model === entry.model && sameInput(entry, item));
        if (matches.length > 1 || (found && matches.length === 1)) return unknown(entry.operationId, "receipt_invalid");
        if (matches.length === 1) found = matches[0]!;
        const next = value.data.next_page_token; if (!next) break;
        if (page === 2 || visitedTokens.has(next)) return unknown(entry.operationId, "unmatched_original");
        visitedTokens.add(next); pageToken = next;
      }
    }
    if (!found) return unknown(entry.operationId, "unmatched_original");
    if (found.model !== entry.model || !sameInput(entry, found)) return unknown(entry.operationId, "receipt_invalid");
    if (found.status === "in_progress") return pending(entry.operationId);
    const receipt = completion(entry, found); if (!receipt) return unknown(entry.operationId, "receipt_invalid");
    await input.journal.write(frozen({ ...entry, interactionId: found.id, completedReceipt: receipt })); return receipt;
  }
  return frozen({
    discovery: () => frozen({ candidateSha256, projectId, location: "global" as const, model: "gemini-3.8-flash" as const, credentialReference, provider: "vertex_ai_gemini" as const, price }),
    async dispatch(value: Readonly<{ operationId: unknown; requestSha256: unknown; idea: unknown; systemInstruction: unknown; maximumOutputTokens: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId); const requestSha256 = DigestSchema.parse(value.requestSha256); const existing = await input.journal.read(operationId);
      if (existing !== undefined && existing !== null) { const entry = JournalSchema.parse(existing); if (!same(entry, operationId, requestSha256)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(entry); }
      assertFresh(price); const request = RequestSchema.parse({ idea: value.idea, systemInstruction: value.systemInstruction, maximumOutputTokens: value.maximumOutputTokens }); const entry = JournalSchema.parse({ operationId, requestSha256, nonce: nonceFor(operationId, requestSha256), request, candidateSha256, projectId, model: "gemini-3.8-flash", location: "global", price }); const claim = await input.journal.claim(entry); if (!claim.claimed) { const prior = JournalSchema.parse(claim.entry); if (!same(prior, operationId, requestSha256) || JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(prior); }
      try {
        const created = interactionFrom(await input.interactions.create({ projectId, location: "global", model: "gemini-3.8-flash", store: true, input: requestContent(entry), systemInstruction: request.systemInstruction, responseMimeType: "application/json", responseFormat: frozen({ type: "json_schema", json_schema: frozen({ type: "object", additionalProperties: false, required: ["files"], properties: frozen({ files: frozen({ type: "array", maxItems: 32, items: frozen({ type: "object" }) }) }) }) }), generationConfig: frozen({ maxOutputTokens: request.maximumOutputTokens, thinkingLevel: "LOW" }) }));
        if (!created || created.model !== entry.model || !sameInput(entry, created)) return unknown(operationId, "receipt_invalid");
        const saved = JournalSchema.parse({ ...entry, interactionId: created.id }); await input.journal.write(saved);
        if (created.status === "in_progress") return pending(operationId);
        const receipt = completion(saved, created); if (!receipt) return unknown(operationId, "receipt_invalid"); await input.journal.write(frozen({ ...saved, completedReceipt: receipt })); return receipt;
      } catch { return unknown(operationId, "lost_response"); }
    },
    async reconcileOriginal(value: Readonly<{ operationId: unknown; requestSha256?: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId); const raw = await input.journal.read(operationId);
      if (raw === undefined || raw === null) return unknown(operationId, "unmatched_original");
      const entry = JournalSchema.parse(raw);
      if (value.requestSha256 !== undefined && entry.requestSha256 !== DigestSchema.parse(value.requestSha256)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(entry);
    },
  });
}
