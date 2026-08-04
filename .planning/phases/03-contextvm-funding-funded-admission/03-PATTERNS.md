# Phase 3: ContextVM Funding & Funded Admission - Pattern Map

**Mapped:** 2026-08-04  
**Files classified:** 15 likely implementation/evaluation files  
**Analogs found:** 12 / 15

Phase 3 has no phase research file yet. This map is intentionally derived from the locked Phase 3 context and the completed Phase 2 executable seams; planners should reconcile proposed names with `03-RESEARCH.md` when it arrives without changing the boundary assignments below.

## File Classification

| Likely new/modified file | Role | Data flow | Closest analog | Match quality |
|---|---|---|---|---|
| `src/phase-03/contracts.ts` | contracts/schema | request-response | `src/phase-02/contracts.ts` | exact boundary-schema pattern |
| `src/domain/account-command.ts` | model/utility | transform | `src/domain/session-action.ts` | exact fingerprint pattern |
| `src/persistence/account-store.ts` | store/port | CRUD/transactional | `src/persistence/session-store.ts` | exact port/test-double split |
| `src/persistence/sqlite-account-store.ts` | store/reference adapter | CRUD/transactional | `src/persistence/sqlite-session-store.ts` | mechanics only; **not** production monetary authority |
| `src/funding/funded-admission.ts` | service | request-response/transactional | `src/domain/session-service.ts`, `src/phase-02/trusted-core.ts` | role-match |
| `src/funding/settlement-intent.ts` | service | event-driven/external effect | `src/capabilities/scoped-tool-gateway.ts` | exact intent-before-I/O pattern |
| `src/funding/lightning-provider.ts` | provider adapter | request-response | `src/worker-adapters/modal-worker.ts` | adapter boundary match |
| `src/funding/cashu-provider.ts` | provider adapter | request-response | `src/worker-adapters/modal-worker.ts` | adapter boundary match |
| `src/contextvm/adapter.ts` | transport adapter | event-driven/request-response | no close ContextVM analog | no analog; use strict Phase 2 parser boundary |
| `src/contextvm/announcement.ts` | transport utility | transform | `src/promotion/schema.ts` | strict parsing/canonical output match |
| `src/evidence/account-evidence.ts` | evidence utility | file-I/O/transform | `src/evidence/bundle.ts` | exact immutable-bundle pattern |
| `src/phase-03/funded-core.ts` | composition/provider | request-response | `src/phase-02/trusted-core.ts` | exact composition pattern |
| `src/verification/phase-03-design-evidence.ts` | verification/eval | transform | `src/verification/phase-02-design-evidence.ts` | exact design-evidence pattern |
| `tests/persistence/account-store.test.ts` | test | transactional | `tests/persistence/sqlite-session-store.test.ts` | exact state/replay test shape |
| `tests/evals/phase-03-reference-set.test.ts` plus fixture JSON | eval/test | batch/state matrix | `tests/evals/phase-02-reference-set.test.ts` | exact deterministic-matrix pattern |

## Pattern Assignments

### `src/phase-03/contracts.ts` — strict transport-neutral contracts

**Analog:** `src/phase-02/contracts.ts` (lines 30-75)

Use closed, `.strict()` Zod schemas and a discriminated union at the authority-bearing boundary. Parse signed transport data in the ContextVM adapter, then create only normalized account/top-up/admission commands for the core.

```ts
const ToolIdentitySchema = CorrelationSchema.extend({
  callId: z.string().min(1),
  evidenceId: z.string().min(1),
});
export const ToolRequestSchema = z.discriminatedUnion("tool", [ /* strict variants */ ]);
```

**Do not copy:** `WorkerToolRequestSchema` (compatibility-only open-ended tracer contract). Financial commands must remain closed and transport protocol types must not appear in the core schema.

### `src/domain/account-command.ts` — canonical fingerprint/idempotency binding

**Analog:** `src/domain/session-action.ts` (lines 55-66)

Bind principal/account, command kind, client idempotency key, policy version, and a canonical payload hash. Persist and compare this request fingerprint before anything that could reserve, credit, or call a payment rail.

```ts
const payloadHash = await sha256(canonicalJson(action.payload));
return sha256(canonicalJson({
  principalId: action.principal.id,
  sessionId: action.sessionId,
  kind: action.kind,
  idempotencyKey: action.idempotencyKey,
  expectedVersion: action.expectedVersion,
  policyVersion: action.policyVersion,
  payloadHash,
}));
```

For account commands replace session/version fields only where the Phase 3 command model requires it; do not omit account, command kind, or policy/version binding.

### `src/persistence/account-store.ts` — financial authority port

**Analog:** `src/persistence/session-store.ts` (lines 42-60)

Make the port explicit about replay-before-effect, durable intent, and transactional application. Keep the in-memory implementation clearly test-only; production composition must inject a relational monetary authority.

```ts
findRecordedResult(action: SessionAction): Promise<SessionActionResult | undefined>;
claimEffectIntent(action, lease, callId, requestFingerprint, nowMs): Promise<EffectIntentClaim>;
completeEffectIntent(operationId: string): Promise<boolean>;
markEffectIntentUnknown(operationId: string): Promise<void>;
apply(action, evaluate, lease?, nowMs?): Promise<SessionActionResult>;
```

The Phase 3 equivalent needs one serializable transaction that includes command result, ledger postings, hold/reservation projection, external-reference uniqueness, and outbox record. Adapter/provider interfaces must not obtain a ledger-posting method.

### `src/persistence/sqlite-account-store.ts` — reference mechanics only

**Analog:** `src/persistence/sqlite-session-store.ts` (lines 23-89, 100-172, 194-241)

Copy the useful mechanics: unique `(scope, idempotency_key)` result rows, compare-request-fingerprint replay, durable intent before I/O, explicit `uncertain` state, and the final version/authority fence in the transaction.

```ts
const existing = /* lookup by durable idempotency scope */;
if (!existing) return undefined;
const requestFingerprint = await fingerprintSessionRequest(action);
return existing.request_fingerprint === requestFingerprint
  ? freeze(copy(JSON.parse(existing.result_json)))
  : denial("IDEMPOTENCY_KEY_CONFLICT");
```

**Do not copy as production design:** Bun SQLite serialization (`#tail`), local-file durability, SQLite busy handling, or `SqliteSessionStore` as monetary truth. Phase 3 requires the relational serializable ledger port described by D-44; SQLite may only be a focused reference/test implementation.

### `src/funding/settlement-intent.ts` — provider I/O ambiguity

**Analog:** `src/capabilities/scoped-tool-gateway.ts` (lines 117-150)

Persist the intent first. Only a newly-created intent permits an external recipient call; prior/ambiguous intents are not retry permits. Complete the intent only after the authoritative provider result is committed; otherwise mark it uncertain/reconciliation-pending.

```ts
const intent = await this.#effectIntents.claim(request.callId, requestFingerprint);
if (intent.status === "completed" && intent.operationId) return replayResult;
if (intent.status !== "created" || !intent.operationId) return this.deny("TOOL_EFFECT_UNCERTAIN", request);
try {
  const effect = await this.dispatcher.dispatch(request, context);
  if (!await this.#effectIntents!.complete(intent.operationId)) {
    await this.#effectIntents!.markUnknown(intent.operationId);
    return this.deny("TOOL_EFFECT_UNCERTAIN", request);
  }
} catch {
  await this.#effectIntents!.markUnknown(intent.operationId);
}
```

Map `unknown` to the Phase 3 explicit `reconciliation_pending` lifecycle. Never resend opaque invoice creation, Cashu redemption, or credit after a timeout.

### `src/funding/lightning-provider.ts` and `src/funding/cashu-provider.ts` — provider adapters

**Analog:** `src/worker-adapters/modal-worker.ts` (lines 369-372)

Parse configuration at construction and retain an adapter-facing interface; do not import provider/SDK types into domain commands or ledger records.

```ts
export async function createModalWorkerAdapter(config: unknown): Promise<ModalWorkerAdapter> {
  const parsed = ModalWorkerConfigSchema.parse(config);
  return new ModalWorkerAdapter(parsed, await productionModalSdk());
}
```

Use rail-specific verified settlement observations (not raw tokens, proofs, preimages, or secrets). The funded-account service alone decides whether a verified observation can atomically credit the ledger.

### `src/contextvm/adapter.ts` and `src/contextvm/announcement.ts` — signed transport boundary

**Closest analog:** strict parser boundary in `src/phase-02/contracts.ts` (lines 30-75); canonical parser/output conventions in `src/promotion/schema.ts`.

There is no existing ContextVM adapter. Keep all ContextVM, CEP-8, PMI, event/replay, and SDK types inside this folder. Verify an event before deriving the normalized principal from the verified sender public key; never use payload-claimed identity. The announcement must advertise only v1 capabilities that exist and must not expose x402/L402 endpoints.

### `src/evidence/account-evidence.ts` — immutable, redacted evidence

**Analog:** `src/evidence/bundle.ts` (lines 76-90)

```ts
const evidenceSha256 = await sha256(canonicalJson(input));
const bundle = { version: 1, ...input, evidenceSha256 };
const content = `${canonicalJson(bundle)}\n`;
try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
catch (error) {
  if (error.code !== "EEXIST") throw error;
  if ((await readFile(path, "utf8")) !== content) throw new Error("immutable evidence bundle collision");
}
```

Apply a Phase 3 redaction gate before hashing/writing. Ordinary status/evidence may contain safe display references and hashes, but never Cashu bearer tokens/proofs, Lightning preimages, provider credentials, or raw confidential rail payloads.

### `src/phase-03/funded-core.ts` — phase composition

**Analog:** `src/phase-02/trusted-core.ts` (lines 319-342)

Validate mutually exclusive production-vs-test dependencies at composition time, construct a real authority by default, allow explicit in-memory/double injection only in tests, and return an immutable composition with a controlled close hook.

```ts
if (!options.store && (!options.databasePath || options.databasePath.trim() === "")) throw new Error(/* production authority required */);
if (options.store && options.databasePath) throw new Error(/* one authority only */);
const store = options.store ?? new SqliteSessionStore(options.databasePath!);
return freeze({ core, store, close: () => { /* controlled cleanup */ } });
```

For Phase 3, name the real implementation after the relational ledger authority—not `SqliteSessionStore`—and do not wire Phase 2 workers directly from the ContextVM adapter.

### `src/verification/phase-03-design-evidence.ts` — deterministic evidence verdict

**Analog:** `src/verification/phase-02-design-evidence.ts` (lines 65-92)

Build an allowlisted check set, reject missing/duplicate/unknown checks, validate digest shapes, reject forbidden raw-payment fields recursively, compute the immutable evidence digest last, and separate an offline-design result from a real provider certification.

```ts
if (input.checks.length !== REQUIRED_CHECK_IDS.length ||
    new Set(input.checks.map((check) => check.id)).size !== REQUIRED_CHECK_IDS.length ||
    REQUIRED_CHECK_IDS.some((id) => !input.checks.some((check) => check.id === id))) {
  add(reasons, "deterministic check identity set is incomplete, duplicate, or unknown");
}
```

### Phase 3 tests and deterministic evaluation

**Analogs:** `tests/persistence/sqlite-session-store.test.ts` (lines 24-72), `tests/capabilities/scoped-tool-gateway.test.ts` (lines 53-96), and `tests/evals/phase-02-reference-set.test.ts` (lines 62-120).

Use one test per financial invariant, including exact replay with no second credit/hold, conflicting idempotency-key reuse, duplicate callbacks, provider ambiguity, rejected capacity with no queue/stranded hold, ledger/outbox atomic rollback, Cashu policy-version pinning, raw-secret redaction, and provider adapter inability to post value. The reference set should execute against the final composition and assert results, state deltas, external effect count, ledger/outbox records, and redacted evidence.

## Shared Patterns

### Immutable return values and evidence

**Sources:** `src/persistence/session-store.ts` (lines 80-111) and `src/phase-02/trusted-core.ts` (lines 319-342).

Return frozen copies at authority boundaries. Do not allow callers to mutate stored command results, balance projections, holds, or evidence after the transaction.

### Replay ordering

**Sources:** `src/persistence/sqlite-session-store.ts` (lines 100-105, 194-208) and `src/capabilities/scoped-tool-gateway.ts` (lines 92-116).

Lookup the durable command result and compare its canonical request fingerprint before allocating capacity or performing provider I/O. Exact replay returns the durable result; key reuse with a changed command fails closed.

### External effects and leases/intents

**Sources:** `src/persistence/session-store.ts` (lines 48-58) and `src/persistence/sqlite-session-store.ts` (lines 144-185).

Treat all relay delivery and settlement callbacks as at-least-once. Persist a uniquely constrained intent before provider I/O and make an unknown outcome an explicit durable state; never assume a receiver did not act.

### Provider separation

**Sources:** `src/worker-adapters/modal-worker.ts` (lines 369-372) and `src/phase-02/contracts.ts` (lines 30-75).

Adapters parse untrusted provider/transport inputs and return normalized observations. They do not receive database credentials, ledger mutation authority, or unrestricted ability to make a settlement spendable.

## No Analog Found

| File/responsibility | Role | Data flow | Reason and planner direction |
|---|---|---|---|
| ContextVM signed-event verification and capability announcement | transport adapter | event-driven | No ContextVM implementation exists. Follow strict Zod/domain-boundary patterns, then research pinned SDK behavior. |
| CEP-8 Lightning/Cashu wire negotiation | provider/transport adapter | request-response | No payment rail exists. Keep wire types at adapter boundary and model normalized observations only. |
| Serializable append-only production ledger with transaction outbox | financial store | transactional | Existing SQLite store is a state-machine reference, not a production-money analog. Research the selected SQL/Kysely transaction semantics before planning. |
| Cashu trusted-mint/keyset/proof validation | provider policy | request-response | No analogous cryptographic settlement validator exists. Create deterministic fixtures and explicit reconciliation states. |

## Metadata

**Analog search scope:** `src/`, `tests/`, and Phase 2 planning context  
**Graph evidence:** `get_architecture`, `search_graph`, `trace_path`, and `get_code_snippet` against project `napplet-cvm`  
**Pattern extraction date:** 2026-08-04
