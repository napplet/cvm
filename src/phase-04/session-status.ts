import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { PrincipalSchema } from "../phase-03/contracts";
import { ContinuationStatusSchema } from "../continuity/contracts";
import type { BillingLineItem, ContinuationCheckpoint, ContinuationFundingStore, ContinuationRecord, DeletionOutcomeInput, MeteredAction, MeteredFundingStore } from "../persistence/funding-store";

const DecimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const SignedDecimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)$/u);
const CursorPayloadSchema = z.object({
  v: z.literal(1),
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(50),
  storeCursor: z.string().min(1),
  mac: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const SessionStatusQuerySchema = z.object({
  principal: PrincipalSchema,
  sessionId: z.string().min(1),
  billing: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

const BillingHistoryItemSchema = z.object({
  id: z.string().min(1),
  sequence: DecimalSchema,
  sessionId: z.string().min(1).optional(),
  actionId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  kind: z.enum(["credit", "cap_hold", "action_reservation", "receipt", "debit", "release", "reconciliation"]),
  unit: z.literal("sat"),
  amount: SignedDecimalSchema,
  settledAvailable: DecimalSchema,
  held: DecimalSchema,
  sessionSpend: DecimalSchema,
}).strict();

export const BillingHistoryPageSchema = z.object({
  items: z.array(BillingHistoryItemSchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

const StatusOkSchema = z.object({
  status: z.literal("ok"),
  session: z.object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    state: z.enum(["prepared", "active", "failed", "usage_unknown", "billing_invariant_failed", "verified", "needs_top_up", "expired"]),
    progress: z.enum(["waiting_for_dispatch", "waiting_for_funding", "running", "verified", "failed", "reconciliation_required"]),
    maximum: DecimalSchema,
    actualSpend: DecimalSchema,
    remainingBalance: DecimalSchema,
    remainingCap: DecimalSchema,
    latestVerifiedArtifact: z.object({ id: z.string().min(1), version: z.number().int().nonnegative() }).nullable(),
    nextAction: z.enum(["revise_session", "billing_reconciliation", "wait_for_current_action", "top_up", "approve_cap", "top_up_and_approve_cap", "none"]),
    continuation: z.union([ContinuationStatusSchema, z.null()]),
  }).strict(),
  action: z.union([z.object({
    id: z.string().min(1),
    operationId: z.string().min(1),
    state: z.enum(["prepared", "dispatching", "usage_unknown", "completed", "failed", "billing_invariant_failed"]),
    authorization: z.object({ reference: z.string().min(1), maximum: DecimalSchema }).strict(),
    price: z.object({ cardId: z.string().min(1), profileId: z.string().min(1) }).strict(),
    reconciliation: z.object({ state: z.enum(["not_required", "pending", "claimed"]), evidenceId: z.string().min(1).nullable() }).strict(),
    diagnostic: z.object({ code: z.enum(["none", "action_failed", "usage_unknown", "billing_invariant_failed"]), evidenceId: z.string().min(1).nullable() }).strict(),
  }).strict(), z.null()]),
  billing: BillingHistoryPageSchema,
}).strict();

export const SessionStatusSchema = z.discriminatedUnion("status", [
  StatusOkSchema,
  z.object({ status: z.literal("not_found_or_denied") }).strict(),
  z.object({ status: z.literal("invalid_cursor") }).strict(),
  z.object({ status: z.literal("service_unavailable") }).strict(),
]);

export type SessionStatusQuery = z.infer<typeof SessionStatusQuerySchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function bytes(input: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const source = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}
async function mac(secret: string | Uint8Array, payload: Omit<z.infer<typeof CursorPayloadSchema>, "mac">): Promise<string> {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(signed), (value) => value.toString(16).padStart(2, "0")).join("");
}
async function opaqueCursor(secret: string | Uint8Array, payload: Omit<z.infer<typeof CursorPayloadSchema>, "mac">): Promise<string> {
  return Buffer.from(JSON.stringify({ ...payload, mac: await mac(secret, payload) })).toString("base64url");
}
async function parseCursor(secret: string | Uint8Array, cursor: string, expected: Readonly<{ accountId: string; sessionId: string; limit: number }>): Promise<string | undefined> {
  try {
    const decoded = CursorPayloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    const payload = { v: decoded.v, accountId: decoded.accountId, sessionId: decoded.sessionId, limit: decoded.limit, storeCursor: decoded.storeCursor } as const;
    if (decoded.accountId !== expected.accountId || decoded.sessionId !== expected.sessionId || decoded.limit !== expected.limit || decoded.mac !== await mac(secret, payload)) return undefined;
    return decoded.storeCursor;
  } catch { return undefined; }
}

function historyItem(item: BillingLineItem): z.infer<typeof BillingHistoryItemSchema> {
  return BillingHistoryItemSchema.parse({
    id: item.id, sequence: item.sequence, ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.actionId ? { actionId: item.actionId } : {}), ...(item.operationId ? { operationId: item.operationId } : {}),
    kind: item.kind, unit: item.unit, amount: item.amount, settledAvailable: item.settledAvailable, held: item.held, sessionSpend: item.sessionSpend,
  });
}
function newestAction(actions: readonly MeteredAction[]): MeteredAction | undefined {
  return [...actions].sort((left, right) => (right.sessionVersion ?? right.expectedVersion) - (left.sessionVersion ?? left.expectedVersion) || right.actionId.localeCompare(left.actionId))[0];
}
function safeProgress(state: z.infer<typeof StatusOkSchema>["session"]["state"]): z.infer<typeof StatusOkSchema>["session"]["progress"] {
  if (state === "needs_top_up") return "waiting_for_funding";
  if (state === "usage_unknown" || state === "billing_invariant_failed") return "reconciliation_required";
  if (state === "verified") return "verified";
  if (state === "failed") return "failed";
  return state === "active" ? "running" : "waiting_for_dispatch";
}
function continuationStatus(record: ContinuationRecord): z.infer<typeof ContinuationStatusSchema> {
  const result = record.result;
  return ContinuationStatusSchema.parse({
    status: "needs_top_up",
    pendingAction: { reference: result.pendingActionReference, fingerprint: result.pendingActionFingerprint, kind: result.pendingActionKind },
    actionMaximum: result.actionMaximum,
    requiredAdditionalFunding: result.requiredAdditionalFunding,
    requiredCapApproval: result.requiredCapApproval,
    settledBalance: result.settledBalance,
    availableBalance: result.availableBalance,
    remainingCap: result.remainingCap,
    graceDeadlineMs: result.graceDeadlineMs,
    checkpoint: { state: result.checkpoint.state, reference: result.checkpoint.reference },
    nextRequiredAction: result.nextRequiredAction,
  });
}
function expiredContinuationStatus(checkpoint: ContinuationCheckpoint, deletion: DeletionOutcomeInput | undefined): z.infer<typeof ContinuationStatusSchema> {
  return ContinuationStatusSchema.parse({
    status: "expired",
    checkpoint: { reference: checkpoint.checkpointId },
    retentionDeadlineMs: checkpoint.retentionDeadlineMs,
    deletionState: deletion?.state ?? "not_recorded",
    nextRequiredAction: "none",
  });
}

/** Pure transport-neutral projection; every durable read is owner scoped. */
export async function readSessionStatus(input: Readonly<{ store: MeteredFundingStore; query: unknown; cursorSecret: string | Uint8Array }>): Promise<SessionStatus> {
  const query = SessionStatusQuerySchema.parse(input.query);
  const accountId = await accountIdForPrincipal(query.principal);
  const limit = query.billing?.limit ?? 50;
  let storeCursor: string | undefined;
  if (query.billing?.cursor) {
    storeCursor = await parseCursor(input.cursorSecret, query.billing.cursor, { accountId, sessionId: query.sessionId, limit });
    if (!storeCursor) return freeze(SessionStatusSchema.parse({ status: "invalid_cursor" }));
  }
  const session = await input.store.sessionStatus(accountId, query.sessionId);
  if (!session) return freeze(SessionStatusSchema.parse({ status: "not_found_or_denied" }));
  const continuationStore = input.store as MeteredFundingStore & Partial<ContinuationFundingStore>;
  const continuation = typeof continuationStore.findContinuationForSession === "function"
    ? await continuationStore.findContinuationForSession(accountId, query.sessionId)
    : undefined;
  const checkpoint = typeof continuationStore.findContinuationCheckpointForSession === "function"
    ? await continuationStore.findContinuationCheckpointForSession(accountId, query.sessionId)
    : undefined;
  const action = newestAction(await input.store.listMeteredActionsForSession(accountId, query.sessionId));
  if (!action && !continuation) return freeze(SessionStatusSchema.parse({ status: "not_found_or_denied" }));
  try {
    const [account, page] = await Promise.all([input.store.status(accountId), input.store.listBillingLineItems(accountId, { limit, ...(storeCursor ? { cursor: storeCursor } : {}) })]);
    if (!account) return freeze(SessionStatusSchema.parse({ status: "not_found_or_denied" }));
    const nextCursor = page.nextCursor ? await opaqueCursor(input.cursorSecret, { v: 1, accountId, sessionId: query.sessionId, limit, storeCursor: page.nextCursor }) : null;
    if (checkpoint?.state === "expired") {
      const deletion = typeof continuationStore.findDeletionOutcome === "function"
        ? await continuationStore.findDeletionOutcome(checkpoint.checkpointId, checkpoint.objectGeneration)
        : undefined;
      const safe = expiredContinuationStatus(checkpoint, deletion);
      return freeze(SessionStatusSchema.parse({
        status: "ok",
        session: {
          id: session.sessionId, version: session.version, state: "expired", progress: "failed",
          maximum: continuation?.result.actionMaximum ?? "0", actualSpend: "0", remainingBalance: account.available, remainingCap: "0",
          latestVerifiedArtifact: null, nextAction: "none", continuation: safe,
        },
        action: null,
        billing: { items: page.items.map(historyItem), nextCursor },
      }));
    }
    if (continuation) {
      const safe = continuationStatus(continuation);
      if (safe.status !== "needs_top_up") return freeze(SessionStatusSchema.parse({ status: "service_unavailable" }));
      return freeze(SessionStatusSchema.parse({
        status: "ok",
        session: {
          id: session.sessionId, version: session.version, state: "needs_top_up", progress: "waiting_for_funding",
          maximum: safe.actionMaximum, actualSpend: "0", remainingBalance: safe.availableBalance, remainingCap: safe.remainingCap,
          latestVerifiedArtifact: null, nextAction: safe.nextRequiredAction, continuation: safe,
        },
        action: null,
        billing: { items: page.items.map(historyItem), nextCursor },
      }));
    }
    if (!action) return freeze(SessionStatusSchema.parse({ status: "not_found_or_denied" }));
    const verifiedArtifact = (await input.store.listMeteredActionsForSession(accountId, query.sessionId))
      .filter((candidate) => candidate.artifact?.artifactId)
      .sort((left, right) => (right.artifactVersion ?? 0) - (left.artifactVersion ?? 0))[0];
    const reconciliation = action.status === "usage_unknown" || action.status === "billing_invariant_failed";
    const failed = action.status === "failed";
    const actualSpend = action.receiptCharge ?? "0";
    const remainingCap = action.remainingCap ?? "0";
    const result = SessionStatusSchema.parse({
      status: "ok",
      session: {
        id: session.sessionId, version: session.version, state: session.status, progress: safeProgress(session.status), maximum: action.maximum.toString(10), actualSpend,
        remainingBalance: action.remainingBalance ?? account.available, remainingCap,
        latestVerifiedArtifact: verifiedArtifact?.artifact?.artifactId && verifiedArtifact.artifactVersion ? { id: verifiedArtifact.artifact.artifactId, version: verifiedArtifact.artifactVersion } : null,
        nextAction: reconciliation ? "billing_reconciliation" : session.status === "active" || session.status === "prepared" ? "wait_for_current_action" : "revise_session",
        continuation: null,
      },
      action: {
        id: action.actionId, operationId: action.operationId, state: action.status,
        authorization: { reference: action.actionBudgetReference, maximum: action.maximum.toString(10) }, price: { cardId: action.priceCardId, profileId: action.profileId },
        reconciliation: { state: action.reconciliationClaimed ? "claimed" : reconciliation ? "pending" : "not_required", evidenceId: null },
        diagnostic: { code: action.status === "usage_unknown" ? "usage_unknown" : action.status === "billing_invariant_failed" ? "billing_invariant_failed" : failed ? "action_failed" : "none", evidenceId: null },
      },
      billing: { items: page.items.map(historyItem), nextCursor },
    });
    return freeze(result);
  } catch { return freeze(SessionStatusSchema.parse({ status: "service_unavailable" })); }
}
