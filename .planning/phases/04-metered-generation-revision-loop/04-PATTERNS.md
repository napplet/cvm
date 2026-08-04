# Phase 04: Metered Generation & Revision Loop - Pattern Map

**Mapped:** 2026-08-04  
**Files classified:** 25 (including the required test/evidence surfaces)
**Analogs found:** 24 / 25

## File Classification

| New/Modified File | Role | Data flow | Closest analog | Match |
|---|---|---|---|---|
| `src/phase-04/metered-generation-service.ts` | service | request-response / event-driven | `src/phase-02/trusted-core.ts` | role + lifecycle |
| `src/phase-04/session-status.ts` | service | transform | `src/funding/account-status.ts` | role-match |
| `src/phase-04/repair-policy.ts` | policy | transform | `src/policy/phase-02-policy.ts` | role-match |
| `src/model/model-gateway.ts` | port/schema | request-response | `src/phase-02/contracts.ts` | role-match |
| `src/model/deterministic-model-gateway.ts` | adapter/test fake | request-response | `src/worker-port/fake-worker.ts` | role-match |
| `src/model/price-card.ts` | utility/model | transform | `src/funding/funded-admission.ts` | partial |
| `src/persistence/funding-store.ts` | persistence port | CRUD | itself / `funded-admission.ts` consumer | extension |
| `src/persistence/postgres-sql-funding-store.ts` | persistence adapter | CRUD | itself | exact extension |
| `src/persistence/postgres-funding-database.ts` | persistence composition | CRUD | itself | exact extension |
| `migrations/phase-04/*.sql` | migration | batch | `migrations/phase-03/001_funding.sql` | exact family |
| `src/funding/funded-admission.ts` | service | request-response | itself | exact extension |
| `src/phase-03/funded-core.ts` | composition | request-response | itself | exact extension |
| `src/contextvm/adapter.ts` | transport adapter | request-response | itself | exact extension |
| `src/verification/phase-04-design-evidence.ts` | verification/evidence | file-I/O / transform | `src/verification/phase-03-design-evidence.ts` | exact |
| `scripts/verify-phase-04-design-slice.ts` | config/evidence script | batch / file-I/O | `scripts/verify-phase-03-design-slice.ts` | exact |
| `package.json` | config | batch | existing scripts | exact extension |
| `tests/billing/{price-card,operation-finalization,line-items}.test.ts` | tests | transform / CRUD | `tests/funding/funded-admission.test.ts` | role-match |
| `tests/model/reconciliation.test.ts` | fault-injection test | request-response | `tests/funding/lightning-top-up.test.ts` | lifecycle-match |
| `tests/phase-04/{tracer,session-status,revision,repair,artifact-outcome}.test.ts` | integration/contract tests | request-response | `tests/phase-03/tracer.test.ts`, `tests/phase-02/tracer.test.ts` | exact family |
| `tests/evals/phase-04-reference-set.test.ts` | reference-eval test | batch / transform | `tests/evals/phase-03-reference-set.test.ts` | exact |
| `tests/fixtures/phase-04-reference-set.json` | fixture config | transform | `tests/fixtures/phase-03-reference-set.json` | exact |

## Pattern Assignments

### `src/phase-04/metered-generation-service.ts` and the single `FundingStore` authority

**Analogs:** `src/phase-02/trusted-core.ts`, `src/domain/session-action.ts`, `src/persistence/session-store.ts`.

**Replay identity before effects** — `src/domain/session-action.ts:50-72`:

```ts
// Stable identity available before a worker is started. It deliberately
// excludes the verified artifact: a lost-response retry must find the durable
// result before recreating a worker proposal.
export async function fingerprintSessionRequest(action: SessionAction) {
  const payloadHash = await sha256(canonicalJson(action.payload));
  return sha256(canonicalJson({ principalId: action.principal.id, sessionId: action.sessionId,
    kind: action.kind, idempotencyKey: action.idempotencyKey,
    expectedVersion: action.expectedVersion, policyVersion: action.policyVersion, payloadHash }));
}
```

Keep the existing request/action fingerprint split. Add the Phase 4 action, operation, receipt, artifact-lineage, and result fields to durable records; do not make a worker result or model observation the commit authority. `src/persistence/metered-session-store.ts` is explicitly not created: Phase 4 extends `src/persistence/funding-store.ts` plus its memory and PostgreSQL implementations so session/action/ledger/artifact state commits under one database-owned transactional authority.

**Worker/artifact ordering** — `src/phase-02/trusted-core.ts:246-277`:

```ts
workerResult = WorkerRunResultSchema.parse(await this.dependencies.worker.run(
  WorkerRunRequestSchema.parse(request), signal));
...
const verificationLease = await this.dependencies.store.assertWorkerLease(replayAction, lease.lease, this.dependencies.now());
if (!verificationLease.authorized) return sessionResult(verificationLease.result);
const facts = freeze({ action, request, result: workerResult, events: freeze(events) });
const verified = await this.dependencies.artifactVerifier.verify(facts);
if (!verified || !verifiedArtifactIsValid(verified)) return asFailure("ARTIFACT_CONTRACT_BLOCKED", ...);
const artifact = await evaluateArtifactContract(verified.contractInput);
if (artifact.verdict !== "pass") return asFailure("ARTIFACT_CONTRACT_BLOCKED", ...);
```

Phase 4 must preserve this order after model settlement: coordinator parses worker values, reasserts lease/version, runs server-owned artifact gates, then makes the single terminal commit. Failed/unknown actions store a replayable outcome but retain the old verified artifact.

### `src/model/model-gateway.ts`, `src/model/deterministic-model-gateway.ts`, and `src/model/price-card.ts`

**Analogs:** strict port schemas in `src/phase-02/contracts.ts`; deterministic boundary fake in `src/worker-port/fake-worker.ts`; strict sat input in `src/funding/funded-admission.ts:7-14`.

Use `.strict()` Zod schemas and inferred types at the adapter boundary. `ModelGateway.dispatch(intent, signal)` must accept only a persisted, server-generated operation intent and return a normalized receipt or explicit ambiguous observation; `lookup(intent)` is the only reconciliation route and must never dispatch a replacement request. Keep provider-native payloads as protected evidence references.

**Integer-boundary convention** — `src/funding/funded-admission.ts:7-14,127-138`:

```ts
const SatSchema = z.string().regex(/^[1-9][0-9]*$/u)
  .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
...
const action = existing ?? await transaction.reserveActionBudget({
  accountId, admissionReference: command.admissionReference, idempotencyKey: command.idempotencyKey,
  fingerprint: actionFingerprint, reference: `action-budget:${await hash(actionKey)}`,
  amount: BigInt(command.maximum),
});
return freeze({ status: "authorized" as const, ... , reservedAmount: action.amount.toString(), unit: "sat" as const });
```

Use decimal strings at public/store boundaries and `bigint` for all rate, unit, reservation, quotient, remainder, debit, and release calculations. No `number` or current-price lookup may influence settlement.

### Deliberate single-database funding, session, and artifact authority

**Analogs:** `src/funding/funded-admission.ts`, `src/persistence/funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, and `tests/persistence/postgres-sql-funding-store.test.ts:16-33`.

**Transaction ownership:** retain the `FundingStore.transact(accountId, callback)` pattern. Extend its narrow transaction interface and the existing memory/PostgreSQL implementations with session/action, operation-intent, sub-reservation, finalization, reconciliation, and verified-artifact methods. Do not create a separate metered-session store or a second database capability. The one terminal transaction must fence operation ID and provider receipt identity, settle receipt-derived charge, release unused reservation, append balanced immutable postings/evidence/outbox, persist the action result, and advance artifact only when all gates passed.

**Serializable SQL discipline** — `tests/persistence/postgres-sql-funding-store.test.ts:16-23` asserts the production adapter uses:

```ts
expect(client.sql.filter((sql) => sql === "BEGIN ISOLATION LEVEL SERIALIZABLE")).toHaveLength(2);
expect(client.sql.filter((sql) => sql === "ROLLBACK")).toHaveLength(2);
```

Keep bounded retry/deadline behavior (`:26-33`). SQL retries may retry only the local transaction; they must never re-run a provider dispatch.

### `src/contextvm/adapter.ts` and Phase 3 composition

**Analogs:** `src/contextvm/adapter.ts:14-28,102-119,122-178` and `src/phase-03/funded-core.ts:44-106`.

**Thin edge schema and error handling**:

```ts
const RequestSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]), method: z.literal("tools/call"),
  params: z.object({ name: z.enum(["account_status", "top_up", "funded_admission"]),
    arguments: z.unknown(), _meta: z.unknown().optional() }).strict(),
}).strict();
...
try { ... await this.options.transport.sendResponse(principal.pubkey, response, envelope.requestEventId); }
catch { if (!correlation) return; await this.options.transport.sendResponse(correlation.clientPubkey,
  freeze({ jsonrpc: "2.0" as const, id: responseId,
    error: { code: -32602, message: "invalid ContextVM funding request" } }), correlation.requestEventId); }
```

Add `start_session`, `revise_session`, and `session_status` as separately strict command schemas and inject a transport-neutral Phase 4 facade through `createFundedCore`; no ContextVM type enters the core.

**Response projection allowlist** — `src/contextvm/adapter.ts:161-178`:

```ts
const railResult = RailTopUpResultSchema.parse(result);
const wireResult = freeze({ topUpId: railResult.topUpId, state: railResult.state,
  ...(railResult.status ? { status: railResult.status } : {}),
  ...(railResult.amount ? { amount: railResult.amount } : {}),
  ...(railResult.safeDisplayReference ? { safeDisplayReference: railResult.safeDisplayReference } : {}) });
```

Build Phase 4 status field-by-field from a server projection. Never spread domain records or pass through provider receipts, prompts, source, grants, credentials, raw evidence, or model output.

### `src/phase-04/session-status.ts` and `src/phase-04/repair-policy.ts`

**Analogs:** `src/funding/account-status.ts` for owner-scoped status and `src/policy/phase-02-policy.ts` for frozen, versioned policy objects.

Status must derive from durable session/action/financial/evidence projections and use public decimal strings. Billing-history page limits are 1–50 and default to 50; order by immutable ascending commit sequence plus stable item ID. Use an opaque, versioned, integrity-protected owner/session/query-bound cursor that resumes after the last sequence/item, and return generic `invalid_cursor` without data for invalid or foreign cursors. All committed financial line items remain traversable and immutable; public status exposes normalized items/evidence IDs only, never protected provider-native payloads. Repair policy must be a coordinator-only versioned decision over originating action, validation report, and repair count; it returns denial after one automatic repair rather than looping.

### Phase 4 evidence and verifier script

**Analog:** `src/verification/phase-03-design-evidence.ts:52-101` and `scripts/verify-phase-03-design-slice.ts:10-64`.

**Immutable evidence pattern**:

```ts
const { evidence } = await evaluatePhase03Design(input);
await validatePhase03DesignEvidence(evidence);
await mkdir(directory, { recursive: true });
const content = `${canonicalJson(evidence)}\n`;
const path = `${directory}/${evidence.evidenceSha256}.json`;
try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
catch (error) { ... if (await readFile(path, "utf8") !== content) throw new Error("immutable Phase 03 design evidence collision"); }
```

Copy this create-or-verify content-addressed write. Phase 4's forbidden scan must additionally reject prompts, source, raw provider payloads, chain-of-thought, grants, and credentials. Its required IDs must map BILL-03--05, SESS-01/03/04, GEN-05/06, D-59--78, and provider observations that remain unselected/eligible-not-selected—not a live-provider claim.

### Tests, fixtures, and `package.json`

**Analogs:** `tests/phase-03/tracer.test.ts`, `tests/evals/phase-03-reference-set.test.ts:190-220`, `scripts/verify-phase-03-design-slice.ts:44-51`.

Use Bun's `expect`/`test` imports, in-process deterministic fakes, fixture-bound oracles, and explicit effect counters. Add fault injection at pre-dispatch, post-acceptance/lost response, malformed receipt, price mismatch, settlement retry, artifact-validation failure, repair exhaustion, duplicate, stale-version, and foreign-owner boundaries. Assert no second gateway invocation/debit/artifact advance, not merely an error code.

Add stable `eval:phase04` and `verify:phase04-design` scripts following the Phase 3 script chain. They must run without credentials or live provider selection.

## Shared Patterns

### Single-writer and durable intent

**Sources:** `src/funding/funded-admission.ts:127-138`; `src/domain/session-action.ts:50-72`; `src/phase-02/trusted-core.ts:301-307`.

Persist/replay fingerprinted intent before each external effect; check expected version/lease immediately before terminal commit; exact duplicates replay durable result and conflicts perform zero model, worker, ledger, or artifact effect.

### Authorization and monetary settlement

**Sources:** `src/funding/funded-admission.ts:127-138`; `src/persistence/funding-store.ts`; `tests/persistence/postgres-sql-funding-store.test.ts:16-33`.

Action budgets remain a Phase 3 cap-hold extension. Phase 4 must introduce operation sub-reservations and immutable price-card settlement inside the funding transaction. `usage_unknown` and `billing_invariant_failed` freeze later billable work; only proven pre-dispatch zero use may release without a receipt.

### Strict boundaries and redaction

**Sources:** `src/contextvm/adapter.ts:14-28,161-178`; `src/phase-02/trusted-core.ts:246-277`; `src/verification/phase-03-design-evidence.ts:37-42`.

Parse all boundary values with strict schemas, construct public responses explicitly, and scan evidence recursively for prohibited data. Worker/model/provider payloads are untrusted and cannot select tools, pricing, policy, session lifecycle, or publication state.

### Evidence and tests

**Sources:** `src/verification/phase-03-design-evidence.ts:89-101`; `scripts/verify-phase-03-design-slice.ts:44-64`; `tests/evals/phase-03-reference-set.test.ts:190-220`.

Deterministic tests are the design authority. Evidence is content-addressed, immutable, and redacted; provider observations remain design-stage eligibility, never production selection.

## No Analog Found

| File | Role | Data flow | Reason |
|---|---|---|---|
| `src/model/price-card.ts` | utility/model | transform | No existing rational multi-dimension pricing module; copy bigint boundary discipline only. |

## Metadata

**Analog search scope:** `src/{phase-02,phase-03,funding,persistence,contextvm,verification,domain,policy,worker-port}`, `scripts`, and `tests`.  
**Files scanned:** 18 primary analog and test files.  
**Pattern extraction date:** 2026-08-04
