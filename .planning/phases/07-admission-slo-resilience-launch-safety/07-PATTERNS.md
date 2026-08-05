# Phase 07: Admission SLO, Resilience & Launch Safety - Pattern Map

**Mapped:** 2026-08-05  
**Files analyzed:** 24 planned new/modified files  
**Analogs found:** 22 / 24

## File Classification

| New/Modified File | Role | Data flow | Closest analog | Match |
|---|---|---|---|---|
| `src/telemetry/contracts.ts` | model | event-driven | `src/publication/host-surface.ts` | role-match |
| `src/telemetry/redaction.ts` | utility | transform | `src/promotion/schema.ts` | role-match |
| `src/telemetry/otel.ts` | service | event-driven | `src/evidence/bundle.ts` | partial |
| `src/certification/contracts.ts` | model | transform | `src/evidence/bundle.ts` | role-match |
| `src/certification/evidence.ts` | service | file-I/O | `src/evidence/bundle.ts` | exact |
| `src/admission/benchmark.ts` | service | batch | `src/funding/funded-admission.ts` | data-flow-match |
| `src/resilience/fault-harness.ts` | service | event-driven | `src/model/reconciliation.ts` | data-flow-match |
| `src/worker-adapters/fly-worker.ts` | adapter/service | request-response | `src/worker-adapters/modal-worker.ts` | exact |
| `src/funding/funded-admission.ts` | service | request-response | itself | extension |
| `src/contextvm/adapter.ts` | adapter | request-response | itself | extension |
| `src/worker-adapters/modal-worker.ts` | adapter | request-response | itself | extension |
| `src/continuity/object-store.ts` | adapter | file-I/O | itself | extension |
| `src/continuity/continuation-service.ts` / stores | service/model | CRUD | `src/persistence/session-store.ts` | role-match |
| `src/model/reconciliation.ts` | service | request-response | itself | extension |
| `src/publication/publication-service.ts` | service | event-driven | itself | extension |
| `src/publication/host-surface.ts` / contracts | component adapter/model | transform | itself | extension |
| `src/promotion/{schema,candidate,run-promotion}.ts` | config/service | batch | themselves | extension |
| `scripts/{eval,verify-phase-07-evidence,certify-phase-07}.ts` | utility/CLI | batch | `scripts/verify-phase-06-design-slice.ts` | role-match |
| `tests/phase-07/*.test.ts` | test | request-response/event-driven | `tests/funding/funded-admission.test.ts`, `tests/phase-06/*.test.ts` | role-match |
| `tests/evals/phase-07-reference-set.test.ts` | test | batch | `tests/evals/phase-06-reference-set.test.ts` | exact |
| `tests/fixtures/phase-07-reference-set.json` | config/fixture | transform | `tests/fixtures/phase-06-reference-set.json` | exact |
| `evidence/design/phase-07.json` | config/evidence | file-I/O | `src/evidence/bundle.ts` | partial |

## Pattern Assignments

### Admission timing, refusal, and ContextVM presentation

**Apply to:** `src/funding/funded-admission.ts`, `src/admission/benchmark.ts`, `src/contextvm/adapter.ts`, associated phase-07 tests.

**Primary analog:** `src/funding/funded-admission.ts` — `FundedAdmissionService.admit` (lines 65-125).

```ts
const recorded = await this.options.store.findRecordedResult(accountId, command.idempotencyKey);
if (recorded) {
  if (recorded.result.status !== "accepted") throw new Error("FUNDED_ADMISSION_REPLAY_INVALID");
  // fingerprint replay and return the stored outcome; do not reserve again
}
const dispatch = await this.options.store.transact(accountId,
  (transaction) => transaction.claimCapacityDispatch(intentReference));
if (dispatch.claimed) observation = await this.bounded(this.options.capacity.reserveNow({ intentReference }));
```

Preserve the durable capacity intent before provider interaction, `bounded()` deadline, and compensation path. Extend the *existing* result schema so `refused` is the stable owner-safe `capacity_unavailable` projection (bounded retry hint + correlation only); do not add a queue or re-dispatch on duplicate refusal. Timestamp at adapter receipt before this call and finish only after the exact-session readiness probe.

**Transport analog:** `src/contextvm/adapter.ts` (lines 16-82, 145-180, 226-238).

```ts
const envelope = EnvelopeSchema.parse(input);
if (envelope.rawEvent.id !== envelope.requestEventId) throw new Error("CONTEXTVM_CORRELATION_MISMATCH");
const principal = PrincipalSchema.parse({ pubkey: envelope.verifiedClientPubkey });
const result = await this.options.admissions.admit({
  principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey,
  policyVersion: this.policyVersion, protocolVersion: this.protocolVersion, payload: { requestedCap: args.requestedCap, unit: "sat" },
});
```

Add telemetry only around trusted, normalized fields; parse new finite response fields with Zod before response/notification. Its `handle()` catch intentionally returns generic owner-safe input errors—do not expose capacity/provider errors.

### Provider-neutral worker benchmark and candidate adapter

**Apply to:** `src/worker-adapters/fly-worker.ts`, `src/worker-adapters/modal-worker.ts`, `src/admission/benchmark.ts`, `src/resilience/fault-harness.ts`.

**Analog:** `src/worker-adapters/modal-worker.ts` — `ModalWorkerAdapter.run` (lines 317-366) and `observeLiveModalIsolation` (lines 207-256).

```ts
const request = WorkerRunRequestSchema.safeParse(input);
if (!request.success) return WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
if (signal.aborted) return WorkerRunResultSchema.parse({ status: "interrupted", code: "WORKER_INTERRUPTED" });
// create provider resource, write canonical request, run fixed command, parse only WorkerPort result
} catch {
  result = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
}
```

The new Fly adapter must implement the same project `WorkerPort`/continuation port and return project finite results—not SDK objects, native IDs, or errors. Follow the Modal live probe: create fresh resources, execute the fixed exact-session probe, validate strict report schema, prove mediated tools/checkpoint inventory, and always terminate/clean temporary data. Benchmark code orchestrates both through a provider-neutral interface; it records provider/region/image/pool cohort in immutable evidence, never metric labels.

### Leases, checkpoint restoration, and fault injection

**Apply to:** continuation/object-store adapters and `src/resilience/fault-harness.ts`.

**Lease analog:** `src/persistence/session-store.ts` — `claimWorkerLease` (lines 153-164).

```ts
const preflight = await this.preflight(action);
if (!preflight.authorized) return preflight;
const current = this.#state.leases.get(leaseKey(action.sessionId, action.expectedVersion));
if (current && current.expiresAtMs > nowMs) {
  return freeze({ authorized: false, result: current.idempotencyKey === action.idempotencyKey
    ? denial("STORE_BUSY") : denial("STALE_SESSION_VERSION", action.expectedVersion) });
}
```

**Object analog:** `src/continuity/object-store.ts` — `readExact` and `scheduleExactDeletion` (lines 37-59).

```ts
const parsed = ImmutableObjectReferenceSchema.safeParse(reference);
if (!parsed.success) return undefined;
const entry = this.#entries.get(parsed.data.key);
if (!entry || entry.generation !== parsed.data.generation || entry.checksum !== parsed.data.checksum) return undefined;
return new Uint8Array(entry.bytes);
```

Fault schedules should inject only at existing port boundaries and assert original command/lease/version/checksum identity. Restore requires exact generation + checksum plus owner/version/lease fences; test corrupt, expired, wrong-owner, wrong-version and instance-loss cases. Never turn a failed observation into a new worker/effect.

### Reconciliation is lookup-only

**Apply to:** model/payment reconciliation extensions, resilience tests, publication fault cases.

**Model analog:** `src/model/reconciliation.ts` — `ModelReconciliationService.reconcileOnce` (lines 47-98).

```ts
if (action.status !== "usage_unknown") throw new Error("RECONCILIATION_NOT_REQUIRED");
const claim = await this.options.store.transact(action.accountId,
  (transaction) => transaction.claimReconciliation(action.operationId));
const observation = ModelLookupObservationSchema.parse(
  await this.options.gateway.lookup(toIntent(claim.action), signal));
if (observation.status === "pending" || observation.status === "unresolved") {
  return ReconciliationResultSchema.parse({ status: "usage_unknown", code: "RECONCILIATION_PENDING", ... });
}
```

**Unknown-state analog:** `src/persistence/session-store.ts` — `markEffectIntentUnknown` (lines 214-218), which moves only a claimed original operation to `uncertain`. Use claim/release-finally and strict correlation checks. Neither a fault harness nor a reconciler may replace the original charge, worker action, publication, relay event, or attestation.

### Publication effects and host presentation

**Apply to:** `src/publication/publication-service.ts`, `src/publication/host-surface.ts`, contracts, ContextVM-safe status tests.

**Publication analog:** `src/publication/publication-service.ts` (lines 35-104).

```ts
const claim = await this.dependencies.store.claimPublicationEffect({
  intentId: intent.intentId, effectKind: kind, operationId,
  requestFingerprintSha256: intent.aggregateSha256,
});
if (!claim.claimed) return;
try { await this.#recordObserved(kind, operationId, await invoke()); }
catch { await this.dependencies.store.recordPublicationObservation({
  operationId, effectKind: kind, state: "unknown", observationId: `observation:${operationId}:unknown`,
}); }
```

For Phase 7 keep the fixed deploy/owner-manifest/attestation operation identities. Reconciliation uses `observe` only (lines 59-70); no replacement signing or publication.

**Presentation analog:** `src/publication/host-surface.ts` (lines 1-59). It defines a closed Zod vocabulary (`HostActionSchema`) and maps strict bounded inputs into a host-owned surface. Extend this instead of exposing machine actions/raw adapter data. Add Phase-07 finite capacity and launch-certification states, exact identifier-specific accessible/copy labels, semantic status, dialog/live-announcement/motion/layout fields; reject unknown presentation versions and never accept iframe-provided display content.

### Immutable certification evidence and promotion gate

**Apply to:** `src/certification/contracts.ts`, `src/certification/evidence.ts`, promotion modules, evidence scripts/tests.

**Evidence writer analog:** `src/evidence/bundle.ts` — `writeEvidenceBundle` (lines 76-90).

```ts
validateInput(input);
const evidenceSha256 = await sha256(canonicalJson(input));
const bundle = { version: 1, ...input, evidenceSha256 };
await writeFile(`${directory}/${evidenceSha256}.json`, `${canonicalJson(bundle)}\n`, { encoding: "utf8", flag: "wx" });
// EEXIST is valid only when existing bytes exactly equal canonical content.
```

All certification observations must be strict finite schemas, content-addressed, candidate-bound, and explicit for `passed`, `failed`, `blocked`, `skipped`, and `not_observed`; include freshness/input digests and limitations. Redaction occurs before emission.

**Promotion analog:** `src/promotion/schema.ts` — `parsePromotionManifest` (lines 108-156), and `src/promotion/run-promotion.ts` — `runPromotionCandidate` (lines 104-155).

```ts
if (value.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
if (value.status !== "candidate") throw new Error("manifest.status must be candidate");
if (version === "latest" || /[~^*]/.test(version)) throw new Error("manifest package version must be an exact pin");
...
if (result.status === "blocked") return writePromotionEvidence(..., "blocked", stage.id, stages);
```

Extend the schema/gate rather than create a parallel release checker. Preserve first-failure fail-closed returns. The Phase-07 gate must bind all immutable inputs and evidence digests, reject stale/missing/non-pass required observations and non-waivable exceptions, while retaining the existing auditable bounded waiver mechanism only for explicitly eligible checks.

## Shared Patterns

### Strict boundary schemas and safe projections

**Sources:** `src/contextvm/adapter.ts`, `src/publication/host-surface.ts`, `src/promotion/schema.ts`.

Use `z.object(...).strict()` / finite enums at every inbound or persisted boundary. Parse provider/host/evidence input before it carries authority; emit only allowlisted projection fields. Unknown values are denied/blocked, never guessed.

### Idempotency, fencing, and ambiguity

**Sources:** `src/funding/funded-admission.ts`, `src/persistence/session-store.ts`, `src/model/reconciliation.ts`, `src/publication/publication-service.ts`.

Durably claim before an external effect; replay exact stored outcome; make conflicts explicit; mark ambiguity visible; observe/reconcile the original operation only. Transaction retry is confined to store work, not wrapped around provider calls.

### Content-addressed immutable evidence

**Sources:** `src/evidence/bundle.ts`, `src/promotion/run-promotion.ts`.

Canonical JSON + SHA-256 determines filename/content; `wx` prevents overwrite and byte equality validates a collision. Reuse for deterministic and protected-live evidence bundles.

### Tests and scripts

**Sources:** `tests/funding/funded-admission.test.ts`, `tests/phase-06/publication-reconciliation.test.ts`, `tests/evals/phase-06-reference-set.test.ts`, `scripts/verify-phase-06-design-slice.ts`.

Follow Bun's direct service construction with deterministic doubles, explicit effect-count assertions, and versioned JSON fixtures. Protected live runner must write `blocked` evidence and exit nonzero when credentials/topology/samples are absent—not simulate a pass.

## No Analog Found

| File | Role | Data flow | Reason |
|---|---|---|---|
| `src/telemetry/otel.ts` | service | event-driven | No OpenTelemetry exporter/instrumentation exists; use Phase 07 strict contracts and the evidence writer's fail-closed pattern. |
| `src/certification/contracts.ts` | model | batch | No live-certification observation schema exists; extend evidence/promotion conventions. |

## Metadata

**Analog search scope:** graph index, `src/{funding,contextvm,worker-adapters,continuity,model,publication,promotion,evidence,persistence}`, `tests`, `scripts`.  
**Files scanned:** 18 source/test/script analogs plus Phase-07 upstream artifacts.  
**Pattern extraction date:** 2026-08-05.  
**Off-limits paths:** pre-existing user-untracked `deno.lock`, `node_modules/`, `.planning/research/.cache/`, and `evidence/design/*.json`; do not modify, delete, or treat them as phase inputs. `.planning/STATE.md` is also already modified by another workflow.
