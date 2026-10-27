import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const InteractionNameSchema = z.string().regex(/^interactions\/[A-Za-z0-9_-]{1,256}$/u);
const CredentialReferenceSchema = z.string().regex(/^gcp:adc:[a-z][a-z0-9:_-]{2,127}$/u);
const PriceSchema = z.object({
  sourceUrl: z.string().url().refine((value) => new URL(value).hostname === "cloud.google.com"),
  sourceDocumentSha256: DigestSchema, quoteSha256: DigestSchema, observedAtMs: z.number().int().positive(), freshUntilMs: z.number().int().positive(), effectiveFromMs: z.number().int().positive(), effectiveUntilMs: z.number().int().positive(), currency: z.literal("USD"),
  inputMicrosPerMillion: z.number().int().positive(), cachedInputMicrosPerMillion: z.number().int().positive(), outputAndThoughtMicrosPerMillion: z.number().int().positive(),
}).strict().superRefine((value, context) => { if (value.freshUntilMs <= value.observedAtMs || value.effectiveUntilMs <= value.effectiveFromMs) context.addIssue({ code: "custom", message: "VERTEX_PRICE_SNAPSHOT_INVALID" }); });
const UsageSchema = z.object({ totalInputTokens: z.number().int().nonnegative(), totalCachedTokens: z.number().int().nonnegative(), totalOutputTokens: z.number().int().nonnegative(), totalThoughtTokens: z.number().int().nonnegative(), totalToolUseTokens: z.number().int().nonnegative() }).strict();
const InteractionSchema = z.object({ name: InteractionNameSchema, model: z.literal("gemini-3.8-flash"), input: z.string().min(1).max(512), status: z.enum(["IN_PROGRESS", "COMPLETED", "FAILED"]), createTime: z.iso.datetime(), usage: UsageSchema.optional() }).strict();
const JournalSchema = z.object({ operationId: OperationSchema, requestSha256: DigestSchema, nonce: z.string().min(1).max(512), candidateSha256: DigestSchema, projectId: ProjectSchema, model: z.literal("gemini-3.8-flash"), location: z.literal("global"), price: PriceSchema, interactionName: InteractionNameSchema.optional(), completedReceipt: z.unknown().optional() }).strict();

type PriceSnapshot = z.infer<typeof PriceSchema>;
type JournalEntry = z.infer<typeof JournalSchema>;
type Interaction = z.infer<typeof InteractionSchema>;
/** Claim must be a durable transactional CAS: only the successful claimer may
 * issue POST. File/memory journals are test seams, never Cloud Run authority. */
export type VertexOperationJournal = Readonly<{ claim(entry: JournalEntry): Promise<Readonly<{ claimed: boolean; entry: unknown }>>; read(operationId: string): Promise<unknown>; write(entry: JournalEntry): Promise<void> }>;
export type VertexInteractionsPort = Readonly<{
  create(input: Readonly<{ projectId: string; location: "global"; model: "gemini-3.8-flash"; store: true; input: string }>): Promise<unknown>;
  get(input: Readonly<{ projectId: string; location: "global"; name: string }>): Promise<unknown>;
  list(input: Readonly<{ projectId: string; location: "global"; pageSize: 500; pageToken?: string }>): Promise<unknown>;
}>;

function frozen<T>(value: T): T { return Object.freeze(value); }
function ceilMillion(numerator: bigint): number { const charge = (numerator + 999_999n) / 1_000_000n; if (charge > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("VERTEX_RECEIPT_COST_OVERFLOW"); return Number(charge); }
function nonceFor(operationId: string, requestSha256: string): string { return `napplet-cvm:${operationId}:${requestSha256}`; }
function interactionFrom(value: unknown): Interaction | undefined { const parsed = InteractionSchema.safeParse(value); return parsed.success ? parsed.data : undefined; }
function completion(entry: JournalEntry, interaction: Interaction) {
  if (interaction.status !== "COMPLETED") return undefined;
  const usage = interaction.usage;
  if (!usage || usage.totalToolUseTokens !== 0 || usage.totalCachedTokens > usage.totalInputTokens) return undefined;
  const inputTokens = usage.totalInputTokens - usage.totalCachedTokens;
  const numerator = BigInt(inputTokens) * BigInt(entry.price.inputMicrosPerMillion) + BigInt(usage.totalCachedTokens) * BigInt(entry.price.cachedInputMicrosPerMillion) + BigInt(usage.totalOutputTokens + usage.totalThoughtTokens) * BigInt(entry.price.outputAndThoughtMicrosPerMillion);
  const costUsdMicros = ceilMillion(numerator);
  return frozen({ status: "completed" as const, operationId: entry.operationId, interactionName: interaction.name, model: entry.model, requestSha256: entry.requestSha256, price: entry.price, usage: frozen({ inputTokens, cachedInputTokens: usage.totalCachedTokens, outputTokens: usage.totalOutputTokens, thoughtTokens: usage.totalThoughtTokens }), cost: frozen({ currency: "USD" as const, micros: costUsdMicros }), completedAt: interaction.createTime });
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
    if (entry.interactionName) found = interactionFrom(await input.interactions.get({ projectId, location: "global", name: entry.interactionName }));
    else {
      let pageToken: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const raw = await input.interactions.list({ projectId, location: "global", pageSize: 500, ...(pageToken ? { pageToken } : {}) });
        const value = z.object({ interactions: z.array(z.unknown()).max(500), nextPageToken: z.string().min(1).max(2048).optional() }).strict().safeParse(raw);
        if (!value.success) return unknown(entry.operationId, "receipt_invalid");
        const matches = value.data.interactions.map(interactionFrom).filter((item): item is Interaction => !!item && item.model === entry.model && item.input === entry.nonce);
        if (matches.length > 1) return unknown(entry.operationId, "receipt_invalid");
        if (matches.length === 1) { found = interactionFrom(await input.interactions.get({ projectId, location: "global", name: matches[0]!.name })); break; }
        pageToken = value.data.nextPageToken; if (!pageToken) break;
      }
    }
    if (!found) return unknown(entry.operationId, "unmatched_original");
    if (found.model !== entry.model || found.input !== entry.nonce) return unknown(entry.operationId, "receipt_invalid");
    if (found.status === "IN_PROGRESS") return pending(entry.operationId);
    const receipt = completion(entry, found); if (!receipt) return unknown(entry.operationId, "receipt_invalid");
    await input.journal.write(frozen({ ...entry, interactionName: found.name, completedReceipt: receipt })); return receipt;
  }
  return frozen({
    discovery: () => frozen({ candidateSha256, projectId, location: "global" as const, model: "gemini-3.8-flash" as const, credentialReference, provider: "vertex_ai_gemini" as const, price }),
    async dispatch(value: Readonly<{ operationId: unknown; requestSha256: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId); const requestSha256 = DigestSchema.parse(value.requestSha256); const existing = await input.journal.read(operationId);
      if (existing !== undefined && existing !== null) { const entry = JournalSchema.parse(existing); if (!same(entry, operationId, requestSha256)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(entry); }
      assertFresh(price); const entry = JournalSchema.parse({ operationId, requestSha256, nonce: nonceFor(operationId, requestSha256), candidateSha256, projectId, model: "gemini-3.8-flash", location: "global", price }); const claim = await input.journal.claim(entry); if (!claim.claimed) { const prior = JournalSchema.parse(claim.entry); if (!same(prior, operationId, requestSha256)) throw new Error("VERTEX_OPERATION_IDENTITY_CONFLICT"); return recover(prior); }
      try {
        const created = interactionFrom(await input.interactions.create({ projectId, location: "global", model: "gemini-3.8-flash", store: true, input: entry.nonce }));
        if (!created || created.model !== entry.model || created.input !== entry.nonce) return unknown(operationId, "receipt_invalid");
        const saved = JournalSchema.parse({ ...entry, interactionName: created.name }); await input.journal.write(saved);
        if (created.status === "IN_PROGRESS") return pending(operationId);
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
