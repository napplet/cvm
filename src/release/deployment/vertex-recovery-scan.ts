import { createHash } from "node:crypto";
import { z } from "zod";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const Token = z.string().min(1).max(2048);
export const VERTEX_RECOVERY_GET_LIMIT = 32;
export const VERTEX_RECOVERY_PAGE_LIMIT = 3;
export const VERTEX_RECOVERY_DEADLINE_MS = 25_000;
export const VertexRecoveryBindingSchema = z.object({ operationId: z.string().min(3).max(256).regex(/^[a-z][a-z0-9_:-]*$/u), requestSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type VertexRecoveryBinding = z.infer<typeof VertexRecoveryBindingSchema>;
export const VertexRecoveryStateSchema = VertexRecoveryBindingSchema.extend({
  schemaVersion: z.literal("vertex-recovery-scan-v1"), complete: z.boolean(), ambiguous: z.boolean(), tainted: z.boolean(),
  pageToken: Token.optional(), recentTokens: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(3), matchedId: Id.optional(),
  batch: z.object({ ids: z.array(Id).max(500), index: z.number().int().min(0).max(500), nextPageToken: Token.optional() }).strict().optional(),
}).strict().superRefine((value, ctx) => { if (value.batch && value.batch.index > value.batch.ids.length || value.complete && (value.batch || value.pageToken)) ctx.addIssue({ code: "custom", message: "VERTEX_RECOVERY_CURSOR_INVALID" }); });
export type VertexRecoveryState = z.infer<typeof VertexRecoveryStateSchema>;
export type VertexRecoveryJournal = Readonly<{
  load(binding: VertexRecoveryBinding): Promise<Readonly<{ revision: number; state: unknown }>>;
  compareAndSet(input: Readonly<{ binding: VertexRecoveryBinding; revision: number; state: VertexRecoveryState }>): Promise<Readonly<{ revision: number; state: unknown }> | undefined>;
}>;
export function initialVertexRecoveryState(binding: VertexRecoveryBinding): VertexRecoveryState {
  return VertexRecoveryStateSchema.parse({ ...VertexRecoveryBindingSchema.parse(binding), schemaVersion: "vertex-recovery-scan-v1", complete: false, ambiguous: false, tainted: false, recentTokens: [] });
}
const Page = z.object({ interaction_metadatas: z.array(z.object({ id: Id }).passthrough()).max(500), next_page_token: Token.optional() }).passthrough();
const unknown = Object.freeze({ status: "unknown" as const });

/** One bounded query-only observation window. Progress is independent from the
 * strict original receipt record. A complete unmatched or unproven pass never
 * establishes zero usage and can start a fresh pass on a later invocation. */
export async function advanceVertexRecovery(input: Readonly<{
  journal: VertexRecoveryJournal; binding: VertexRecoveryBinding;
  list(pageToken?: string): Promise<unknown>;
  observe(id: string): Promise<"match" | "different" | "unproven">;
  readFinal(id: string): Promise<unknown>;
  clock?: () => number;
}>): Promise<Readonly<{ status: "found"; id: string; raw: unknown }> | typeof unknown> {
  const now = input.clock ?? Date.now, deadline = now() + VERTEX_RECOVERY_DEADLINE_MS;
  const saved = await input.journal.load(input.binding);
  let state = VertexRecoveryStateSchema.parse(saved.state), dirty = false, reads = 0, pages = 0;
  if (state.operationId !== input.binding.operationId || state.requestSha256 !== input.binding.requestSha256) throw new Error("VERTEX_RECOVERY_BINDING_INVALID");
  const commit = async () => !dirty || Boolean(await input.journal.compareAndSet({ binding: input.binding, revision: saved.revision, state }));
  const reset = () => { state = initialVertexRecoveryState(input.binding); dirty = true; };
  if (state.ambiguous) return unknown;
  while (!state.complete && reads < VERTEX_RECOVERY_GET_LIMIT && now() < deadline) {
    if (!state.batch) {
      if (pages >= VERTEX_RECOVERY_PAGE_LIMIT) break;
      const tokenHash = createHash("sha256").update(JSON.stringify(state.pageToken ?? null)).digest("hex");
      if (state.recentTokens.includes(tokenHash)) { reset(); await commit(); return unknown; }
      let raw: unknown;
      try { pages++; raw = await input.list(state.pageToken); }
      catch (error) {
        // An expired opaque token must not pin the scan forever. A fresh pass
        // is still unknown; this never changes or resends the paid original.
        if (state.pageToken && error instanceof Error && error.message === "VERTEX_HTTP_400") reset();
        await commit(); return unknown;
      }
      const page = Page.safeParse(raw);
      if (!page.success) { reset(); await commit(); return unknown; }
      state = { ...state, recentTokens: [...state.recentTokens, tokenHash].slice(-3), batch: { ids: page.data.interaction_metadatas.map(value => value.id), index: 0, ...(page.data.next_page_token ? { nextPageToken: page.data.next_page_token } : {}) } };
      dirty = true;
    }
    const batch = state.batch;
    if (!batch) throw new Error("VERTEX_RECOVERY_BATCH_REQUIRED");
    while (batch.index < batch.ids.length && reads < VERTEX_RECOVERY_GET_LIMIT && now() < deadline) {
      const id = batch.ids[batch.index]!;
      let observed: "match" | "different" | "unproven";
      try { reads++; observed = await input.observe(id); } catch { observed = "unproven"; }
      if (observed === "match") {
        if (state.matchedId && state.matchedId !== id) state.ambiguous = true;
        else state.matchedId = id;
      } else if (observed === "unproven") state.tainted = true;
      batch.index++; dirty = true;
      if (state.ambiguous) { await commit(); return unknown; }
    }
    if (batch.index < batch.ids.length) break;
    const { batch: _batch, pageToken: _page, ...rest } = state;
    state = batch.nextPageToken ? { ...rest, pageToken: batch.nextPageToken } : { ...rest, complete: true };
    dirty = true;
  }
  if (state.complete && (!state.matchedId || state.tainted)) { reset(); await commit(); return unknown; }
  if (!await commit()) return unknown; // A concurrent observer owns newer progress.
  if (!state.complete || !state.matchedId || reads >= VERTEX_RECOVERY_GET_LIMIT || now() >= deadline) return unknown;
  try { reads++; return Object.freeze({ status: "found", id: state.matchedId, raw: await input.readFinal(state.matchedId) }); }
  catch { return unknown; }
}
