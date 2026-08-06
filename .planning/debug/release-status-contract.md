---
status: awaiting_human_verify
trigger: "Diagnose and fix the blocking Plan 07-20 product CLI verification mismatch: bun run release:certify -- --status --require-state=authorization_required returns RELEASE_CERTIFICATION_ARGUMENT_REJECTED."
created: 2026-08-06T17:14:49+01:00
updated: 2026-08-06T18:08:00+01:00
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

bug_class: "Bohrbug — both follow-on failures are deterministic CLI/test-selection contract mismatches."
hypothesis: "Confirmed: the CLI discarded a successful explicit status assertion by returning the controller authorization-boundary code; Plan 07-20's literal filter selected no controller test names."
test: "Completed: focused red/green/reversal testing, exact combined Plan verification, and the full Bun suite."
expecting: "Await confirmation that the exact Plan command also succeeds in the caller's normal workflow; no provider or deployment effect is expected."
next_action: "Await human verification of the exact Plan 07-20 command; if confirmed, archive this reopened debug session and append its follow-on prevention record."

reasoning_checkpoint:
  hypothesis: "A matching explicit status assertion returns exit 1 because the CLI unconditionally returns result.exitCode after proving equality, while the Plan test filter has no matching controller-test name."
  confirming_evidence:
    - "The focused pre-fix CLI test observed matchingCode=1 after correct authorization_required JSON."
    - "The exact Plan filter originally matched zero tests; after the pure named regression it selected and passed one test."
    - "scripts/certify-release.ts returns result.exitCode immediately after the require-state mismatch guard."
  falsification_test: "After the return guard, a matching --status --require-state=authorization_required must still exit 1, or a nonmatching/unasserted status must exit 0."
  fix_rationale: "Returning 0 only after a supplied require-state has matched turns the assertion into a shell-success predicate without altering the controller's authorization_required state or ordinary status exit code."
  blind_spots: "The release state vocabulary is not syntactically validated by the parser; an unknown value still reaches the read-only status path and fails as a mismatch, which is the required fail-closed behavior."
  candidate_causes:
    - "code: the CLI discards its successful equality result and returns the controller boundary exit code"
    - "test-contract: controller test names omit every literal alternative required by the Plan filter"
  and_gate: "yes — the exact Plan command uses &&, so both independent defects must be corrected for it to complete."

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
- timestamp: 2026-08-06T17:46:30+01:00
  checked: "Planning-document commits and final worktree scope"
  found: "Resolved-session artifact committed as 0088534, knowledge-base entry committed as baacf82; remaining untracked files are pre-existing unrelated research cache, lockfile, and design evidence."
  implication: "The debug lifecycle is complete without staging or altering unrelated work."
- timestamp: 2026-08-06T17:50:00+01:00
  checked: "Follow-on Plan 07-20 verification report"
  found: "A matching explicit --require-state assertion still returns the controller's authorization_required exit 1, preventing the plan's && chain; the exact controller test-name filter matches zero tests."
  implication: "Reopen the same session for two deterministic, effect-free verification-contract defects."
- timestamp: 2026-08-06T17:52:00+01:00
  checked: "Exact combined Plan 07-20 verification"
  found: "The first command emits correct authorization_required JSON but exits 1, so shell && prevents the controller test command from running."
  implication: "The CLI must distinguish a matching explicit requirement from its ordinary nonzero authorization-boundary status."
- timestamp: 2026-08-06T17:52:00+01:00
  checked: "Exact Plan 07-20 controller test filter"
  found: "The filter authorization receipt|changed scope|expired|cost ceiling matches zero tests in tests/release/controller.test.ts."
  implication: "Relevant integrity coverage must be given names that match the documented verification command."
- timestamp: 2026-08-06T17:52:00+01:00
  checked: "Code graph and common-pattern classification"
  found: "ReleaseCertificationController.status is a read-only controller method; the follow-ons match deterministic API/test-contract drift rather than provider, timing, or data corruption behavior."
  implication: "Classify as a Bohrbug; no SBFL run is eligible because the reported failures are command-contract failures rather than a failing covered test pair."
- timestamp: 2026-08-06T17:54:00+01:00
  checked: "Complete release CLI and controller tests"
  found: "scripts/certify-release.ts returns result.exitCode after matching require-state; the matching CLI regression currently asserts exit 1. Existing controller test names cover changed gcloud scope but no exact authorization receipt, changed scope, expired, or cost ceiling filter token."
  implication: "The two failures are direct code/test-contract omissions, not state or provider behavior."
- timestamp: 2026-08-06T17:56:00+01:00
  checked: "Complete authorization request/receipt implementation and adjacent authorization tests"
  found: "validateAuthorizationReceipt is a local schema/canonical-hash operation that rejects expiry at nowMs >= expiresAtMs and receipt changes with RELEASE_AUTHORIZATION_RECEIPT_INVALID; request scope or cost changes invalidate the request digest before any provider interaction."
  implication: "One controller-file regression can cover receipt integrity, changed scope, expiry, and cost ceiling without constructing a provider registry or invoking an effect."
- timestamp: 2026-08-06T17:58:00+01:00
  checked: "Test-first regression patch"
  found: "The CLI regression now specifies exit 0 for the exact matching assertion and preserves nonzero expectations for unasserted, mismatched, missing, and invalid states. A separately named controller regression checks local receipt integrity, changed scope, expiration, and cost ceiling tampering."
  implication: "The planned tests distinguish the intended narrow success override from all fail-closed cases and make Plan 07-20's literal filter meaningful."
- timestamp: 2026-08-06T18:00:00+01:00
  checked: "Focused red phase and exact Plan controller filter"
  found: "The matching CLI test fails with Expected: 0, Received: 1; the exact authorization receipt|changed scope|expired|cost ceiling filter selects one pure controller test and passes with five assertions."
  implication: "The CLI root cause is confirmed by a specified failing oracle, and the test-filter defect is resolved without provider or deployment effects."
- timestamp: 2026-08-06T18:01:00+01:00
  checked: "Minimal production return-code patch"
  found: "scripts/certify-release.ts now returns 0 only when status is true and an explicit requiredState has already passed the equality guard; all other modes retain result.exitCode."
  implication: "The patch is limited to the shell assertion contract and cannot change controller state, authorization, provider, or effect behavior."
- timestamp: 2026-08-06T18:02:00+01:00
  checked: "Focused green phase and exact combined Plan 07-20 command"
  found: "The CLI regression passes with 15 assertions; the exact combined command exits 0, emits authorization_required JSON, and runs the one selected no-effect controller regression successfully."
  implication: "The matching shell predicate is fixed while the Plan filter now exercises receipt integrity, changed scope, expiry, and cost ceiling checks."
- timestamp: 2026-08-06T18:04:00+01:00
  checked: "Full Bun suite and scoped diff"
  found: "bun test passes: 617 tests, 4,726 assertions, 0 failures; git diff --check is clean and the source/test diff consists of the one-line CLI guard plus targeted test additions."
  implication: "The planned regression and surrounding project functionality pass; no whitespace, deletion-only, or out-of-scope production change is present."
- timestamp: 2026-08-06T18:05:00+01:00
  checked: "Focused regression with the production return guard reversed"
  found: "The matching assertion returns to red with Expected: 0, Received: 1."
  implication: "The return-code guard is necessary for the specified Plan shell-success behavior."
- timestamp: 2026-08-06T18:06:00+01:00
  checked: "Focused regression after reapplying the production return guard"
  found: "The matching-assertion test passes: 1 test, 15 assertions, 0 failures."
  implication: "The re-applied guard restores the specified success predicate and completes the causality check."
- timestamp: 2026-08-06T18:08:00+01:00
  checked: "Final exact combined Plan 07-20 command and worktree scope"
  found: "The combined command exits 0, prints redacted authorization_required status JSON, and runs the one selected controller integrity regression. git diff --check is clean; only the assigned script/test files and reopened debug record are in scope."
  implication: "All automated fix-acceptance signals pass without provider, deployment, credential, or network activity; retain human confirmation before archiving."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "scripts/certify-release.ts unconditionally returns the controller's nonzero authorization-boundary exit code after a successful explicit --require-state equality check; tests/release/controller.test.ts had no test name selected by Plan 07-20's required filter."
fix: "Return exit 0 only for a status invocation with an explicit --require-state that already matched; add a pure controller-file authorization receipt integrity regression whose name satisfies the documented Plan filter; expand the CLI regression to cover matching, unasserted, mismatch, missing, and invalid cases."
verification: "guardrail_verdict: accepted; specified-oracle red/green test passed (1 test, 15 assertions); exact combined Plan command passed; controller filter selected the local integrity test (1 test, 5 assertions); full bun test passed (617 tests, 4,726 assertions); reverting the one-line guard restored the original failure and reapplying restored success; git diff --check passed; mutation testing is unavailable because no mutation configuration/script exists; TypeScript compiler binary is unavailable in node_modules."
files_changed:
  - "scripts/certify-release.ts"
  - "tests/release/certify-release.test.ts"
  - "tests/release/controller.test.ts"
oracle_type: "specified"
