---
status: resolved
trigger: "Two Phase 7 OpenTelemetry delegated-approval tests fail after the Phase 7 planning and audit artifacts changed."
created: 2026-08-05T21:59:00Z
updated: 2026-08-05T23:00:00Z
---

# Debug Session: OTel approval digest drift

## Symptoms

- **Expected:** `tests/phase-07/otel-package-legitimacy.test.ts` passes all seven checks and approval/root-pin verifier modes exit zero.
- **Actual:** five checks pass; delegated approval verification rejects, and `--verify-root-pins` exits 1.
- **Errors:** `verifyApprovedOtelPackageSet({ repositoryRoot: root })` rejects; the approval CLI returns code 1 instead of 0.
- **Timeline:** The suite passed before the Phase 7 review/security/planning documents were updated and Plan 07-18 was committed.
- **Reproduction:** `bun test tests/phase-07/otel-package-legitimacy.test.ts --timeout 10000`.

## Current Focus

- **hypothesis:** The Phase 07-18 release-verification script changed `package.json` after Phase 07-11 created the content-addressed approval and successful smoke evidence; both records intentionally bind the former full-file hash, so no currently valid approval/smoke chain can authorize root pins.
- **bug_class:** bohrbug (the named test suite deterministically reports the same two failures).
- **pattern_candidates:** data-integrity drift (immutable record compared with mutated root input); configuration/environment path selection (alternate explanation: verifier reads a different root than the approval fixture expects).
- **fault_tree:** code/evidence: stale approval record, pointer digest, audit digest, package-set digest, or root-input digest; config/environment: incorrect repository root or invocation cwd; data: later `package.json`/`bun.lock` content change despite unchanged OTel identities.
- **hypothesis:** Confirmed — a post-approval package-manifest change left the required delegated approval and Collector smoke evidence bound to stale root-input digests.
- **test:** Self-verification, all applicable fix-acceptance guardrail signals, and external human verification are complete.
- **expecting:** The session is archived with its prevention record.
- **next_action:** None — resolved.
- **reasoning_checkpoint:**
  **hypothesis:** The Phase 07-18 release-verification script changed `package.json` after Phase 07-11 created the content-addressed approval and successful smoke evidence; both records intentionally bind the former full-file hash, so no currently valid approval/smoke chain can authorize root pins.
  **confirming_evidence:**
    - "The shared approval CLI emits `APPROVAL_INPUT_DIGEST_DRIFT`; only `package.json` differs from the approval record, while `bun.lock` still matches."
    - "Git history shows Phase 07-18 added only `release:verify:protected` after Phase 07-11 minted the approval; no OTel identity or lockfile changed."
    - "`verifyCurrentSmokeRecord` requires the current approval digest and root-input digests; its only passing record carries the stale values."
  **falsification_test:** "After a valid renewal, `--require-approved` must pass; if it still fails any prior pointer, audit, package-set, or record-digest invariant, stale root input was not the complete cause."
  **fix_rationale:** "Preserve the fail-closed full-manifest binding required by the existing drift test, and mint a new immutable delegated decision for the unchanged package set at the changed root state; then run the actual smoke to create a new immutable record bound to that decision."
  **blind_spots:** "The record models delegated-operator approval but has no cryptographic signer provenance; this session can renew repository evidence but cannot establish a real external human review."
  **candidate_causes:**
    - "code: verifier intentionally snapshots the entire `package.json`, not merely the six dependency fields; the current regression test requires that policy."
    - "data: approval and the only usable smoke evidence contain the pre-07-18 package-manifest digest."
    - "process/config: Phase 07-18 changed the manifest without an evidence-renewal step; no environment or working-directory mismatch is observed."
  **and_gate:** "yes — to make the root-pin acceptance path valid, both a replacement immutable approval bound to the current root inputs and a replacement smoke record bound to that approval must exist; refreshing only one leaves a required verifier condition false."
- **tdd_checkpoint:**

## Evidence

- **timestamp:** 2026-08-05T22:05:00Z
  **checked:** Semantic/keyword knowledge-base recall.
  **found:** `.planning/debug/knowledge-base.md` does not yet exist, so no prior-resolution match is available.
  **implication:** Investigation proceeds from the current repository evidence rather than a known-pattern candidate.

- **timestamp:** 2026-08-05T22:07:00Z
  **checked:** `bun test tests/phase-07/otel-package-legitimacy.test.ts --timeout 10000`.
  **found:** The suite reliably has five passing and two failing tests. The direct `verifyApprovedOtelPackageSet({ repositoryRoot })` promise rejects, and the approval CLI invoked with `--verify-root-pins` returns exit code 1. Exact package identity, mutation, no-install, and collector-digest checks pass.
  **implication:** The problem is isolated to the shared approval-dependent verification path, not the base package or collector pin validation.

- **timestamp:** 2026-08-05T22:10:00Z
  **checked:** Symbol and literal discovery for the failing shared verifier.
  **found:** Both failures invoke `verifyApprovedOtelPackageSet` in `scripts/verify-phase-07-otel-packages.ts`; the same function gates `--require-approved` and `--verify-root-pins`. The immutable approval pointer, approval evidence, audit pointer, and audit evidence are all under `evidence/certification/`.
  **implication:** One rejected invariant inside the shared verifier can explain both failures, so tracing that function and its four evidence records is the shortest discriminating path.

- **timestamp:** 2026-08-05T22:15:00Z
  **checked:** Complete shared-verifier and test paths plus approval/audit pointers and immutable records.
  **found:** `verifyApprovedOtelPackageSet` checks immutable pointers and records before comparing SHA-256 snapshots of the current `package.json` and `bun.lock` with `approval.rootInputDigests`. Both failing test modes use this function before their mode-specific checks. The approval record pins different audit-time and root-time input digest pairs, so root changes after the audit are explicitly supported only when the root pair remains the approved value.
  **implication:** The next CLI invocation distinguishes a root-input digest mismatch from every earlier pointer/record/package invariant in one observation. SBFL is skipped: the runnable Bun suite has no per-test coverage spectrum configured, only aggregate test results.

- **timestamp:** 2026-08-05T22:18:00Z
  **checked:** Shared CLI and live root-input SHA-256 snapshots.
  **found:** `bun scripts/verify-phase-07-otel-packages.ts --require-approved` emits exactly `APPROVAL_INPUT_DIGEST_DRIFT`. Current `bun.lock` is `8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3`, which matches the approval record; current `package.json` is `3d4df39618c30be83c425f794e861aa3543133b92bbacf05c5696065aaf566a9`, which differs from the approved `f40703e834c39c7ff1584b7f9ad7d0dc6745a8b9340ffe97be49dc091de3a37c`.
  **implication:** The original hypothesis is confirmed for `package.json`; all earlier verifier invariants pass. An incorrect working directory or `bun.lock` drift cannot explain the failure.

- **timestamp:** 2026-08-05T22:23:00Z
  **checked:** Git history for `package.json`, approval evidence, and their ordering.
  **found:** Commit `1d062587` created the approval record with the now-stale package manifest digest. Later commit `41bae158` added only the non-OTel `release:verify:protected` package script, producing the current `package.json` digest. No OpenTelemetry dependency version, integrity, or `bun.lock` change occurred after approval.
  **implication:** The root cause is a stale immutable approval binding: whole-file `package.json` pinning means the post-approval release-command addition invalidates the approval even though the approved package set did not change. The current contract’s input-drift mutation test intentionally treats any manifest change as invalidation, so the safe repair is a newly content-addressed approval plus any required dependent evidence, not weakening the verifier.

- **timestamp:** 2026-08-05T22:31:00Z
  **checked:** Canonical reconstruction of a delegated decision with only current root input digests and renewed decision timestamps.
  **found:** The canonical replacement approval payload hashes to `09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c`. It retains the audited package set and audit evidence exactly, replaces only `rootInputDigests.packageJsonSha256` with `3d4df39618c30be83c425f794e861aa3543133b92bbacf05c5696065aaf566a9`, and renews the decision/expiry timestamps.
  **implication:** The immutable-record/pointer pair and one hardcoded expected-decision digest can be updated coherently without weakening the verifier or changing package evidence.

- **timestamp:** 2026-08-05T22:35:00Z
  **checked:** Renewed delegated approval CLI path after updating the immutable record, pointer, and expected digest constant.
  **found:** `--require-approved` exits zero and returns approval digest `09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c`, the unchanged audit digest, and the unchanged package-set digest.
  **implication:** The stale approval record was the first rejected invariant and the replacement evidence is internally coherent. The only remaining expected dependency is a smoke record bound to this replacement approval and the current root inputs.

- **timestamp:** 2026-08-05T22:38:00Z
  **checked:** Root-pin verifier immediately after approval renewal and before smoke renewal.
  **found:** It emits exactly `COLLECTOR_SMOKE_RECORD_REQUIRED`.
  **implication:** This confirms the AND-gate: prior immutable smoke records cannot be reused under a new approval/root-input generation, and a real new smoke execution is required rather than copying evidence.

- **timestamp:** 2026-08-05T22:42:00Z
  **checked:** Real disposable Bun/Collector smoke workflow with Docker available.
  **found:** The workflow passed and wrote `evidence/certification/otel-package-smokes/23991864857cc45d6557e96907a9af75084b7b29d49023fb50a8fe8d44849919.json` with evidence digest `23991864857cc45d6557e96907a9af75084b7b29d49023fb50a8fe8d44849919`.
  **implication:** A fresh smoke record now exists for the current root state and renewed approval; the end-to-end root-pin path can be tested without bypassing immutable evidence checks.

- **timestamp:** 2026-08-05T22:46:00Z
  **checked:** Original reproduction and both approval-dependent CLI modes after evidence renewal.
  **found:** `--require-approved` and `--verify-root-pins` both exit zero and return the same renewed approval/audit/package-set digests. The original `otel-package-legitimacy` suite now passes all seven tests and 47 assertions, including its fail-closed mutation cases.
  **implication:** Target-test signal passes with a specified oracle: the contract explicitly requires root pins to use exactly the same valid delegated decision and audit digests as the shared verifier, while altered fixture inputs must reject.

- **timestamp:** 2026-08-05T22:50:00Z
  **checked:** Guardrail import-graph, mutation-tool, and diff inspection.
  **found:** `tests/phase-07/otel-package-legitimacy.test.ts` is the only direct test consumer of the changed verifier symbols. No Stryker configuration or installed package is present. `git diff --check` reports no whitespace errors; the scoped diff only replaces the approved content digest/pointer and adds content-addressed approval/smoke evidence, with no deleted or short-circuited verification behavior.
  **implication:** Mutation testing is unavailable and logged as skipped. The no-op/deletion signal passes, and the complete Phase 7 test directory is the appropriate adjacent-test scope.

- **timestamp:** 2026-08-05T22:54:00Z
  **checked:** `bun test tests/phase-07 --timeout 10000`.
  **found:** All 80 tests in 11 Phase 7 files pass (512 assertions), including the renewed OTel approval/root-pin test.
  **implication:** Adjacent-test signal passes; no other Phase 7 certification contract regressed from the evidence renewal.

- **timestamp:** 2026-08-05T22:58:00Z
  **checked:** Scoped revert-and-reconfirm of exactly the four fix paths.
  **found:** Temporarily stashing the verifier constant, approval pointer, renewed approval record, and renewed smoke record restored the original test's exact two failures (five pass, two fail). Restoring that scoped stash made all seven original tests pass again. The stash restored cleanly with exit code 0.
  **implication:** Revert-and-reconfirm passes: the renewed immutable evidence chain, rather than unrelated workspace state, is causally responsible for the repair.

- **timestamp:** 2026-08-05T23:00:00Z
  **checked:** Human verification in the intended environment.
  **found:** The focused OTel suite passed 7/7; `--require-approved` and `--verify-root-pins` both passed with renewed approval digest `09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c` and matching audit/package-set digests.
  **implication:** The repaired immutable approval-and-smoke chain works end-to-end outside the debugger's own execution context.

## Eliminated

- **hypothesis:** The verifier was reading an incorrect repository root or had environment-specific path resolution.
  **evidence:** The direct CLI at the repository root reports the specific current-input error, and the failing fixture copies that same root state before calling the verifier with an explicit `repositoryRoot`.
  **timestamp:** 2026-08-05T22:18:00Z

## Resolution

- **root_cause:** The Phase 07-18 package-script addition changed the full `package.json` after the Phase 07-11 delegated approval and successful smoke record were minted. The verifier intentionally binds full root-input digests, but the required immutable approval-and-smoke evidence renewal was omitted.
- **fix:** Renewed the content-addressed delegated approval for current root inputs, updated its pointer/constant, and generated a real Collector smoke record bound to that approval.
- **oracle_type:** specified
- **verification:**
  **target_test:** { result: pass, suite: "bun test tests/phase-07/otel-package-legitimacy.test.ts --timeout 10000", oracle_type: specified }
  **mutation_check:** { result: skipped, reason_if_skipped: "No Stryker configuration or installed Stryker package is present." }
  **no_op_deletion:** { result: pass, deletion_justified_by_rca: false, evidence: "Scoped diff renews required immutable evidence and its expected digest; no validation branch or assertion was removed." }
  **adjacent_tests:** { result: pass, suites_run: ["bun test tests/phase-07 --timeout 10000"] }
  **revert_and_reconfirm:** { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true, scope: "four renewal paths only" }
  **guardrail_verdict:** accepted
- **files_changed:**
  - `scripts/verify-phase-07-otel-packages.ts`
  - `evidence/certification/phase-07-otel-package-approval.json`
  - `evidence/certification/otel-package-approvals/09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c.json`
  - `evidence/certification/otel-package-smokes/23991864857cc45d6557e96907a9af75084b7b29d49023fb50a8fe8d44849919.json`

## Prevention

- **5 Whys — data/change management:** The verifier rejected the approval because its full-manifest digest was stale; a later release-command edit changed `package.json`; that plan did not renew approval-dependent evidence; the evidence lifecycle was not linked to manifest changes; no pre-merge renewal check existed for this immutable-evidence dependency.
- **5 Whys — verification/process:** The focused regression suite could detect the drift; it was only run after the Phase 07-18 change had landed; the release workflow did not run the approval/root-pin checks as a required precondition for manifest edits; therefore the stale chain was discovered in the closure loop rather than at the editing boundary.
- **why_not_caught:** No required pre-merge gate ran the approval/root-pin verifier after the `package.json` change that invalidated the immutable evidence chain.
- **recurrence_guard:** `tests/phase-07/otel-package-legitimacy.test.ts` plus `scripts/verify-phase-07-otel-packages.ts --require-approved` and `--verify-root-pins` fail closed whenever the current manifest no longer matches the delegated approval and its smoke evidence.
