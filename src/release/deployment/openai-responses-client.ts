import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import { OpenAiResponsesRateSnapshotSchema, assertOpenAiUsageWithinApprovedMaximum, priceOpenAiResponsesUsage, type OpenAiResponsesRateSnapshot, type OpenAiResponsesUsage } from "../costs/non-google-cost-bound";

const OPENAI_RESPONSES_ORIGIN = "https://api.openai.com";
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_:-]{2,127}$/u);
const ModelSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}$/u);
const CredentialReferenceSchema = z.string().regex(/^openai:api-key:[a-z][a-z0-9:_-]{2,127}$/u);
const ResponseIdSchema = z.string().regex(/^resp_[A-Za-z0-9_-]{3,256}$/u);
const RequestSchema = z.object({ idea: z.string().min(1).max(4_000), systemInstruction: z.string().min(1).max(8_000), maximumInputTokens: z.number().int().min(1).max(100_000), maximumOutputTokens: z.number().int().min(1).max(8_192) }).strict();
const MAX_REQUEST_FRAME_BYTES = 64 * 1024;
export const OpenAiResponsesJournalEntrySchema = z.object({ operationId: OperationSchema, requestSha256: DigestSchema, nonce: z.string().min(1).max(512), clientRequestId: z.string().regex(/^napplet-cvm-[a-f0-9]{64}$/u), request: RequestSchema, candidateSha256: DigestSchema, credentialReference: CredentialReferenceSchema, model: ModelSchema, rate: OpenAiResponsesRateSnapshotSchema, maximumChargeMicros: z.number().int().nonnegative().safe(), responseId: ResponseIdSchema.optional(), completedReceipt: z.unknown().optional() }).strict();
export type OpenAiResponsesJournalEntry = z.infer<typeof OpenAiResponsesJournalEntrySchema>;
type JournalEntry = OpenAiResponsesJournalEntry;
const UsageSchema = z.object({ input_tokens: z.number().int().nonnegative(), input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional(), cache_write_tokens: z.number().int().nonnegative().optional() }).strict().optional(), output_tokens: z.number().int().nonnegative(), output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).strict().optional() }).strict();
/* Responses include documented envelope fields such as `object`, timestamps,
 * and service tier. The parser permits those envelope extensions but remains
 * closed over the billable usage and accepted message/content shapes. */
const ProviderResponseSchema = z.object({ id: ResponseIdSchema, model: ModelSchema, status: z.enum(["completed", "incomplete"]), output: z.array(z.object({ type: z.literal("message"), role: z.literal("assistant"), content: z.array(z.object({ type: z.literal("output_text"), text: z.string().min(1).max(1_000_000) }).passthrough()).min(1).max(16) }).passthrough()).min(1).max(16), usage: UsageSchema }).passthrough();
const ReceiptSchema = z.object({ status: z.enum(["completed", "incomplete"]), operationId: OperationSchema, responseId: ResponseIdSchema, model: ModelSchema, requestSha256: DigestSchema, rateQuoteSha256: DigestSchema, rawResponseSha256: DigestSchema, generatedResult: z.string().min(1).max(1_000_000).optional(), usage: z.object({ inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), reasoningTokens: z.number().int().nonnegative() }).strict(), cost: z.object({ currency: z.literal("USD"), micros: z.number().int().nonnegative().safe() }).strict(), completedAtMs: z.number().int().positive() }).strict().superRefine((value, context) => { if (value.status === "completed" && value.generatedResult === undefined) context.addIssue({ code: "custom", message: "OPENAI_RESPONSE_RESULT_REQUIRED" }); if (value.status === "incomplete" && value.generatedResult !== undefined) context.addIssue({ code: "custom", message: "OPENAI_RESPONSE_INCOMPLETE_RESULT_REJECTED" }); });
export type OpenAiResponsesProviderReceipt = z.infer<typeof ReceiptSchema>;
export function parseOpenAiResponsesProviderReceipt(value: unknown): OpenAiResponsesProviderReceipt | undefined { const parsed = ReceiptSchema.safeParse(value); return parsed.success ? parsed.data : undefined; }
export type OpenAiResponsesOperationJournal = Readonly<{ claim(entry: JournalEntry): Promise<Readonly<{ claimed: boolean; entry: unknown }>>; read(operationId: string): Promise<unknown>; write(entry: JournalEntry): Promise<void> }>;
export type OpenAiResponsesPort = Readonly<{ create(input: Readonly<{ clientRequestId: string; body: unknown }>): Promise<Readonly<{ bytes: Uint8Array }>>; get(responseId: string): Promise<Readonly<{ bytes: Uint8Array }>> }>;
type OpenAiFetch = (url: string, init: RequestInit) => Promise<Response>;

function freeze<T>(value: T): T { return Object.freeze(value); }
function responseUrl(responseId?: string): string { return responseId === undefined ? `${OPENAI_RESPONSES_ORIGIN}/v1/responses` : `${OPENAI_RESPONSES_ORIGIN}/v1/responses/${encodeURIComponent(ResponseIdSchema.parse(responseId))}`; }
async function bytes(response: Response): Promise<Uint8Array> { if (!response.ok || response.redirected) throw new Error("OPENAI_RESPONSES_TRANSPORT_REJECTED"); const contentLength = response.headers.get("content-length"); if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > 2 * 1024 * 1024)) throw new Error("OPENAI_RESPONSES_BYTES_REJECTED"); const value = new Uint8Array(await response.arrayBuffer()); if (value.byteLength === 0 || value.byteLength > 2 * 1024 * 1024) throw new Error("OPENAI_RESPONSES_BYTES_REJECTED"); return value; }
export function createOpenAiResponsesHttpPort(input: Readonly<{ authorization: () => Promise<string>; fetch?: OpenAiFetch; timeoutMs?: number }>): OpenAiResponsesPort {
  const fetcher: OpenAiFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("OPENAI_RESPONSES_HTTP_CONFIGURATION_INVALID");
  async function request(url: string, init: RequestInit): Promise<Readonly<{ bytes: Uint8Array }>> {
    const authorization = await input.authorization();
    if (!/^Bearer\s+[^\s]{16,8192}$/u.test(authorization)) throw new Error("OPENAI_RESPONSES_AUTHORIZATION_REJECTED");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([fetcher(url, { ...init, redirect: "error", signal: controller.signal, headers: { accept: "application/json", authorization, ...init.headers } }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("OPENAI_RESPONSES_TIMEOUT")); }, timeoutMs); })]);
      return freeze({ bytes: await bytes(response) });
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  return freeze({
    create: async ({ clientRequestId, body }) => request(responseUrl(), { method: "POST", headers: { "content-type": "application/json", "x-client-request-id": clientRequestId }, body: canonicalJson(body) }),
    get: async (responseId) => request(responseUrl(responseId), { method: "GET" }),
  });
}
async function sha256(value: Uint8Array): Promise<string> { return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer)).toString("hex"); }
async function hashCanonical(value: unknown): Promise<string> { return sha256(new TextEncoder().encode(canonicalJson(value))); }
function nonceFor(operationId: string, requestSha256: string): string { return `napplet-cvm:${operationId}:${requestSha256}`; }
function requestBody(entry: JournalEntry) { return freeze({ model: entry.model, store: true, max_output_tokens: entry.request.maximumOutputTokens, instructions: entry.request.systemInstruction, input: `${JSON.stringify({ nonce: entry.nonce, request_sha256: entry.requestSha256, idea: entry.request.idea })}`, text: freeze({ format: freeze({ type: "json_schema", name: "napplet_files", strict: true, schema: freeze({ type: "object", additionalProperties: false, required: ["files"], properties: freeze({ files: freeze({ type: "array", maxItems: 32, items: freeze({ type: "object" }) }) }) }) }) }) }); }
function assertRequestBound(entry: JournalEntry): void {
  const bytes = new TextEncoder().encode(canonicalJson(requestBody(entry))).byteLength;
  if (bytes > MAX_REQUEST_FRAME_BYTES || bytes > entry.request.maximumInputTokens) throw new Error("OPENAI_RESPONSES_INPUT_CAP_EXCEEDED");
  const maximum = priceOpenAiResponsesUsage({ rate: entry.rate, usage: { inputTokens: entry.request.maximumInputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: entry.request.maximumOutputTokens, reasoningTokens: 0 } });
  if (maximum.status !== "priced" || maximum.costMicros > entry.maximumChargeMicros) throw new Error("OPENAI_RESPONSES_MAXIMUM_CAP_EXCEEDED");
}
function parseNative(bytes: Uint8Array): z.infer<typeof ProviderResponseSchema> { try { return ProviderResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes))); } catch { throw new Error("OPENAI_RESPONSES_RECEIPT_INVALID"); } }
function generatedResult(response: z.infer<typeof ProviderResponseSchema>): string | undefined { const result = response.output.flatMap((message) => message.content).map((content) => content.text).join(""); if (response.status === "completed" && (!result || result.length > 1_000_000)) return undefined; return result || undefined; }
async function receiptFor(entry: JournalEntry, raw: Uint8Array, completedAtMs: number): Promise<OpenAiResponsesProviderReceipt | undefined> {
  const response = parseNative(raw);
  if (response.model !== entry.model) return undefined;
  const usage: OpenAiResponsesUsage = { inputTokens: response.usage.input_tokens, cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: response.usage.input_tokens_details?.cache_write_tokens ?? 0, outputTokens: response.usage.output_tokens, reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0 };
  try { assertOpenAiUsageWithinApprovedMaximum({ usage, maximumInputTokens: entry.request.maximumInputTokens, maximumOutputTokens: entry.request.maximumOutputTokens }); } catch { return undefined; }
  const priced = priceOpenAiResponsesUsage({ rate: entry.rate, usage });
  if (priced.status !== "priced" || priced.costMicros > entry.maximumChargeMicros) return undefined;
  const result = generatedResult(response);
  if (response.status === "completed" && result === undefined) return undefined;
  return ReceiptSchema.parse({ status: response.status, operationId: entry.operationId, responseId: response.id, model: response.model, requestSha256: entry.requestSha256, rateQuoteSha256: entry.rate.quoteSha256, rawResponseSha256: await sha256(raw), ...(result === undefined ? {} : { generatedResult: result }), usage, cost: { currency: "USD", micros: priced.costMicros }, completedAtMs });
}
function unknown(operationId: string, reason: "response_id_unknown" | "receipt_invalid" | "response_pending") { return freeze({ status: "unknown" as const, operationId, reason, originalOperationOnly: true as const }); }
function pending(operationId: string) { return freeze({ status: "pending" as const, operationId, originalOperationOnly: true as const }); }
function stored(entry: JournalEntry) { return entry.completedReceipt === undefined ? undefined : parseOpenAiResponsesProviderReceipt(entry.completedReceipt); }

export function createOpenAiResponsesClient(input: Readonly<{ candidateSha256: string; credentialReference: string; model: string; rate: OpenAiResponsesRateSnapshot; maximumChargeMicros: number; journal: OpenAiResponsesOperationJournal; port: OpenAiResponsesPort; now?: () => number }>) {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const credentialReference = CredentialReferenceSchema.parse(input.credentialReference);
  const model = ModelSchema.parse(input.model);
  const rate = OpenAiResponsesRateSnapshotSchema.parse(input.rate);
  if (model !== rate.model || !Number.isSafeInteger(input.maximumChargeMicros) || input.maximumChargeMicros < 1) throw new Error("OPENAI_RESPONSES_CONFIGURATION_INVALID");
  const now = input.now ?? Date.now;
  async function persistCompletion(entry: JournalEntry, receipt: OpenAiResponsesProviderReceipt) { const next = OpenAiResponsesJournalEntrySchema.parse({ ...entry, responseId: receipt.responseId, completedReceipt: receipt }); await input.journal.write(next); return receipt; }
  async function observe(entry: JournalEntry) {
    const receipt = stored(entry); if (receipt) return receipt;
    if (!entry.responseId) return unknown(entry.operationId, "response_id_unknown");
    let raw: Uint8Array;
    try { raw = (await input.port.get(entry.responseId)).bytes; } catch { return unknown(entry.operationId, "response_pending"); }
    const next = await receiptFor(entry, raw, now());
    if (!next) return unknown(entry.operationId, "receipt_invalid");
    return persistCompletion(entry, next);
  }
  return freeze({
    async dispatch(command: z.input<typeof RequestSchema> & Readonly<{ operationId: string }>) {
      const operationId = OperationSchema.parse(command.operationId);
      const request = RequestSchema.parse({ idea: command.idea, systemInstruction: command.systemInstruction, maximumInputTokens: command.maximumInputTokens, maximumOutputTokens: command.maximumOutputTokens });
      const requestSha256 = await hashCanonical(request);
      const entry = OpenAiResponsesJournalEntrySchema.parse({ operationId, requestSha256, nonce: nonceFor(operationId, requestSha256), clientRequestId: `napplet-cvm-${requestSha256}`, request, candidateSha256, credentialReference, model, rate, maximumChargeMicros: input.maximumChargeMicros });
      if (entry.rate.observedAtMs > now() || entry.rate.freshUntilMs <= now()) throw new Error("OPENAI_RESPONSES_PRICE_STALE");
      assertRequestBound(entry);
      const claimed = await input.journal.claim(entry);
      const original = OpenAiResponsesJournalEntrySchema.safeParse(claimed.entry);
      if (!original.success) throw new Error("OPENAI_RESPONSES_JOURNAL_INVALID");
      if (!claimed.claimed) return observe(original.data);
      let raw: Uint8Array;
      try { raw = (await input.port.create({ clientRequestId: entry.clientRequestId, body: requestBody(entry) })).bytes; } catch { return unknown(operationId, "response_id_unknown"); }
      let responseId: string | undefined;
      try { responseId = parseNative(raw).id; } catch { return unknown(operationId, "receipt_invalid"); }
      const observed = OpenAiResponsesJournalEntrySchema.parse({ ...entry, responseId });
      await input.journal.write(observed);
      const receipt = await receiptFor(observed, raw, now());
      if (!receipt) return unknown(operationId, "receipt_invalid");
      return persistCompletion(observed, receipt);
    },
    async reconcileOriginal(inputValue: Readonly<{ operationId: string }>) {
      const operationId = OperationSchema.parse(inputValue.operationId);
      const entry = OpenAiResponsesJournalEntrySchema.safeParse(await input.journal.read(operationId));
      if (!entry.success) return unknown(operationId, "response_id_unknown");
      return observe(entry.data);
    },
  });
}
