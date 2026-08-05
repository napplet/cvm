# Phase 6: Sealed Preview & User-Owned Publication - Pattern Map

**Mapped:** 2026-08-05  
**Files analyzed:** 27 planned new/modified surfaces  
**Analogs found:** 27 / 27

## File Classification

| New/Modified File | Role | Data flow | Closest analog | Match |
|---|---|---|---|---|
| `src/publication/contracts.ts` | model | transform | `src/continuity/contracts.ts` | role-match |
| `src/publication/ports.ts` | port/interface | request-response | `src/phase-02/contracts.ts` | role-match |
| `src/publication/manifest-event.ts` | service | transform | `src/promotion/schema.ts` | partial (do not reuse its serialization) |
| `tests/phase-06/nostr-tools-direct-dependency.test.ts` | dependency contract test | transform | `tests/promotion/candidate.test.ts` | exact identity/pin gate |
| `src/publication/public-status.ts` | utility | transform | `src/phase-04/session-status.ts` | role-match |
| `src/publication/preview-service.ts` | service | request-response | `src/phase-02/trusted-core.ts` | role-match |
| `src/publication/publication-service.ts` | service | event-driven | `src/continuity/continuation-service.ts` | exact saga/reconciliation match |
| `src/persistence/publication-store.ts` | store/model | CRUD | `src/persistence/session-store.ts` | exact memory-store match |
| `src/persistence/sqlite-publication-store.ts` | store | CRUD | `src/persistence/sqlite-session-store.ts` | exact SQLite parity match |
| `src/persistence/funding-store.ts` | store contract | CRUD | `src/persistence/funding-store.ts` continuation extensions | exact extension point |
| `src/persistence/postgres-sql-funding-store.ts` | store | CRUD | `src/persistence/postgres-sql-funding-store.ts` | exact extension point |
| `src/contextvm/adapter.ts` | adapter/controller | request-response | `src/contextvm/adapter.ts` | exact extension point |
| `src/contextvm/announcement.ts` | config/projection | transform | `src/contextvm/announcement.ts` | exact extension point |
| `migrations/phase-06/001_publication.sql` | migration | CRUD | `migrations/phase-05/001_continuation.sql` | exact |
| `tests/phase-06/preview-descriptor.test.ts` | test | request-response | `tests/phase-05/resume-session.test.ts` | role-match |
| `tests/phase-06/runtime-status.test.ts` | test | event-driven | `tests/contextvm/adapter.test.ts` | role-match |
| `tests/phase-06/capability-review.test.ts` | test | transform | `tests/capabilities/scoped-tool-gateway.test.ts` | role-match |
| `tests/phase-06/publication-intent.test.ts` | test | event-driven | `tests/phase-05/grace-wake.test.ts` | exact fencing/replay match |
| `tests/phase-06/manifest-signature.test.ts` | test | transform | `tests/policy/artifact-contract.test.ts` | partial boundary-validation match |
| `tests/phase-06/sealed-deployment.test.ts` | test | file-I/O | `tests/phase-05/checkpoint-envelope.test.ts` | role-match |
| `tests/phase-06/publication-reconciliation.test.ts` | test | event-driven | `tests/phase-05/grace-wake.test.ts` | exact reconciliation match |
| `src/publication/napplet-cli-source-contract.ts` | source-contract validator | transform | `src/promotion/candidate.ts` | exact provenance/fail-closed match |
| `scripts/probe-phase-06-cli-source-contract.ts`, `tests/fixtures/phase-06-cli-source-contract.json`, `tests/phase-06/cli-source-contract.test.ts` | script/fixture/test | batch | `scripts/test-promotion.ts`, `tests/promotion/candidate.test.ts` | exact source-identity gate |
| `tests/persistence/phase-06-sql-schema-parity.test.ts` | test | CRUD | `tests/persistence/phase-05-sql-schema-parity.test.ts` | exact |
| `tests/evals/phase-06-reference-set.test.ts`, `src/verification/phase-06-design-evidence.ts`, `scripts/verify-phase-06-design-slice.ts` | test/service/script | batch | Phase 05 equivalents | exact |

## Pattern Assignments

### `src/publication/contracts.ts`, `ports.ts`, and `public-status.ts`

**Copy contract style from:** `src/continuity/contracts.ts`; **owner-safe projection style from:** `src/phase-04/session-status.ts`.

Use strict Zod schemas at every port edge, inferred exported types, and discriminated public results. Keep server-only operation IDs, object locations, provider payloads, prompts, source, credentials, and signing material out of public result schemas. The ContextVM test asserts this exact redaction posture at [tests/contextvm/adapter.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/contextvm/adapter.test.ts:108):

```ts
expect(JSON.stringify(transport.responses.at(-1)?.response))
  .not.toMatch(/account:internal|provider|prompt|repair/i);
```

Model the preview descriptor as an allowlisted immutable projection (account/session/artifact version, aggregate hash, object generation/checksum, manifest/capability/evidence/toolchain identities, opaque expiring grant). Model public publication states as `not_found_or_denied`, `preview_ready`, `incompatible`, `intent_ready`, `invalid_manifest`, `publication_reconciliation_pending`, `partial`, and `completed`; do not expose a generic raw-error field.

### `src/publication/preview-service.ts`

**Analog:** [src/phase-02/trusted-core.ts](/Users/sandwich/Develop/napplet-cvm/src/phase-02/trusted-core.ts:109) (`artifactMatchesRequest`, `verifiedArtifactIsValid`, lines 109-122).

Copy its fail-closed verified-artifact gate: lookup is server-owned and caller facts must match durable facts exactly before constructing any descriptor. The parallel Phase 5 checkpoint dependency is explicit about this ownership at [src/continuity/continuation-service.ts](/Users/sandwich/Develop/napplet-cvm/src/continuity/continuation-service.ts:16):

```ts
checkpoint: Readonly<{
  loadExact(checkpointId: string): Promise<ResumeCheckpointMaterial>;
  restore(material: ResumeCheckpointMaterial): Promise<Uint8Array>;
}>;
```

Apply the same shape: `loadVerifiedArtifactExact(owner, sessionId, artifactVersion)` takes no client path, bytes, aggregate, generation, or checksum. Derive required/optional capability review only from that immutable manifest. Issue an opaque grant bound to the descriptor digest and expiry; host runtime status is parsed as untrusted input and may only update preview status, never intent/signature/effect state.

### `src/publication/manifest-event.ts`

**Closest analog:** [src/promotion/schema.ts](/Users/sandwich/Develop/napplet-cvm/src/promotion/schema.ts) for canonical project fingerprints; **critical distinction:** do not use `canonicalJson` for NIP-01 event ID serialization.

Copy the project pattern of strict input parsing, SHA-256 digesting, and comparison-before-use, but isolate maintained NIP-01 serialization/signature verification in this adapter. Build one canonical unsigned template from server facts, persist its digest, then verify the returned event's ID/signature and exact owner, kind, tags/content, d-tag, aggregate hash, capability digest, intent identity, and expiry. Collapse every failure to the same `invalid_manifest` public result, avoiding an ownership/signature oracle.

Declare `nostr-tools@2.24.1` as an exact direct root dependency and contract-test the root manifest/lock resolution before implementing the verifier. Import only `serializeEvent`, `getEventHash`, and `verifyEvent` from `nostr-tools/pure`; do not expose signing, key-generation, pool, relay, bunker, or secret-handling APIs. The developer explicitly authorized this reversible pin to execute autonomously without a human package-trust checkpoint during Phase 6 design.

### Promoted CLI exact-source contract probe

**Analogs:** [src/promotion/candidate.ts](/Users/sandwich/Develop/napplet-cvm/src/promotion/candidate.ts) for exact commit/SHA validation and [tests/promotion/candidate.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/promotion/candidate.test.ts) for mutation-driven fail-closed cases.

Bind the probe to commit `1a38b9150f3a3da148091c11bce4d0365f7298e5`, Linux asset SHA-256 `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e`, and exact hashes for the critical upstream source files. Treat only structured lower-level payload upload, pre-signed relay publication, progress/result contracts, and the network success predicate as eligible. The command dispatcher, signer resolution, workspace discovery/file collection, deploy planning, manifest creation/signing, dependency/build/rebuild, root/snapshot/multi-target, JSON report, and human stdout paths are closed. Return `publication_unavailable` on any identity, source, signature, or route mismatch, and require that result before the Plan 06 announcement can expose publication.

### `src/publication/publication-service.ts`

**Analog:** [src/continuity/continuation-service.ts](/Users/sandwich/Develop/napplet-cvm/src/continuity/continuation-service.ts:89) (`wakePausedAction` through reconciliation).

Copy the ordering: re-read durable state, verify every fence, create a durable claim in the same transaction, perform external work outside the transaction, and close the original claim. Its core pattern is:

```ts
const claim = await transaction.claimWakeDispatch(/* exact durable identity */);
if (!claim.claimed) return frozen({ status: "replayed", code: "WAKE_ALREADY_CLAIMED" });
// external effect only after durable claim
await this.recordWakeDispatchOutcome({ ..., outcome: "completed" });
```

For publication, verify the signed owner event first; transactionally create/replay the parent publication intent and child `deploy`, `owner_manifest`, and `attestation` effect intents; then call ports in the persisted order. On a throw/lost response mark only that child `unknown`; reconciliation calls `observe(originalOperationId)` and never redeploys, re-signs, or creates a fresh event. Copy lookup-only reconciliation from [src/continuity/continuation-service.ts](/Users/sandwich/Develop/napplet-cvm/src/continuity/continuation-service.ts:153): it reads the stored claim, checks its immutable tuple, observes the original operation, then records closure.

### `src/persistence/publication-store.ts`

**Analog:** [src/persistence/session-store.ts](/Users/sandwich/Develop/napplet-cvm/src/persistence/session-store.ts:173) (`TransactionalMemorySessionStore.claimEffectIntent`).

Use its exact conflict fence:

```ts
if (existing.attemptToken !== lease.token) return freeze({ status: "blocked" });
if (existing.actionId !== action.actionId || existing.requestFingerprint !== requestFingerprint) return freeze({ status: "blocked" });
if (existing.status === "claimed") {
  this.#state.effectIntents.set(key, freeze({ ...existing, status: "uncertain" as const }));
  return freeze({ status: "uncertain", operationId: existing.operationId });
}
```

Adapt the identity tuple to `(account, session, artifact version, publication intent fingerprint, child effect kind)`. Exact same request returns the prior linked result; different identity/key is conflict/denied; an in-flight claim becomes reconciliation pending. Keep immutable parent intent, child operation identities, and observations in frozen/cloned in-memory state so tests exercise the same invariants as SQL.

### `src/persistence/sqlite-publication-store.ts` and PostgreSQL extension

**SQLite analog:** [src/persistence/sqlite-session-store.ts](/Users/sandwich/Develop/napplet-cvm/src/persistence/sqlite-session-store.ts:144).

Copy a single SQLite transaction, parameterized queries, and busy-to-safe-denial conversion:

```ts
return this.#database.transaction(() => {
  // read exact lease/intent; fence conflicting prior effect; INSERT claimed row
})();
// SQLITE_BUSY / database is locked => { status: "blocked" }
```

**PostgreSQL analog:** [src/persistence/postgres-funding-store.ts](/Users/sandwich/Develop/napplet-cvm/src/persistence/postgres-funding-store.ts:36) (`transact`) and [src/persistence/postgres-sql-funding-store.ts](/Users/sandwich/Develop/napplet-cvm/src/persistence/postgres-sql-funding-store.ts:133) (transaction methods).

Extend the existing transaction interfaces/implementations rather than introducing a parallel connection abstraction. Match memory, SQLite, and Postgres observable statuses and conflict rules. Add [tests/persistence/phase-06-sql-schema-parity.test.ts] using the Phase 5 parity-test layout to assert schema strings, constraints, and each implementation's replay/conflict/unknown behavior.

### `migrations/phase-06/001_publication.sql`

**Analog:** [migrations/phase-05/001_continuation.sql](/Users/sandwich/Develop/napplet-cvm/migrations/phase-05/001_continuation.sql:1).

Follow its transaction wrapper, foreign keys, identity uniqueness, state `CHECK`s, and immutability trigger. In particular, use the Phase 5 paired intent/effect model:

```sql
operation_id text NOT NULL UNIQUE,
claim_token text NOT NULL UNIQUE,
state text NOT NULL CHECK (state IN ('pending','claimed','completed','unknown',
  'reconciliation_terminal','late_evidence_requires_operator'))
```

Publication tables need parent intent identity/fingerprint/template/expiry and separate child-effect target/operation/observation rows. Add unique owner/idempotency and parent/effect-kind constraints; preserve sealed aggregate/object generation/checksum, manifest template digest, and signed event identity as immutable. Do not create a durable work queue.

### `src/contextvm/adapter.ts` and `announcement.ts`

**Adapter analog:** [src/contextvm/adapter.ts](/Users/sandwich/Develop/napplet-cvm/src/contextvm/adapter.ts:102). Extend `dispatch` with strict schemas for preview, capability review/intent/status, signed-manifest submission, and reconciliation. Preserve its boundary sequence:

```ts
const envelope = EnvelopeSchema.parse(input);
if (envelope.rawEvent.id !== envelope.requestEventId) throw new Error("CONTEXTVM_CORRELATION_MISMATCH");
const principal = PrincipalSchema.parse({ pubkey: envelope.verifiedClientPubkey });
const response = await this.dispatch(principal.pubkey, envelope.requestEventId, envelope.rawEvent, request);
```

Only derive the principal from the SDK-verified pubkey; never accept caller owner/key/session identity as authority. Keep generic `-32602` wire errors and explicit response allowlists. Retain notification correlation for safe status projections.

**Announcement analog:** [src/contextvm/announcement.ts](/Users/sandwich/Develop/napplet-cvm/src/contextvm/announcement.ts:1). It already declares `preview` and `publication` as planned, and [tests/contextvm/adapter.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/contextvm/adapter.test.ts:71) locks their truthful planned/available projection. Change them to available only with every corresponding adapter command wired; preserve schema uniqueness, lexical sorting, freeze, and no sensitive metadata.

### Deterministic ports/fakes and Phase 6 tests

**Fake pattern:** [src/worker-port/fake-worker.ts](/Users/sandwich/Develop/napplet-cvm/src/worker-port/fake-worker.ts:126). New deterministic host, signer, deployment, relay, and attestation fakes should accept a closed script, record exact operation IDs, inject `unknown` after effect, and have no credentials/network/filesystem attachment. Copy the stated isolation contract:

```ts
// Its only effect path is ScopedToolGateway; no environment, credentials,
// network, host filesystem, or durable store is attached to this object.
```

Tests under `tests/phase-06/` should use explicit owner/artifact/fingerprint fixtures and cover: exact descriptor denial; runtime message zero authority; required-block/optional-degrade; intent invalidation/replay/conflict; generic invalid signature; exact sealed-byte port inputs; partial/unknown/reconciliation lookup-only behavior. Extend [tests/contextvm/adapter.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/contextvm/adapter.test.ts:12)'s `FakeContextVmTransport` for adapter integration and assert wire redaction.

### Phase 6 evidence, reference set, and design script

**Analogs:** [src/verification/phase-05-design-evidence.ts](/Users/sandwich/Develop/napplet-cvm/src/verification/phase-05-design-evidence.ts:46), [tests/evals/phase-05-reference-set.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/evals/phase-05-reference-set.test.ts:1), and [scripts/verify-phase-05-design-slice.ts](/Users/sandwich/Develop/napplet-cvm/scripts/verify-phase-05-design-slice.ts:1).

Copy the facts-only comparison gate. Evidence must re-derive public outcomes from named Phase 6 authority probes, compare expected values only after observation, hash inputs, write immutable digest-named evidence (`flag: "wx"`), and validate it again. Keep host/signer/CLI/relay providers explicit `not_observed` / `unselected` with Phase 7 closure—never label deterministic fakes production-certified.

## Shared Patterns

### Owner authority and redaction

**Sources:** [src/contextvm/adapter.ts](/Users/sandwich/Develop/napplet-cvm/src/contextvm/adapter.ts:102), [tests/contextvm/adapter.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/contextvm/adapter.test.ts:121).

SDK-verified pubkey is the sole owner input. All external/public results are explicit allowlists; test forbidden account/provider/archive/credential/lease/internal strings.

### Immutable identity and exact replay

**Sources:** [src/persistence/session-store.ts](/Users/sandwich/Develop/napplet-cvm/src/persistence/session-store.ts:173), [migrations/phase-05/001_continuation.sql](/Users/sandwich/Develop/napplet-cvm/migrations/phase-05/001_continuation.sql:121).

Persist immutable identity before effects, use uniqueness plus request fingerprint fence, transition uncertain claims to reconciliation, and forbid updates which replace sealed identity.

### Persist-before-effect, observe-original-only

**Source:** [src/continuity/continuation-service.ts](/Users/sandwich/Develop/napplet-cvm/src/continuity/continuation-service.ts:153).

External calls occur only after their durable claim. Timeout/crash uses the exact stored operation ID in an observe-only port; a later action cannot manufacture new deployment, manifest, or attestation work.

### Deterministic design evidence

**Source:** [src/verification/phase-05-design-evidence.ts](/Users/sandwich/Develop/napplet-cvm/src/verification/phase-05-design-evidence.ts:71).

Digest canonical evidence, independently revalidate it, write immutable content-addressed records, and separate deterministic proof from unselected provider certification.

## No Analog Found

| File/surface | Role | Data flow | Gap handling |
|---|---|---|---|
| Actual NIP-5D host iframe/signer implementation | host runtime | request-response | No host runtime exists here; define/test only narrow deterministic `HostPreviewPort` and signer-return contracts. |
| Live NIP-01 signer and promoted CLI binary/provider execution | adapter | event-driven/file-I/O | Phase 6 proves the exact direct verifier import and exact promoted-source contract, then isolates ports/fakes; Phase 7 retains live binary/signer/relay/Blossom certification. |

## Metadata

**Analog search scope:** `src/{contextvm,continuity,persistence,phase-02,phase-04,verification,worker-port}`, `migrations/phase-05`, `tests/{contextvm,persistence,phase-05,evals}`  
**Files scanned:** 43 TypeScript source files, 43 test files, 3 prior migration files  
**Pattern extraction date:** 2026-08-05
