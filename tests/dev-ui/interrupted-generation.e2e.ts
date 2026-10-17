import { recoverRecordedReceipt } from "../../src/dev/receipt-recovery";
import { listOperatorJobs, readOperatorJob } from "../../src/dev/operator-jobs";
/** Real SQL recovery policy, with deterministic model transport; no paid inference. */
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { PostgresSqlFundingStore } from "../../src/persistence/postgres-sql-funding-store";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { InterruptedDevelopmentGeneration } from "../../src/dev/interrupted-generation";
import { ChatGptModelGateway, SqlChatGptOperations } from "../../src/dev/chatgpt-model-gateway";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { registerDevelopmentPricing } from "../../src/dev/register-development-pricing";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import type { ProviderOperationIntent } from "../../src/model/model-gateway";
import { chatGptFixture } from "../fixtures/chatgpt";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const assert = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const stack = developmentStack(true); const config = await stack.up();
const pool = createDevelopmentPool(config.databaseUrl);
try {
  const store = new PostgresSqlFundingStore(pool, { deadlineMs: 5000 });
  const funding = new FundingService(store);
  const principal = { pubkey: "ef".repeat(32) }; const account = await accountIdForPrincipal(principal);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "recover-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "recover-topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "recover-external", settlementReference: "recover-settlement", verifiedAt: new Date().toISOString() } } });
  const fundedAdmission = new FundedAdmissionService({ funding, store, receiptAuthority: trustedAdmissionReceiptAuthority,
    capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, intentReference, "2026-10-17T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, intentReference, "2026-10-17T00:00:00.000Z"), release: async () => {} },
    now: () => Date.parse("2026-10-16T00:00:00.000Z"),
  });
  const fixture = chatGptFixture(); fixture.setInferenceMode("cut");
  const proposals = new SourceProposalStore(pool); const operations = new SqlChatGptOperations(pool);
  const gateway = new ChatGptModelGateway({ accountId: "fixture-account", model: "fixture-codex", auth: { accessToken: async () => "fixture-token" }, operations, store: proposals, fetch: fixture.fetch });
  await registerDevelopmentPricing(pool, { profile: gateway.pricing.profile, priceCard: gateway.pricing.card });
  const recovery = new InterruptedDevelopmentGeneration(pool, store);
  const intents = new Map<string, ProviderOperationIntent>();
  let crashAfterResponse = false;
  let beforeDispatch: ((intent: ProviderOperationIntent) => Promise<void>) | undefined;
  const service = new MeteredGenerationService({ fundedAdmission, store, pricing: gateway.pricing,
    gateway: { dispatch: async (intent, signal) => { intents.set(intent.actionId, intent); await beforeDispatch?.(intent); const result = await gateway.dispatch(intent, signal); if (crashAfterResponse) throw new Error("crash after receipt saved"); return result; }, lookup: (intent, signal) => gateway.lookup(intent, signal) },
    worker: { run: async () => { throw new Error("PARTIAL_OUTPUT_BUILT"); } }, artifactVerifier: { verify: async () => undefined },
  });
  async function command(key: string) {
    const input = { principal, idempotencyKey: `admit-${key}`, policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "395", unit: "sat" as const } };
    const admission = await fundedAdmission.admit(input, await trustedAdmissionReceipt(input));
    if (admission.status !== "accepted") throw new Error("ADMISSION_FAILED");
    return { principal, admissionReference: admission.reference, idempotencyKey: key, expectedVersion: 0 as const, maximum: "395", policyVersion: "development-local-v1", idea: "A focused timer" };
  }
  const original = await command("ended"); const ended = await service.startSession(original);
  if (ended.status !== "usage_unknown") throw new Error("EXPECTED_UNKNOWN");
  assert(await recovery.recover("other-account", ended.sessionId) === undefined, "FOREIGN_OWNER_RECOVERED");
  assert((await store.sessionStatus(account, ended.sessionId))?.status === "usage_unknown", "FOREIGN_OWNER_CHANGED_SESSION");
  const recovered = await Promise.all([recovery.recover(account, ended.sessionId), recovery.recover(account, ended.sessionId)]);
  assert(recovered.some(value => value?.status === "failed" && value.code === "MODEL_RESPONSE_INTERRUPTED"), "RECOVERY_FAILED");
  assert((await service.startSession(original)).status === "failed" && fixture.counts().inferences === 1, "REPLAY_DISPATCHED");
  assert((await store.sessionStatus(account, ended.sessionId))?.version === 0, "FAILED_VERSION_ADVANCED");
  const evidence = (await pool.query("SELECT (SELECT count(*) FROM billing_line_items WHERE operation_id=$1 AND kind='release') AS releases,(SELECT count(*) FROM ledger_entries WHERE direction='debit' AND account_id=$2) AS debits,(SELECT observation_json->>'status' FROM development_chatgpt_operations WHERE operation_id=$1) AS original", [ended.operationId, account])).rows[0];
  assert(evidence.releases === "1" && evidence.debits === "0" && evidence.original === "usage_unknown", "DOUBLE_RELEASE_OR_FENCE_CHANGED");

  // A live request and a crash after claim have no durable terminal observation.
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  beforeDispatch = async () => { started(); await gate; };
  const liveCommand = await command("live"); const liveRun = service.startSession(liveCommand); await entered;
  const live = await store.findMeteredAction(account, "live");
  assert(live && await recovery.recover(account, live.sessionId) === undefined && (await store.sessionStatus(account, live.sessionId))?.status === "active", "LIVE_REQUEST_RELEASED");
  release(); await liveRun;
  beforeDispatch = async intent => { await operations.claim(intent); };
  const crash = await service.startSession(await command("crash"));
  assert(crash.status === "usage_unknown" && await recovery.recover(account, crash.sessionId) === undefined && fixture.counts().inferences === 2, "UNFINISHED_CLAIM_RELEASED_OR_DISPATCHED");

  // Retained source is left available for exact-operation recovery, never waived away.
  beforeDispatch = undefined;
  const cached = await service.startSession(await command("cached"));
  if (cached.status !== "usage_unknown") throw new Error("EXPECTED_CACHED_UNKNOWN");
  const action = await store.findMeteredAction(account, "cached"); const intent = intents.get(action!.actionId)!;
  await proposals.persist({ intent, provider: gateway.pricing.card.provider, model: gateway.pricing.profile.model, proposal: { files: fixture.files(1) } });
  assert(await recovery.recover(account, cached.sessionId) === undefined, "SAVED_SOURCE_DISCARDED");
  assert((await store.sessionStatus(account, cached.sessionId))?.status === "usage_unknown", "CACHED_SOURCE_FENCE_REMOVED");

  if (crash.status !== "usage_unknown") throw new Error("Expected crash state");
  const missingAction = await store.findMeteredActionByOperation(account, crash.operationId);
  assert((await recoverRecordedReceipt(pool, store, missingAction!.actionId)).outcome === "missing", "MISSING_RECEIPT_FABRICATED");
  assert((await store.findMeteredActionByOperation(account, crash.operationId))?.status === "usage_unknown", "MISSING_RESERVATION_RELEASED");
  fixture.setInferenceMode("complete"); crashAfterResponse = true;
  const journalCommand = await command("journal-crash");
  const journalResult = await service.startSession(journalCommand);
  assert(journalResult.status === "usage_unknown", "CRASH_NOT_FENCED");
  const journalAction = await store.findMeteredAction(account, "journal-crash");
  assert(await recovery.recover(account, journalAction!.sessionId) === undefined, "KNOWN_USAGE_WAIVED");
  const beforeCalls = fixture.counts().inferences;
  const found = await Promise.all([recoverRecordedReceipt(pool, store, journalAction!.actionId), recoverRecordedReceipt(pool, store, journalAction!.actionId)]);
  assert(found.some(result => result.outcome === "settled" && result.charged === "3"), "ORIGINAL_PRICE_NOT_SETTLED");
  assert((await recoverRecordedReceipt(pool, store, journalAction!.actionId)).outcome === "not_required", "RECOVERY_NOT_IDEMPOTENT");
  const charge = (await pool.query("SELECT count(*)::int AS n,sum(amount_sat)::text AS amount FROM billing_line_items WHERE action_id=$1 AND kind='debit'", [journalAction!.actionId])).rows[0];
  assert(charge.n === 1 && charge.amount === "-3" && fixture.counts().inferences === beforeCalls, "DUPLICATE_DEBIT_OR_REDISPATCH");
  const all: any = await listOperatorJobs(pool, "all", 0, "");
  const review: any = await listOperatorJobs(pool, "review", 0, "");
  assert(all.total > review.total && review.jobs.every((row: any) => row.category === "review" && row.held_sat === "395"), "JOB_CATEGORIES_INCORRECT");
  const filtered: any = await listOperatorJobs(pool, "all", 0, journalAction!.actionId);
  assert(filtered.total === 1 && filtered.jobs[0].receipt_charge === "3", "JOB_SEARCH_OR_COST_INCORRECT");
  assert((await listOperatorJobs(pool, "all", 0, "%' OR 1=1 --")).total === 0, "SEARCH_NOT_LITERAL");
  const detail: any = await readOperatorJob(pool, journalAction!.actionId, "action");
  assert(detail.usage_receipt.usage[0].units === "1200" && detail.held_sat === "0", "DETAIL_RECEIPT_MISSING");
  console.log(JSON.stringify({ status: "passed", case: "interrupted-generation", checks: ["SQL owner isolation", "concurrent exact-once release", "immutable dispatch fence", "replay without inference", "live request retained", "unfinished claim retained", "saved source retained", "zero local charge", "receipt journal crash recovery", "exact-once three-sat debit", "missing receipt holds retained", "All/search/review SQL", "receipt detail"] }));
} finally { await pool.end(); await stack.down(true); }
