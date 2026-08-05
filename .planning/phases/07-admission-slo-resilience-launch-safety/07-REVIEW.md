---
phase: 07-admission-slo-resilience-launch-safety
reviewed: 2026-08-05T17:11:41Z
depth: deep
files_reviewed: 80
files_reviewed_list:
  - package.json
  - bun.lock
  - infra/otel/collector.yaml
  - scripts/certify-phase-07.ts
  - scripts/eval-phase-07.ts
  - scripts/verify-phase-07-evidence.ts
  - scripts/verify-phase-07-otel-packages.ts
  - src/admission/benchmark.ts
  - src/certification/contracts.ts
  - src/certification/evidence.ts
  - src/certification/phase-07-reference-set.ts
  - src/contextvm/adapter.ts
  - src/continuity/continuation-service.ts
  - src/continuity/object-store.ts
  - src/funding/funded-admission.ts
  - src/model/reconciliation.ts
  - src/phase-03/funded-core.ts
  - src/promotion/candidate.ts
  - src/promotion/run-promotion.ts
  - src/promotion/schema.ts
  - src/publication/contracts.ts
  - src/publication/host-surface.ts
  - src/publication/publication-service.ts
  - src/resilience/fault-harness.ts
  - src/telemetry/contracts.ts
  - src/telemetry/otel.ts
  - src/telemetry/redaction.ts
  - src/worker-adapters/fly-worker.ts
  - src/worker-adapters/modal-worker.ts
  - tests/evals/phase-07-reference-set.test.ts
  - tests/fixtures/phase-07-reference-set.json
  - tests/integration/modal-probe.test.ts
  - tests/phase-07/admission-slo.test.ts
  - tests/phase-07/fault-matrix.test.ts
  - tests/phase-07/host-presentation.test.ts
  - tests/phase-07/otel-package-legitimacy.test.ts
  - tests/phase-07/promotion-gate.test.ts
  - tests/phase-07/restore-drill.test.ts
  - tests/phase-07/telemetry-policy.test.ts
  - tests/phase-07/worker-benchmark.test.ts
  - tests/tracer.test.ts
  - evidence/certification/**
  - evidence/design/8ff150d22f8dcebfe8be9418061421a530bf78c9fd8c3929d4a54dea3c1c0d5c.json
  - evidence/design/phase-07.json
findings:
  critical: 4
  warning: 3
  info: 0
  total: 7
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-08-05T17:11:41Z
**Depth:** deep
**Files Reviewed:** 80
**Status:** issues_found

## Summary

The Phase 7 suites are green, including the full Bun suite (468 passing tests), but they do not establish the security and release guarantees claimed by this phase. Four shipping blockers remain in admission, promotion, publication recovery, and the telemetry supply-chain gate. The deterministic corpus and lifecycle telemetry coverage also overstate what actually executes.

## Critical Issues

### CR-01: Admission can accept a lease without an exact-session readiness proof

**File:** `src/funding/funded-admission.ts:190`
**Issue:** `hasExactReadyProof()` returns `true` whenever the optional lifecycle argument is absent. `FundedAdmissionService.admit()` is exposed by the funded core and can therefore accept an `available` reservation with no `ready` proof at all. A direct reproduction with a lease containing only `reference`/`expiresAt` returned `status: "accepted"`. This violates D-115 and lets any non-ContextVM caller create a funded hold before the exact worker readiness probe.

**Fix:** Make `CapacityReservation.ready` mandatory for every acceptance, always parse and bind it to the intent/lease, and reject/compensate when no trusted receipt context is available. Pass a trusted receipt clock as part of a required admission command context rather than making readiness conditional on optional telemetry.

### CR-02: The release gate promotes arbitrary deterministic evidence as required live evidence

**File:** `src/promotion/run-promotion.ts:71`
**Issue:** The gate ignores `requirement.live` and only checks that one `passed` observation has the caller-chosen claim. It also never binds an observation's dataset/profile/topology/image to the manifest's eleven immutable input digests. The manifest parser permits arbitrary requirement IDs/claims as long as one says `live`. A direct invocation promoted a candidate where both the `live` claim and the observations were deterministic and the observation input digests differed from the manifest. This bypasses D-121/D-126/D-128/D-129: missing live SLO, host, payment, restore, and supply-chain evidence can be relabelled and promoted.

**Fix:** Define a closed required-claim inventory (including all non-waivable/live classes), require each live requirement to be satisfied by a protected-live observation type, and extend/cross-check observation inputs against every manifest digest, candidate image, source revision, and release ID before promotion. Reject missing, extra, duplicate, or mismatched evidence.

### CR-03: A throwing publication observer strands the original deployment and skips later publication effects

**File:** `src/publication/publication-service.ts:96`
**Issue:** `#observe()` invokes optional `onObservation` without containment. If it throws immediately after `claimPublicationEffect`, `#effect()` exits before the deploy operation is invoked and before its state is recorded as unknown; `dispatchClaimedPublicationEffects()` then aborts before owner-event and attestation dispatch. On a retry, `#submitAuthorized()` sees the persisted signed event and returns status without dispatching the missing original effects. The release then has a permanently claimed-but-never-invoked deployment caused by an observational callback.

**Fix:** Make observer delivery total/non-throwing (as the telemetry exporter is intended to be), and ensure a failure after a claim is durably recorded as `unknown` so reconciliation can observe the same original operation. Add a test with an `onObservation` callback that throws at claim, record, and reconciliation boundaries.

### CR-04: The Collector compatibility gate executes a mutable `latest` image and does not enforce the smoke record

**File:** `scripts/verify-phase-07-otel-packages.ts:17`
**Issue:** The smoke pulls `otel/opentelemetry-collector:latest`, then records whatever digest was obtained. `--verify-root-pins` checks only the package audit/root dependencies (lines 257-258), not a successful smoke record bound to an approved immutable Collector digest and current config. Thus a changed tag can execute an unaudited image during the pre-install compatibility gate and still leave the exact package-pin check green. This contradicts the phase's digest-pinned Collector requirement and weakens the supply-chain boundary.

**Fix:** Store an approved `otel/opentelemetry-collector@sha256:...` reference in reviewed policy/evidence, run Docker only with that immutable reference, and require a valid passing smoke record whose package, lockfile, config, Bun, and Collector digests match current inputs before accepting root pins.

## Warnings

### WR-01: Lifecycle telemetry is implemented only for admission, not the required end-to-end vocabulary

**File:** `src/telemetry/contracts.ts:7`
**Issue:** The typed `LifecycleStageSchema` contains only six admission stages, while the redaction module lists generation, settlement, checkpoint, resume, validation, preview, publication, reconciliation, and promotion. No production caller outside `FundedAdmissionService` invokes the lifecycle port. Those Phase 7 boundary events are therefore neither emitted nor exportable through the purported common vocabulary.

**Fix:** Use one strict stage/outcome schema for the full vocabulary and wire non-authoritative emissions at each named trusted coordinator boundary. Add integration tests proving each subsystem emits only its finite allowed facts.

### WR-02: The claimed 64-case actual-authority corpus is a fixture self-comparison

**File:** `src/certification/phase-07-reference-set.ts:46`
**Issue:** `deterministicObservation()` never calls admission, funding, worker, storage, publication, or promotion authority. It derives `{ status: "passed", value: "case:<id>", zero effects }`, and the fixture supplies the same expected value. The corpus can pass with broken real services and only proves that the fixture and its local formatter agree.

**Fix:** Replace each category's synthetic evaluator with a bounded scenario that invokes the appropriate real service/deterministic port and compares durable state/effect observations against comparator-only expectations. Preserve the current fixture solely as coverage metadata.

### WR-03: Deterministic evidence is not bound to a real source revision

**File:** `tests/fixtures/phase-07-reference-set.json:1`
**Issue:** The committed evidence records `sourceRevision` as 64 `a` characters, which is not a repository object, and validation only checks that it is hexadecimal (`src/certification/evidence.ts:96`). This makes the content-addressed record reproducible but not attributable to the source it purports to certify.

**Fix:** Obtain the checked-out immutable revision from the build environment, require it to resolve in the repository, bind it to the candidate/release manifest, and reject dirty or mismatched source when writing or validating Phase 7 evidence.

---

_Reviewed: 2026-08-05T17:11:41Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_

---

## Fix Resolution (2026-08-05)

All seven findings were addressed in the commits recorded by [07-REVIEW-FIX.md](07-REVIEW-FIX.md). The CR-01 migration also updated every legacy accepting direct-admission fixture to pass explicit receipt context and exact intent/lease-ready proof; separate negative coverage continues to assert that omission fails closed. `bun test` now passes with 473 tests and 0 failures. `bun run eval:phase07` and `bun run verify:phase07-evidence` pass; the latter refreshed immutable evidence against clean source revision `12ab1a7f8dcc260653dd8f41e586d18512fe26e1`.
