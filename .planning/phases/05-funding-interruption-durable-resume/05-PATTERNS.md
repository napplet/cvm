# Phase 5: Funding Interruption & Durable Resume - Pattern Map

**Mapped:** 2026-08-05  
**Files analyzed:** 25 planned new/modified files  
**Analogs found:** 25 / 25

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/continuity/contracts.ts` | model / utility | transform | `src/phase-04/session-status.ts` | role-match |
| `src/continuity/continuation-service.ts` | service | request-response / event-driven | `src/phase-04/metered-generation-service.ts` | role-match |
| `src/continuity/checkpoint-envelope.ts` | service | file-I/O / transform | `src/funding/protected-rail-material.ts` | exact discipline |
| `src/continuity/object-store.ts` | service / port | file-I/O | `src/funding/protected-rail-material.ts` | partial |
| `src/continuity/deadline-reconciler.ts` | service | batch / event-driven | `src/model/reconciliation.ts` | role-match |
| `src/persistence/funding-store.ts` | model / config | CRUD | `src/persistence/funding-store.ts` | modify existing |
| `src/persistence/postgres-sql-funding-store.ts` | service | CRUD / request-response | `src/persistence/postgres-sql-funding-store.ts` | modify existing |
| `src/persistence/postgres-funding-store.ts` | service | CRUD | `src/persistence/postgres-funding-store.ts` | modify existing |
| `src/persistence/session-store.ts` | service | CRUD | `src/persistence/session-store.ts` | modify existing |
| `src/persistence/sqlite-session-store.ts` | service | CRUD | `src/persistence/sqlite-session-store.ts` | modify existing |
| `src/phase-04/metered-generation-service.ts` | service | request-response | same file | modify existing |
| `src/phase-04/session-status.ts` | service / model | request-response | same file | modify existing |
| `src/phase-02/contracts.ts` | model / port | request-response / file-I/O | same file | modify existing |
| `src/worker-port/fake-worker.ts` | service / test double | file-I/O | same file | modify existing |
| `src/worker-adapters/modal-worker.ts` | service / port adapter | file-I/O | same file | modify existing, unselected provider |
| `src/contextvm/adapter.ts` | route / controller | request-response | same file | modify existing |
| `src/phase-03/funded-core.ts` | provider / config | request-response | same file | modify existing |
| `src/verification/phase-05-design-evidence.ts` | utility | transform / file-I/O | `src/verification/phase-04-design-evidence.ts` | exact |
| `scripts/verify-phase-05-design-slice.ts` | utility / config | batch / file-I/O | `scripts/verify-phase-04-design-slice.ts` | exact |
| `package.json` | config | batch | `package.json` | modify existing |
| `tests/phase-05/*.test.ts` | test | request-response / event-driven / file-I/O | `tests/phase-04/{revision,session-status}.test.ts` | role-match |
| `tests/persistence/continuation-store.test.ts` | test | CRUD / race | `tests/persistence/postgres-sql-funding-store.test.ts` | exact seam |
| `tests/persistence/phase-05-sql-schema-parity.test.ts` | test | CRUD | `tests/persistence/phase-04-sql-schema-parity.test.ts` | exact |
| `tests/evals/phase-05-reference-set.test.ts` | test | batch / transform | `tests/evals/phase-04-reference-set.test.ts` | exact |
| `tests/fixtures/phase-05-reference-set.json` | config / fixture | transform | `tests/fixtures/phase-04-reference-set.json` | exact |

## Pattern Assignments

### `src/continuity/contracts.ts` and `src/phase-04/session-status.ts`

**Analog:** `src/phase-04/session-status.ts`.

Use strict Zod allowlists for all external commands and public projections. Keep checkpoint/archive/provider data out of the status schema; attach a narrow continuation subobject to the existing owner-scoped projection.

**Schema and owner boundary** (`src/phase-04/session-status.ts:17-24, 71-76, 129-171`):

```ts
export const SessionStatusQuerySchema = z.object({
  principal: PrincipalSchema,
  sessionId: z.string().min(1),
  billing: z.object({ limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).optional() }).strict().optional(),
}).strict();

const session = await input.store.sessionStatus(accountId, query.sessionId);
if (!session) return freeze(SessionStatusSchema.parse({ status: "not_found_or_denied" }));
```

Apply the same strictness to `ResumeSessionCommandSchema`, checkpoint manifests, inventory entries, object identities, and safe `needs_top_up` fields. Do not return prompt, source, reasoning, bearer, credential, raw provider, archive bytes, encryption metadata, or lease token.

### `src/continuity/continuation-service.ts` and metered coordinator changes

**Analogs:** `src/phase-04/metered-generation-service.ts:48-60`; `src/funding/funded-admission.ts:108-123`; `src/persistence/session-store.ts:138-143, 226-257`.

The service is the coordinator-owned authority. It parses unknown input, computes the account/fingerprint, returns exact replay first, and persists intent before any budget/provider/worker effect. Preserve Phase 4's per-session serialization and compose the continuation store with the *same* Postgres serializable authority—do not coordinate independent stores or create a queue.

```ts
const recorded = await this.options.store.findRecordedResult(accountId, command.idempotencyKey);
if (recorded) { /* compare fingerprint; exact replay or conflict */ }

const result = await this.options.store.transact(accountId, async (transaction) => {
  const existing = await transaction.findActionBudget(command.idempotencyKey);
  if (existing && existing.fingerprint !== actionFingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
  return existing ?? transaction.reserveActionBudget(/* ... */);
});
```

For unaffordable work, replace the reservation with one atomic pending-intent/`needs_top_up` result. Store the first absolute grace deadline only; verified credit is merely a wake signal. Before grace continuation, recheck owner, pending fingerprint, version, lease, cap, available funds, and fresh authorization in the transaction. After grace, only a signed resume command may claim and allocate.

### `src/persistence/{funding-store,postgres-sql-funding-store,postgres-funding-store,session-store,sqlite-session-store}.ts`

**Analogs:** `src/persistence/postgres-sql-funding-store.ts:103-145, 175-186, 216-240`; `src/persistence/session-store.ts:41-60, 153-224`; `src/persistence/sqlite-session-store.ts:27-67`.

Extend the existing contracts and the single serializable implementation with continuation rows, replay fingerprints/results, pause generation/deadline, immutable checkpoint identity, resume claim, tombstone/deletion intent, and lease/capacity release. Keep deterministic memory/SQLite stores behaviorally aligned for tests, but the Postgres SQL transaction is the monetary/durable authority.

**Lease/effect fence** (`src/persistence/session-store.ts:153-201`):

```ts
const current = this.#state.leases.get(key);
if (current && current.expiresAtMs > nowMs) {
  return freeze({ authorized: false, result: /* busy or stale */ });
}
const lease = freeze({ token: crypto.randomUUID(), expiresAtMs });
this.#state.leases.set(key, freeze({ idempotencyKey: action.idempotencyKey, ...lease }));

// A matching claimed row is evidence a recipient might already have run.
if (existing.status === "claimed") return freeze({ status: "uncertain", operationId: existing.operationId });
```

Required ordering: validate proposal → encrypt → immutable object create → serializable commit of object generation/checksum plus lease revocation/claim → idempotent external terminate or restore. An upload that loses the SQL race is an unreferenced encrypted orphan, never resumable. A post-expiry tombstone is terminal and must win over later credit.

### `src/continuity/{checkpoint-envelope,object-store}.ts` and worker-port changes

**Analogs:** `src/funding/protected-rail-material.ts:67-103`; `src/worker-port/fake-worker.ts:101-119, 198-206`; `src/phase-02/contracts.ts` `CheckpointProposalSchema`.

Use a coordinator-owned port and deterministic adapter. Keep `WorkerPort` proposal-only: validate all request/action/version/policy/grant/workspace/inventory/evidence/archive digest bindings before the continuation service creates the envelope. Add restore/terminate only under a newly asserted lease; no worker chooses compatibility or checkpoint trust.

**AES-GCM discipline** (`src/funding/protected-rail-material.ts:81-100`):

```ts
const payloadDigest = await digest(plaintext);
const nonce = this.#randomValues(new Uint8Array(12));
const key = await crypto.subtle.importKey("raw", this.#key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
  { name: "AES-GCM", iv: nonce, additionalData: associatedData(metadata, payloadDigest) }, key, plaintext));
```

Checkpoint AAD/manifest must bind checkpoint/account/session/pause generation/pending action/version/archive SHA-256/policy/toolchain/object identity. Reject forbidden archive entries before encryption; make all authentication failures generic restore denial. `modal-worker.ts` stays a port adapter with no selected-provider claim—Phase 7 owns operational certification.

### `src/continuity/deadline-reconciler.ts`

**Analog:** `src/model/reconciliation.ts` and transaction/retry style in `src/persistence/postgres-sql-funding-store.ts:103-145`.

Inject the clock and scan only durable candidates. Reconcile the immutable grace and retention timestamps idempotently: deadline work creates/commits checkpoint and revokes lease; retention work tombstones first, schedules exact-generation deletion, and records an auditable outcome. No scheduler retry may allocate a worker, dispatch a historical provider operation, or extend grace.

### `src/contextvm/adapter.ts` and `src/phase-03/funded-core.ts`

**Analog:** `src/contextvm/adapter.ts:10-30, 119-160, 199-225`; wiring style `src/phase-03/funded-core.ts:29-59`.

Add exactly one `resume_session` request-name branch plus an optional transport-neutral `resumeSession` facade. Parse strict command arguments, derive principal solely from `verifiedClientPubkey`, invoke the coordinator, parse its safe result, notify the owner, and retain the generic invalid-request response.

```ts
const envelope = EnvelopeSchema.parse(input);
if (envelope.rawEvent.id !== envelope.requestEventId) throw new Error("CONTEXTVM_CORRELATION_MISMATCH");
const principal = PrincipalSchema.parse({ pubkey: envelope.verifiedClientPubkey });
```

Never route a Lightning/Cashu settlement directly to a worker or resume command. Extend core composition with continuation dependencies as optional test-only/deterministic ports until Phase 7; do not expose a public HTTP/x402/L402 route.

### Tests, evaluation, and verification files

**Analogs:** `tests/phase-04/session-status.test.ts`; `tests/persistence/postgres-sql-funding-store.test.ts`; `src/verification/phase-04-design-evidence.ts:60-110`; `scripts/verify-phase-04-design-slice.ts:10-45`.

Follow the Phase 4 fixture/reference gate shape: individual behavior tests, an adversarial deterministic reference set, typed evidence evaluator, then a script that runs suites, hashes named code/test inputs, emits a canonical content-addressed record using `wx`, and writes a pointer. Add `eval:phase05` and `verify:phase05-design` scripts matching the existing naming convention.

Required named tests are `pause-for-funding`, `continuation-status`, `grace-wake`, `deadline-checkpoint`, `checkpoint-envelope`, `resume-session`, and `retention-expiry`, plus continuation persistence parity. Cover credit at deadline boundaries, duplicate/reordered credit, stale lease, object/SQL crash points, tamper, concurrent resume, and irreversible expiry.

## Shared Patterns

### One serializable authority

**Sources:** `src/persistence/postgres-sql-funding-store.ts:103-145, 216-240`; `src/persistence/session-store.ts:226-257`.

Continuation state, fresh budget, lease/claim, replay result, checkpoint identity, and ledger-adjacent effects must be decided in one serializable transaction. Worker/object operations occur only before/after that authority boundary and are idempotently reconciled.

### Idempotency, version, and lease fencing

**Sources:** `src/persistence/session-store.ts:138-143, 153-171, 173-201`.

Fingerprint `(owner, command)`; exact same key/input replays its stored result, altered input returns conflict. Validate owner and expected version before allocation/effect; assert token and expiry at every effect boundary. Treat ambiguous prior dispatch as uncertain/blocked, never redispatch it.

### Strict owner-safe projection

**Sources:** `src/phase-04/session-status.ts:17-24, 129-171`; `src/contextvm/adapter.ts:199-207`.

All public schemas are explicit allowlists. Existing owner lookup returns `not_found_or_denied` rather than disclosing existence; preserve this for checkpoints/resume. Do not spread raw durable records into ContextVM results.

### Authenticated immutable checkpoint

**Sources:** `src/funding/protected-rail-material.ts:81-100`; `src/worker-port/fake-worker.ts:198-206`.

Fresh 12-byte AES-GCM nonce plus canonical authenticated metadata, proposal validation/digest binding, create-if-absent object storage, persisted generation/checksum, and generic decrypt denial. The archive is data; SQL continuation claim is authority.

## No Analog Found

| File / concern | Role | Data Flow | Planner direction |
|---|---|---|---|
| Production GCS/KMS/Modal checkpoint adapter | provider adapter | file-I/O | Intentionally unselected and deferred to Phase 7; only ports/deterministic doubles belong here. |

## Metadata

**Analog search scope:** `src/{persistence,funding,phase-02,phase-03,phase-04,worker-port,worker-adapters,contextvm,verification}`, `tests`, `scripts`  
**Files scanned:** 20+ source/test analogs via code graph plus targeted source reads  
**Pattern extraction date:** 2026-08-05
