---
status: awaiting_human_verify
trigger: "Phase 7 setup must be controller-owned, but release:certify is hard-wired to dry-run and cannot discover provider-native authentication."
created: 2026-08-06T13:30:00Z
updated: 2026-08-06T13:18:00Z
---

# Debug Session: Release certifier live path

## Symptoms

- **Expected:** `release:certify` discovers provider-native authenticated account scopes without exposing credentials, stops for one exact cost/effect approval, and then resumes the same authorized controller run through Plan 07-26.
- **Actual:** `scripts/certify-release.ts` always calls `runReleaseCertification(... dryRun: true)` and constructs no authenticated provider registry, so all sixteen capabilities remain unavailable and the non-dry-run command cannot advance.
- **Errors:** The dry run remains `authorization_required` with `CREDENTIALS_UNAVAILABLE` for every provider; the absence of provider ports is reported as user setup despite no usable setup interface.
- **Timeline:** Discovered after Plan 07-25 completed its candidate-only local orchestration and the first real Plan 07-20 authentication attempt began.
- **Reproduction:** Run `bun run release:certify -- --candidate toolchains/candidates/initial.json` with or without provider CLI sessions; output remains the same dry-run authorization boundary.

## Current Focus

- **bug_class:** bohrbug — the same `release:certify` invocation deterministically enters dry-run and reports every provider unavailable.
- **hypothesis:** Plan 07-25 shipped its intentional candidate-only stub as the product command: the script always supplies `dryRun: true` and no native registry, while discovery schemas/registry cannot retain the three permitted redacted values. Thus installed authenticated CLIs cannot affect authorization discovery, and the command cannot even honestly report that the remaining live provider families are unimplemented.
- **test:** Add agent-authored, local tests that prove an authorized native probe preserves only SHA-256/reference metadata, changed discovery metadata regenerates the pending request without manual workspace deletion, and a non-dry-run request fails closed before any mutation when the complete live executor is absent.
- **expecting:** The tests fail before implementation: the generic factory is absent, discovery metadata is replaced, stale `authorization_required` state is reused unchanged, and the entrypoint cannot distinguish its preflight from an actual live path.
- **next_action:** Await confirmation that the already-run read-only product dry run is the desired controller-owned authorization boundary. Do not invoke a non-dry-run provider mutation: every complete live executor remains deliberately unimplemented and fails closed.
- **known_pattern_candidate:** none — semantic recall unavailable; keyword fallback found no two-token match in the knowledge base.
- **reasoning_checkpoint:**
  **hypothesis:** "The product command cannot observe native authentication because it always invokes the controller's dry-run-only API with the no-credential default registry; when an authorized registry is used separately, its discovery layer replaces the allowed redacted metadata with constants."
  **confirming_evidence:**
    - "`scripts/certify-release.ts` calls `runReleaseCertification({ candidatePath, workspace, dryRun: true })` on every non-status invocation and does not construct provider ports."
    - "`runReleaseCertification` accepts only `{ dryRun: true }` and `certify()` calls `dryRun()` before returning `authorization_required`."
    - "`src/release/providers.ts` sets `accountScopeSha256`/`costEstimateSha256` to all-zero values and `secretReferenceNames` to `[]` after parsing native outputs."
    - "All 16 existing release tests pass because they assert the intentional candidate-only boundary rather than native discovery composition."
  **falsification_test:** "A pre-fix injected native probe must result in its non-zero scope/cost hashes and reference name in the controller request; a non-dry-run CLI must have an authorization-gated executor path. Either observation would refute the claimed missing composition."
  **fix_rationale:** "A controller-owned, provider-neutral read-only CLI probe registry gives the existing no-effect dry-run the authenticated, redacted facts it needs to create the exact authorization request. It may compose approved gcloud, Modal, and Fly probes while leaving all other provider families explicit and unavailable. An explicit fail-closed live-executor boundary prevents the CLI from representing this preflight as a complete live deployment until every provider family has an authorization-gated mutation port."
  **blind_spots:** "Actual pending provider callbacks and all provider-specific login command behavior remain untested by design; tests must inject finite command output and no production CLI will run during debugging."
  **candidate_causes:**
    - "code: `runReleaseCertification` and the script statically restrict execution to the candidate-only dry-run branch."
    - "code: `ReleaseProviderRegistry.discover()` discards redacted native discovery metadata."
    - "config: no controller-owned mapping exists from approved provider CLIs to the discovery registry, so login state is never read."
    - "environment: provider sessions may be pending or absent, but this cannot cause the observed hard-wired dry-run because the current code never probes them."
  **and_gate:** "yes — reaching the requested authorization checkpoint requires both an injected read-only native discovery registry and preservation of its redacted metadata; the absence of either leaves scope/cost/reference facts unusable. Full mutation remains a separate fail-closed capability gap."

## Evidence

- **timestamp:** 2026-08-06T12:29:23Z
  **checked:** Debug knowledge base and semantic-recall capability.
  **found:** The only resolved session concerns OpenTelemetry approval-digest drift; it has no two-token overlap with provider authentication, certification CLI composition, or dry-run behavior. No MemPalace CLI/MCP result was available in this debugger context, so keyword fallback was used.
  **implication:** There is no known prior resolution to assume; investigate the current CLI composition directly.

- **timestamp:** 2026-08-06T12:29:23Z
  **checked:** Persisted symptom reproduction and supplied live-setup evidence.
  **found:** The reported invocation deterministically stays at `authorization_required`; authenticated provider CLIs are present, but provider login callbacks remain pending and must not be inspected or mutated. Any implementation must retain only hashed account scopes, cost-estimate digests, and secret-reference names.
  **implication:** This is a deterministic product-composition failure (Bohrbug), not a credential or provider-login incident; regression tests must prove redaction and authorization gating.

- **timestamp:** 2026-08-06T12:31:00Z
  **checked:** Codebase knowledge graph for certification composition.
  **found:** The graph locates the central controller (`src/release/controller.ts`), provider registry (`src/release/providers.ts`), contracts (`src/release/contracts.ts`), and a `runReleaseCertification` call path, confirming the symptom is in the release composition layer rather than the provider CLIs.
  **implication:** Inspect the entry script and these complete modules before making any change; provider-session probing is neither needed nor authorized to establish the code-path defect.

- **timestamp:** 2026-08-06T12:33:00Z
  **checked:** Graph trace from `runReleaseCertification` through the controller and provider registry.
  **found:** `runReleaseCertification` accepts only `{ dryRun: true }` and calls `certify()`, whose own comment and implementation call `dryRun()` then stop at `authorization_required`. `ReleaseProviderRegistry.discover()` parses native capability/authentication but writes literal zero digests and `[]` for all redacted discovery metadata.
  **implication:** Two code defects jointly prevent a safe live path: no live dispatch is reachable and valid provider discovery evidence is erased. The required fix must address both without adding an unauthorised mutation path.

- **timestamp:** 2026-08-06T12:36:00Z
  **checked:** Plan 07-25/07-26 contract and complete release entry/controller/provider sources.
  **found:** Plan 07-26 is explicitly run-only and says a discovered runtime defect requires a separate atomic fix that preserves the gate. The shipped 07-25 script accepts no authorization-receipt input, constructs `ReleaseCertificationController` without a provider registry, and passes literal `dryRun: true`; the supplied provider registry owns all sixteen provider IDs but discards the three allowed redacted discovery fields. The existing local tests deliberately assert the prior candidate-only boundary.
  **implication:** A narrow production fix is required before any live run: provider-native read-only discovery must be composed by the product command; non-dry-run execution must remain unreachable without a validated exact receipt; any unimplemented provider family must be visible and fail closed.

- **timestamp:** 2026-08-06T12:40:00Z
  **checked:** Local release/controller/provider-discovery suite (`bun test tests/release/certify-release.test.ts tests/release/controller.test.ts tests/release/provider-discovery.test.ts`).
  **found:** All 16 tests pass. There is no failing test for spectrum-based fault localization, so SBFL is skipped. Git history shows the current behavior was introduced deliberately as the Plan 07-25 candidate-only contract, so there is no prior product live implementation to bisect.
  **implication:** The test suite confirms a coverage gap rather than contradicting the diagnosis. Use specified-contract regression tests (not an implicit no-crash oracle); no input shrinker is applicable because the defect is fixed control-flow composition, not an input-space class.

- **timestamp:** 2026-08-06T12:42:00Z
  **checked:** Updated architecture/provider constraint from the coordinating agent.
  **found:** Google Cloud (including Cloud Run/GCS/gcloud) and CockroachDB/ccloud are excluded. Modal and Fly remain allowed. No cloud-specific code or probes have been made in this session.
  **implication:** The fix is restricted to provider-neutral composition plus Modal/Fly descriptors; every other currently declared provider family remains explicitly unimplemented and fail-closed pending the architecture repair.

- **timestamp:** 2026-08-06T12:44:00Z
  **checked:** Latest coordinating-agent scope update.
  **found:** Google Cloud is restored as an approved discovery-only exception for gcloud/Cloud Run/GCS/Collector. CockroachDB/ccloud remains excluded. The coordinating agent owns architecture, provider-ID, and plan repair.
  **implication:** The narrow fix may include static gcloud, Modal, and Fly read-only probe descriptors but will not touch provider IDs, topology, plans, Cockroach/ccloud, or provider mutation code.

- **timestamp:** 2026-08-06T12:47:00Z
  **checked:** Coordinating-agent architecture correction.
  **found:** The current `cockroach_postgres` provider identifier must be replaced with `cloud_sql_postgres`; Cloud SQL is an approved gcloud discovery-only target, while CockroachDB/ccloud remains excluded. The requested rename is limited to release contracts/topology/effect ownership/tests.
  **implication:** Fold the small identifier correction into this atomic fix, preserve the no-mutation boundary, and do not modify provider plans or introduce ccloud probing.

- **timestamp:** 2026-08-06T12:50:00Z
  **checked:** Redacted active-setup discovery context and controller dry-run resume logic.
  **found:** Approved gcloud authentication and a redacted account-scope digest are available, but the default workspace contains an older all-unavailable request. `dryRun()` calls `status()` and returns an existing matching candidate/topology/effect request before it discovers providers, so an authenticated scope change cannot update the current request without manual deletion.
  **implication:** The fix must re-run read-only discovery before accepting an existing pending request, retain it only when its canonical capability inventory matches, and otherwise atomically write a new discovery/request/state chain and update the controller pointer. It must never display or hardcode the actual account/project identity.

- **timestamp:** 2026-08-06T12:54:00Z
  **checked:** First execution of the new focused regression suite.
  **found:** Native metadata preservation passes. Remaining failures identify three implementation details: `AVAILABLE` is not an allowed controller capability reason, the old workspace's state cannot parse after the approved provider-ID migration, and non-dry-run correctly stops first for a missing authorization digest. Cloud SQL is now an approved gcloud probe, so its old test expectation of unsupported is invalid.
  **implication:** These are direct implementation/test alignment findings, not a changed root cause. Correct the controller schema/default generation and retain the strict order: exact digest required before the explicit unavailable-live-executor failure.

- **timestamp:** 2026-08-06T13:00:00Z
  **checked:** Review of the approved gcloud discovery design.
  **found:** Hashing an active account alone permits selected-project drift to retain the wrong authorization scope, and a configured CLI does not prove Application Default Credentials remain usable. The initial Modal/Fly scope is insufficient for gcloud's project-bound effect plan.
  **implication:** The gcloud command must validate ADC by discarding the access-token output, and it must hash account-plus-selected-project inside the shell before outputting only a digest. Regression coverage must treat a changed scope digest or unavailable ADC as a new authorization request, never as a resumable prior request.

- **timestamp:** 2026-08-06T13:03:00Z
  **checked:** Focused release regression suite and TypeScript diagnostics scoped to the changed release files.
  **found:** All 21 focused tests pass, including valid `AVAILABLE` observations, finite metadata preservation, gcloud account-plus-project/ADC command shape, stale-scope regeneration, revoked-ADC regeneration, and explicit unavailable-live-executor failure. `tsc --noEmit` reports no diagnostics in the changed release files; its nonzero exit is due to pre-existing errors elsewhere in the repository.
  **implication:** The root-cause behavior is covered by specified-contract tests. Continue with full adjacent test coverage and the fix-acceptance guardrail; no live credential or provider mutation test is needed or authorized.

- **timestamp:** 2026-08-06T13:05:00Z
  **checked:** Full local test suite (`bun test`).
  **found:** 554 tests across 89 files passed with zero failures. The new `AVAILABLE` capability reason and Cloud SQL provider-ID correction did not break adjacent certification, promotion, or release behavior.
  **implication:** Adjacent-test guardrail signal is currently passing. Next validate that the focused regression test genuinely detects removal of this fix and inspect the diff for behavior-deleting changes.

- **timestamp:** 2026-08-06T13:08:00Z
  **checked:** Redacted observation from the product's read-only Fly CLI probe.
  **found:** `flyctl auth whoami` succeeds under the user's normal environment but returns `not_configured` from the native factory because its child process receives only `PATH`, omitting `HOME` and other approved CLI configuration locators. No credential value was exposed.
  **implication:** Pass only non-secret locator variables (`PATH`, `HOME`, optional config-directory/profile locators) into probe children; explicitly omit all token and credential variables. This preserves read-only authentication discovery without broad environment inheritance.

- **timestamp:** 2026-08-06T13:11:00Z
  **checked:** Focused release suite after locator-environment correction and the authorized read-only `release:certify -- --dry-run` command.
  **found:** All 22 focused tests pass. The product dry-run regenerated the controller-owned pending request and exited nonzero at `authorization_required` as intended; its public output contained only controller/request digests, not account/project IDs, token values, or provider command output.
  **implication:** Native discovery is now active on the product preflight while live mutation remains blocked. Read a sanitized status projection to validate discovery outcomes, then finish the guardrail without further provider interaction.

- **timestamp:** 2026-08-06T13:12:00Z
  **checked:** Sanitized capability projection from the regenerated controller state.
  **found:** Cloud Run, GCS, Collector, Cloud SQL, Modal, and Fly each report `available` + `authorized` with non-zero scope/cost digests and one redacted reference name. No raw account, project, token, or reference value was read or printed.
  **implication:** The read-only product composition discovers the approved configured families correctly. The other provider families remain explicit unsupported facts, so the non-dry-run path must continue to fail closed.

- **timestamp:** 2026-08-06T13:16:00Z
  **checked:** Fix-acceptance revert-and-reconfirm experiment.
  **found:** After stashing only the six production paths for this fix, the 22-test focused suite failed as predicted: the native discovery module was absent, provider metadata was zeroed/unavailable, changed scope reuse was not invalidated, and non-dry-run was still indistinguishable from the old dry-run path. Restoring exactly those source paths made all 22 focused tests pass again.
  **implication:** The regression suite detects the actual changed production behavior rather than merely passing independently of this fix.

- **timestamp:** 2026-08-06T13:17:00Z
  **checked:** Full local suite and static release-diff guards after source restoration.
  **found:** `bun test` passes 555 tests across 89 files with zero failures. `git diff --check` is clean. No `cockroach_postgres` or `ccloud` identifier occurs in the changed release source/tests. No Stryker or other mutation-test configuration exists in the repository, so mutation analysis is unavailable rather than passing by inference.
  **implication:** The fix-acceptance guardrail accepts the target/adjacent/revert/no-op signals; mutation is an explicitly documented non-applicable gap. The supported product path remains a no-effect authorization preflight.

## Eliminated

## Resolution

- **root_cause:** Plan 07-25's candidate-only implementation was exposed as the product release command: it hard-wires `dryRun: true` with no native discovery registry, and the separate authorized registry overwrites the only permitted redacted discovery metadata. Therefore provider authentication cannot influence the request and no complete live executor is represented honestly.
- **fix:** Compose a controller-owned, read-only native discovery registry for approved gcloud, Modal, and Fly CLIs; preserve only validated scope/cost digests and reference names; bind gcloud scope to selected account plus project and require usable ADC without admitting the token. Rediscover before reusing a pending request and regenerate it when capability facts change. Permit the normal CLI to use this preflight, while a non-dry-run call first requires a syntactically valid authorization receipt and then explicitly fails with `RELEASE_LIVE_PROVIDER_FAMILY_UNIMPLEMENTED` before any provider command.
- **verification:**
  - target_regression: `bun test tests/release/native-discovery.test.ts tests/release/provider-discovery.test.ts tests/release/controller.test.ts tests/release/certify-release.test.ts` — 22 passed, 0 failed
  - adjacent_regression: `bun test` — 555 passed across 89 files, 0 failed
  - production_preflight: authorized read-only `release:certify -- --dry-run` regenerated `authorization_required` state with six approved families available/authorized; public output and inspected projection contained only redacted digest/reference facts
  - no_op_or_deletion: passed — the diff adds native composition, metadata propagation, scope-change invalidation, and explicit live fail-closed behavior; `git diff --check` clean
  - revert_and_reconfirm: passed — focused tests failed with production source stashed and passed immediately after restoring it
  - mutation: skipped — no mutation-test tool/configuration is present
  - typecheck: changed release files have no diagnostics; broad `bunx tsc --noEmit` remains nonzero due to unrelated pre-existing diagnostics
  - guardrail_verdict: accepted
- **files_changed:**
  - scripts/certify-release.ts
  - src/release/contracts.ts
  - src/release/controller.ts
  - src/release/native-discovery.ts
  - src/release/providers.ts
  - src/release/topology.ts
  - tests/release/certify-release.test.ts
  - tests/release/controller.test.ts
  - tests/release/native-discovery.test.ts
  - tests/release/provider-discovery.test.ts
- **oracle_type:** specified — Plan 07-20/07-26 and the supplied acceptance context require controller-owned, read-only native authentication discovery with preserved hashes/reference names and an explicit pre-authorization/live-executor boundary.
