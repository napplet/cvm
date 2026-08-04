---
phase: 02
fixed_at: 2026-08-04T15:07:46Z
review_path: .planning/phases/02-trusted-core-isolated-agent-execution/02-REVIEW.md
iteration: 7
findings_in_scope: 1
fixed: 1
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Source review:** `.planning/phases/02-trusted-core-isolated-agent-execution/02-REVIEW.md`
**Iteration:** 7

## Summary

- Findings in scope: 1
- Fixed: 1
- Skipped: 0
- This re-review closes CR-09: completed effects are bound to their original execution attempt, so a later stale retry cannot emit a fresh call; prior iteration fixes remain preserved below.

## Fixed Issues

### CR-09: A stale final commit lets an exact retry create a fresh effect intent

**Files modified:** `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `tests/phase-02/tracer.test.ts`
**Commit:** `fe54d02`
**Applied fix:** Every effect intent now carries the durable worker-lease token that created it. Only completed calls from that same live attempt may open another tool call; any prior intent from a replacement attempt blocks the retry regardless of call ID or request fingerprint. Legacy rows without an attempt token are conservatively fenced. Regressions cover the stale-final-commit call-1/call-2 duplication and the valid same-attempt two-tool flow.

### CR-07: An expired lease can be stolen while its original owner still dispatches effects

**Files modified:** `src/capabilities/scoped-tool-gateway.ts`, `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `tests/phase-02/tracer.test.ts`
**Commits:** `0ce914e`, `671a186`
**Applied fix:** The gateway atomically claims a durable, unique effect intent before dispatch and ignores all dispatcher-provided acceptance markers. The store returns `created` only to the transaction that inserted the row; any existing in-flight claim becomes durable `uncertain` and is denied. The exact retry/reclaim regression proves B cannot dispatch after A's stalled claim, while A's resume still causes at most one effect.

### CR-08: External effects run inside a rollbackable SQLite transaction

**Files modified:** `src/capabilities/scoped-tool-gateway.ts`, `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`, `tests/evals/phase-02-reference-set.test.ts`
**Commit:** `0ce914e`
**Applied fix:** External dispatch occurs only after the intent transaction commits. The trusted gateway records completion itself; a throw or ambiguous outcome becomes a durable `uncertain` intent. Exact and competing retries fail closed, so an effect-then-throw cannot dispatch a second time.

### CR-05: Separate core instances can both cause effects for one session version

**Files modified:** `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`
**Commit:** `242833a`
**Applied fix:** Added a durable, expiring session/version worker lease before allocation or gateway effects. The SQLite lease is atomic across independently composed cores; the loser cannot invoke a worker or dispatcher, and leases are released on every post-claim exit.

### CR-06: Artifact conformance is still an untrusted worker claim, with no durable accepted-artifact identity

**Files modified:** `src/domain/session-action.ts`, `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`, `tests/evals/phase-02-reference-set.test.ts`
**Commit:** `242833a`
**Applied fix:** Replaced worker-derived contract input with a coordinator-owned `ArtifactVerifier`, defaulting final composition to fail closed. Accepted content and report digests are part of the durable action fingerprint, evidence, and result; a separate request fingerprint preserves pre-worker exact replay.

### CR-01: Session ownership is checked only after worker and gateway effects

**Files modified:** `src/persistence/session-store.ts`, `src/persistence/sqlite-session-store.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`
**Commit:** `66ea938`
**Applied fix:** Added a durable pre-effect principal/version fence; the commit-time fence remains authoritative for races.

### CR-02: The canonical WorkerPort permits more than the policy turn ceiling

**Files modified:** `src/phase-02/contracts.ts`, `tests/phase-02/tracer.test.ts`, `tests/worker-port/contracts.test.ts`
**Commit:** `8ff0ed4`
**Applied fix:** Completed worker events must be non-empty, strictly ordered, and bounded by `maxTurns` before any dispatch.

### CR-03: Final composition commits an empty worker result through a fabricated passing artifact gate

**Files modified:** `src/phase-02/contracts.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`, `tests/evals/phase-02-reference-set.test.ts`
**Commits:** `acb2907`, `6d2daad`
**Applied fix:** Completed results require a correlated artifact identity and pass-only upstream evidence; the core derives the artifact contract input from it. The compatibility correction keeps generic artifact-policy callers unchanged.

### CR-04: Checkpoint evidence is accepted without being hash-bound to returned worker events

**Files modified:** `src/phase-02/contracts.ts`, `src/phase-02/trusted-core.ts`, `src/worker-port/fake-worker.ts`, `tests/worker-port/contracts.test.ts`, `tests/worker-port/fake-worker.test.ts`
**Commit:** `77bf2b2`
**Applied fix:** Checkpoints require one matching checkpoint event, one matching export request, event-evidence digest equality, and an inventory bound into a canonical archive envelope before effects are dispatched.

### WR-01: The Modal candidate adapter never delivers the WorkerRunRequest to the sandbox

**Files modified:** `src/worker-adapters/modal-worker.ts`, `tests/integration/modal-probe.test.ts`
**Commit:** `8fb631f`
**Applied fix:** A one-time coordinator-owned request file carries the parsed canonical request to the default-deny sandbox; the adapter parses a canonical correlated result and terminates/revokes on every outcome.

### WR-02: Per-check design evidence digests do not identify their named checks

**Files modified:** `scripts/verify-phase-02-design-slice.ts`, `evidence/design/phase-02.json`, `evidence/design/bb4e421c5922dec00e989929d9e05cb01bbf71f59c9dfde529e45ee705147184.json`
**Commit:** `9a396d1`
**Applied fix:** Each named check hashes its exact scoped tests/source paths; full-suite and reference-evaluation aggregate records are separate. The command re-hashes the immutable provider record addressed by the mutable pointer.

## Security Extensions

- **T-02-14:** Fixed with CR-04: event/evidence/archive inventory binding.
- **T-02-17:** Fixed in `d1e5bd1`: Modal probe inventory now requires an exact hash-bound manifest.
- **T-02-20:** Fixed with WR-02: design evidence verifies the immutable provider record and recomputes its digest.
- **T-02-03:** Remains medium and non-blocking: durable session evidence does not yet carry direct principal, policy, and capability-grant fields, although the action fingerprint binds principal and policy indirectly.
- **T-02-18:** Remains medium and non-blocking: provider evidence does not yet durably bind SDK version, complete config/resource ceilings, and termination outcome.

## Verification

- `bun test` — 189 pass, 0 fail.
- `bun run eval:phase-02` — 33 pass, 0 fail.
- `bun run test:phase-02-design-slice` — passed.
- `git diff --check` — passed.

_Fixer: gsd-code-fixer_
