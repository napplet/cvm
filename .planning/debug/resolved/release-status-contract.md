---
status: resolved
trigger: "Diagnose and fix the blocking Plan 07-20 product CLI verification mismatch: bun run release:certify -- --status --require-state=authorization_required returns RELEASE_CERTIFICATION_ARGUMENT_REJECTED."
created: 2026-08-06T17:14:49+01:00
updated: 2026-08-06T17:45:00+01:00
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

bug_class: "Bohrbug — the exact CLI input deterministically fails before status output."
hypothesis: "scripts/certify-release.ts rejects --require-state=<state> in its local allowlist and independently rejects status without --candidate, even though the status controller can validate a candidate against its persisted canonical state."
test: "Complete — the exact status command was run against the canonical local workspace after all automated verification."
expecting: "Observed: redacted authorization_required status, no argument rejection, no provider call, and no effect path."
next_action: "Commit the resolved debug artifact and knowledge-base entry; MemPalace indexing is skipped because the feature is disabled and its CLI is unavailable."

reasoning_checkpoint:
  hypothesis: "The status contract fails because the script-level argument gate omits --require-state=<state> and applies its --candidate requirement before branching to the controller's read-only status path."
  confirming_evidence:
    - "The exact Plan 07-20 command reproducibly exits with RELEASE_CERTIFICATION_ARGUMENT_REJECTED."
    - "scripts/certify-release.ts permits only --candidate, --resume, --dry-run, --status, --request, and --receipt, then rejects missing --candidate before calling status."
    - "ReleaseCertificationController.status validates a supplied candidate hash against the immutable current pointer/state chain and only reads pointer, state, and authorization-request files."
  falsification_test: "A pre-fix regression that seeds a valid local workspace and invokes the exact command would emit status JSON instead of RELEASE_CERTIFICATION_ARGUMENT_REJECTED if the parser were not the blocking boundary."
  fix_rationale: "Recognize one exact status-only option, resolve the canonical default candidate only for status so the controller retains its existing hash binding, and compare requested/actual state after read-only status loading."
  blind_spots: "The exact no-candidate contract only has a repository canonical candidate path today; caller-supplied candidate status behavior and all existing release CLI modes must be regression-tested after the minimal change."
  candidate_causes:
    - "code: parser allowlist and unconditional candidate validation disagree with the documented status contract."
    - "config: an invalid or missing workspace could block a routed status call, but cannot produce the observed pre-workspace argument-rejected error."
    - "data: an invalid pointer/state could block status validation, but cannot produce the observed pre-controller argument-rejected error."
  and_gate: "no — the parser defect alone deterministically produces the reported error before workspace or persisted state are consulted."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: "bun run release:certify -- --status --require-state=authorization_required performs a read-only status verification against the canonical persisted workspace and accepts when state matches."
actual: "The exact command returns RELEASE_CERTIFICATION_ARGUMENT_REJECTED before status verification."
errors: "RELEASE_CERTIFICATION_ARGUMENT_REJECTED"
reproduction: "Run bun run release:certify -- --status --require-state=authorization_required from the repository root."
started: "Blocking Plan 07-20 verification; current implementation only permits candidate/resume/dry-run/status/request/receipt and requires --candidate."

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-08-06T17:15:30+01:00
  checked: "MemPalace semantic recall for release certification status/require-state/candidate failure"
  found: "mempalace CLI is not installed (command not found)."
  implication: "Semantic recall is unavailable; use durable knowledge-base keyword fallback."
- timestamp: 2026-08-06T17:15:30+01:00
  checked: ".planning/debug/knowledge-base.md keyword fallback"
  found: "Only prior resolved entry concerns OpenTelemetry approval-input digest drift; no two-keyword overlap with this CLI argument rejection."
  implication: "No known-pattern candidate applies; continue open-ended investigation."
- timestamp: 2026-08-06T17:17:10+01:00
  checked: "Exact reported command"
  found: "bun run release:certify -- --status --require-state=authorization_required exits 1 with RELEASE_CERTIFICATION_ARGUMENT_REJECTED."
  implication: "The failure is deterministic and occurs before any status record is emitted."
- timestamp: 2026-08-06T17:17:10+01:00
  checked: "Code graph search for release certification"
  found: "ReleaseCertificationController.status is at src/release/controller.ts:182-214; runReleaseCertification is at lines 441-444."
  implication: "The candidate parser script must be traced into this controller to prove the rejection boundary and preserve the no-provider status path."
- timestamp: 2026-08-06T17:19:00+01:00
  checked: "Plan 07-20 verification contract"
  found: "07-20-PLAN.md:76 specifies exactly bun run release:certify -- --status --require-state=authorization_required."
  implication: "This is a specified API-contract regression, not an optional CLI enhancement."
- timestamp: 2026-08-06T17:19:00+01:00
  checked: "Graph trace of ReleaseCertificationController.status"
  found: "The status method's graph callees are local pointer/state/request parsing and canonical hashing; provider registry construction is not on its outbound call path."
  implication: "A correctly routed status invocation can remain effect-free and provider-free."
- timestamp: 2026-08-06T17:19:00+01:00
  checked: "Spectrum-based fault localization eligibility"
  found: "No existing per-test coverage run has both a failing and passing test for this CLI contract."
  implication: "SBFL is skipped; this deterministic Bohrbug routes to direct reproduction and parser/controller tracing."
- timestamp: 2026-08-06T17:19:00+01:00
  checked: "Common bug-pattern categories"
  found: "The symptom matches Data Shape / API Contract drift: the documented CLI option is absent from the implemented parser interface."
  implication: "Test argument parsing and status semantics, not timing or environment, first."
- timestamp: 2026-08-06T17:19:00+01:00
  checked: "Initial worktree state"
  found: "Unrelated untracked research cache, deno.lock, and design evidence files already exist; this debug artifact is also untracked."
  implication: "Limit all edits and staging to the assigned script, test, and debug artifact; preserve unrelated files."
- timestamp: 2026-08-06T17:22:30+01:00
  checked: "Complete scripts/certify-release.ts and tests/release/certify-release.test.ts"
  found: "The allowlist excludes --require-state=<state>; !candidatePath is unconditional, so status cannot run without a candidate; no existing test covers the specified no-candidate status command or mismatch behavior."
  implication: "Both parser acceptance and status-only candidate resolution require a focused regression."
- timestamp: 2026-08-06T17:22:30+01:00
  checked: "Complete ReleaseCertificationController.status implementation"
  found: "Status verifies current pointer, digest-chained state, authorization request, and candidate SHA-256; it reads candidatePath solely to preserve candidate binding and contains no provider-discovery or effect call."
  implication: "The script can preserve binding by supplying a canonical candidate path for no-candidate status; effects remain unreachable from status."
- timestamp: 2026-08-06T17:25:30+01:00
  checked: "Agent-authored focused status-contract regression before production fix"
  found: "The matching command test fails at tests/release/certify-release.test.ts:76 because stderr contains RELEASE_CERTIFICATION_ARGUMENT_REJECTED."
  implication: "The regression reproduces the original reported parser defect with a specified, non-implicit oracle."
- timestamp: 2026-08-06T17:28:30+01:00
  checked: "Focused status-contract regression after production fix"
  found: "The test passes: matching status emits the persisted authorization_required state and completed requirement fails with RELEASE_CERTIFICATION_STATE_MISMATCH before stdout."
  implication: "The minimal change satisfies both the specified command and fail-closed mismatch behavior using only local files with PATH disabled."
- timestamp: 2026-08-06T17:28:30+01:00
  checked: "Production diff and whitespace validation"
  found: "The diff adds guarded parsing and comparison logic plus its regression; git diff --check is clean and no behavior is deleted or bypassed."
  implication: "The no-op/deletion guardrail signal is provisionally satisfied."
- timestamp: 2026-08-06T17:30:00+01:00
  checked: "Full release CLI test file"
  found: "bun test tests/release/certify-release.test.ts passes: 9 tests, 29 assertions, 0 failures."
  implication: "Existing CLI modes remain intact alongside the new exact status contract."
- timestamp: 2026-08-06T17:31:30+01:00
  checked: "Exact product status command after fix"
  found: "bun run release:certify -- --status --require-state=authorization_required now emits redacted authorization_required JSON from the canonical local workspace; its exit 1 is the controller's documented authorization boundary."
  implication: "The reported argument rejection is gone and the command performs only persisted-state verification."
- timestamp: 2026-08-06T17:33:00+01:00
  checked: "Plan 07-20 historical controller test-name filter"
  found: "bun test tests/release/controller.test.ts --test-name-pattern='authorization receipt|changed scope|expired|cost ceiling' matched zero current test names."
  implication: "This is a stale verification filter, not a behavioral test failure; run the entire adjacent controller file."
- timestamp: 2026-08-06T17:33:00+01:00
  checked: "Mutation-test configuration"
  found: "No Stryker or mutation configuration file and no mutation npm script exists."
  implication: "Mutation guardrail is skipped with a documented unavailable-tool reason."
- timestamp: 2026-08-06T17:34:00+01:00
  checked: "Complete adjacent release controller test file"
  found: "bun test tests/release/controller.test.ts passes: 8 tests, 42 assertions, 0 failures."
  implication: "The existing no-effect authorization boundary and candidate/state protections remain intact."
- timestamp: 2026-08-06T17:36:00+01:00
  checked: "Full Bun suite"
  found: "bun test passes: 616 tests, 4,713 assertions, 0 failures."
  implication: "The focused CLI change has no detected project-wide regression before the causality reversal check."
- timestamp: 2026-08-06T17:38:00+01:00
  checked: "Focused regression with only production parser/status patch reversed"
  found: "The test returns to its original failure: RELEASE_CERTIFICATION_ARGUMENT_REJECTED at tests/release/certify-release.test.ts:76."
  implication: "The exact production parser diff is necessary for the regression to pass."
- timestamp: 2026-08-06T17:40:30+01:00
  checked: "Focused regression after reapplying production parser/status patch"
  found: "bun test tests/release/certify-release.test.ts --test-name-pattern='status accepts the documented require-state contract' passes: 1 test, 7 assertions, 0 failures."
  implication: "The re-applied production patch restores the specified contract and completes the revert-and-reconfirm guardrail."
- timestamp: 2026-08-06T17:42:00+01:00
  checked: "Final scoped diff and TypeScript compiler availability"
  found: "git diff --check is clean; the source/test diff is limited to 39 additions and 4 replacements; node_modules/.bin/tsc is not installed."
  implication: "No formatting or scope issue was found; static typecheck is unavailable and Bun test remains the available validation gate."
- timestamp: 2026-08-06T17:45:00+01:00
  checked: "Atomic source/test commit and MemPalace availability"
  found: "Commit be459d8 contains only scripts/certify-release.ts and tests/release/certify-release.test.ts; MemPalace is disabled in planning config and its CLI is unavailable."
  implication: "The code fix is committed independently; durable knowledge-base append is the retained recurrence memory."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "The release-certification CLI parser drifted from Plan 07-20: it rejects --require-state=<state> and requires --candidate before entering the read-only status branch, so the specified status verification cannot reach the controller."
fix: "Added strict status-only --require-state=<state> parsing, a canonical repository candidate fallback only when --status omits --candidate, and a pre-output state mismatch guard. Non-status modes still require --candidate and status retains controller hash binding."
verification:
  target_test: { result: pass, command: "bun test tests/release/certify-release.test.ts --test-name-pattern='status accepts the documented require-state contract'" }
  mutation_check: { result: skipped, reason_if_skipped: "No Stryker/mutation configuration or package script is present." }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, evidence: "Scoped diff adds strict parsing, canonical candidate fallback, mismatch guard, and regression coverage; git diff --check passes." }
  adjacent_tests: { result: pass, suites_run: ["bun test tests/release/certify-release.test.ts", "bun test tests/release/controller.test.ts", "bun test"] }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true }
  guardrail_verdict: accepted
files_changed: ["scripts/certify-release.ts", "tests/release/certify-release.test.ts"]
oracle_type: "specified — Plan 07-20 explicitly requires the exact status command and the controller contract requires a state mismatch to fail closed."
